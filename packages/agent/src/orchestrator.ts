import { AwaError, isAwaError, type TenantConfig } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import { approvedFigures, evaluateEscalation, type MeteringService } from '@detent/awa-policy';
import { detectInjectionDeep, type InjectionClassifier } from '@detent/awa-knowledge';
import {
  buildSystemPrompt, supportsStreaming,
  type ModelProvider, type ModelTurnOutput, type ProposedToolCall, type TurnChunk,
} from './model.js';
import { buildToolCatalogue, type ToolDefinition } from './tools.js';
import { BLOCKED_OUTPUT_REPLACEMENT, validateOutput } from './output-validation.js';
import type { Session, SessionManager } from './session.js';
import type { ToolExecutor } from './tool-executor.js';

/**
 * The turn orchestrator.
 *
 * Implements the execution pipeline from section 13.1 exactly, in order, with
 * no fast path:
 *
 *   1 ingest → 2 retrieve → 3 reason → 4 validate → 5 policy → 6 authorise
 *   → 7 execute → 8 audit → 9 validate output → 10 emit
 *
 * Steps 4 to 8 live in the ToolExecutor because they run per tool call; this
 * class owns the turn as a whole, including the two things that must happen
 * whatever the model does: the Article 50 disclosure on the first turn, and
 * output validation before anything reaches the visitor.
 */
export interface TurnInput {
  readonly session: Session;
  readonly config: TenantConfig;
  readonly visitorInput: string;
}

/**
 * What the visitor can do next (audit UX-7).
 *
 * An escalation used to return a sentence and nothing else — no confirmation
 * that a human had actually been notified, no expected response time, no
 * in-panel booking fallback, no way to leave an email if nobody was available.
 * The turn now returns a structured action the panel renders as a card, so the
 * handoff has a visible state rather than being a dead end.
 */
export type NextAction =
  | { readonly kind: 'none' }
  | { readonly kind: 'booking_link'; readonly url: string; readonly label: string }
  | { readonly kind: 'await_human'; readonly promise?: string; readonly notified: boolean }
  | { readonly kind: 'leave_details'; readonly prompt: string };

export interface TurnResult {
  readonly text: string;
  readonly disclosure?: string;
  readonly toolsExecuted: readonly string[];
  readonly toolsDenied: readonly { tool: string; reason: string }[];
  readonly escalated: boolean;
  readonly outputViolations: readonly string[];
  readonly injectionDetected: boolean;
  readonly correlationId: string;
  readonly nextAction: NextAction;
  /** Degraded because the tenant's spend cap was reached (audit SEC-2). */
  readonly degraded?: 'spend_cap' | 'conversation_quota' | 'voice_concurrency';
}

export interface OrchestratorDeps {
  readonly model: ModelProvider;
  readonly executor: ToolExecutor;
  readonly sessions: SessionManager;
  readonly audit: AuditLog;
  readonly metering: MeteringService;
  /** Longest visitor message accepted before it reaches the tokeniser. */
  readonly maxInputChars?: number;
  /** Second-stage injection classifier (audit SEC-9). Optional by design. */
  readonly injectionClassifier?: InjectionClassifier;
}

const DEFAULT_MAX_INPUT_CHARS = 4_000;

const HUMAN_REQUEST = /\b(speak|talk|put me through|connect me|get me)\s+(to|with)?\s*(a|an|someone|somebody)?\s*(human|person|real person|agent|advisor|adviser|consultant|sales ?rep|someone)\b|\bhuman please\b/i;

export class TurnOrchestrator {
  constructor(private readonly deps: OrchestratorDeps) {}

  async run(input: TurnInput): Promise<TurnResult> {
    return this.execute(input);
  }

  /**
   * Streamed turn (audit UX-2).
   *
   * Sentences are emitted as the model produces them, each one validated before
   * it leaves — the same validator, run per sentence. The final `TurnResult` is
   * the generator's return value, so a caller that ignores the chunks gets
   * exactly the behaviour of `run()`.
   */
  async *runStreaming(input: TurnInput): AsyncGenerator<TurnChunk, TurnResult, void> {
    const chunks: TurnChunk[] = [];
    let emitted = 0;
    const result = await this.execute(input, (chunk) => { chunks.push(chunk); });
    // The executor collects chunks synchronously; replay them in order and then
    // return the complete result.
    for (; emitted < chunks.length; emitted += 1) yield chunks[emitted]!;
    return result;
  }

  private async execute(input: TurnInput, onChunk?: (chunk: TurnChunk) => void): Promise<TurnResult> {
    const { session, config } = input;
    const catalogue = buildToolCatalogue(config.serviceCatalogue);

    // --- Input length cap, before the tokeniser (audit SEC-2d). A megabyte of
    // text must not become a megabyte of tokens on the tenant's account.
    const maxChars = this.deps.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    const visitorInput = input.visitorInput.length > maxChars
      ? input.visitorInput.slice(0, maxChars)
      : input.visitorInput;

    // --- Step 1: ingest. Visitor input is untrusted from here to the end.
    this.deps.sessions.record(session, 'visitor', visitorInput);
    if (session.state === 'Anonymous') this.deps.sessions.transition(session, 'Engaged');

    const injection = await detectInjectionDeep(visitorInput, this.deps.injectionClassifier);
    if (injection.detected) {
      // An injection attempt is a security event, not a conversation topic. It
      // is logged and refused; it is never argued with.
      await this.deps.audit.write({
        tenantId: session.tenantId, type: 'injection_detected',
        correlationId: session.correlationId, sessionId: session.id, actor: 'visitor',
        payload: { matches: injection.matches },
      });
    }

    if (HUMAN_REQUEST.test(visitorInput)) session.humanRequested = true;

    // --- The Article 50 disclosure. Shown on the first turn of every session,
    // in the surface itself, and not disableable by a tenant.
    const disclosure = session.disclosureShown ? undefined : await this.showDisclosure(session, config);

    // --- Kill switch, evaluated before the model is called at all.
    if (config.killSwitch === 'BOOKING_LINK_ONLY') {
      return this.degraded(session, config, disclosure, catalogue);
    }

    // --- Spend cap, evaluated before the model is called (audit SEC-2a).
    //
    // The cap used to be checked only inside `PolicyEngine.decide`, which runs
    // per tool call — but the model call happened first and unconditionally,
    // and the tokens were then recorded. The one path that reached the model
    // was the one path that did not check the cap, which is precisely the
    // "denial of wallet" the metering module names in its own header comment.
    const meterVerdict = await this.deps.metering.check(session.tenantId, config.spendCaps);
    if (meterVerdict.state === 'BLOCKED') {
      await this.deps.audit.write({
        tenantId: session.tenantId,
        type: meterVerdict.reason === 'spend_cap' ? 'spend_cap_reached' : 'quota_exceeded',
        correlationId: session.correlationId, sessionId: session.id, actor: 'policy',
        payload: { reason: meterVerdict.reason, stage: 'pre_model' },
        versions: session.versions,
      });
      return this.degraded(session, config, disclosure, catalogue, meterVerdict.reason);
    }

    // --- Steps 2 and 3. Retrieval runs as a tool so it passes the same gate as
    // everything else; the model decides what to look up.
    const modelInput = {
      systemPrompt: buildSystemPrompt(config),
      history: session.history,
      visitorInput,
      tools: catalogue,
      config,
    };

    // Sentences streamed to the caller are validated one at a time before they
    // are handed over. Governance is preserved; perceived latency is not.
    const streamed: string[] = [];
    let output: ModelTurnOutput;
    try {
      if (onChunk && supportsStreaming(this.deps.model)) {
        const stream = this.deps.model.stream(modelInput);
        let next = await stream.next();
        while (!next.done) {
          const sentence = next.value.text;
          const perSentence = validateOutput({
            text: sentence, config, approvedFigures: approvedFigures(config), retrievedText: '',
          });
          if (perSentence.allowed) {
            streamed.push(perSentence.text);
            onChunk({ type: 'sentence', text: perSentence.text });
          }
          next = await stream.next();
        }
        output = next.value;
      } else {
        output = await this.deps.model.turn(modelInput);
      }
    } catch (cause) {
      // Degrade, never fail (section 8.1).
      await this.deps.audit.write({
        tenantId: session.tenantId, type: 'tool_call_failed',
        correlationId: session.correlationId, sessionId: session.id, actor: 'system',
        payload: { stage: 'model', message: String(cause) },
      });
      return {
        text: 'I am having trouble at my end. Rather than keep you waiting, let me get someone from the team to pick this up.',
        disclosure,
        toolsExecuted: [], toolsDenied: [], escalated: true,
        outputViolations: [], injectionDetected: injection.detected,
        correlationId: session.correlationId,
        nextAction: this.handoffAction(config, false),
      };
    }

    await this.deps.metering.record(session.tenantId, 'llm_token', output.tokensUsed);
    await this.deps.metering.record(session.tenantId, 'text_message', 1);

    session.consecutiveNegativeTurns = output.sentiment === 'negative' ? session.consecutiveNegativeTurns + 1 : 0;

    // --- Steps 4 to 8, per proposed tool call.
    const executed: string[] = [];
    const denied: { tool: string; reason: string }[] = [];
    let retrievedText = '';

    for (const call of output.toolCalls) {
      try {
        const result = await this.deps.executor.execute(session, config, catalogue, call as ProposedToolCall);
        executed.push(call.tool);
        const text = result.internal?.['retrievedText'];
        if (typeof text === 'string') retrievedText += ` ${text}`;
      } catch (cause) {
        const error = isAwaError(cause) ? cause : new AwaError({ kind: 'INTERNAL', message: String(cause), cause });
        denied.push({ tool: call.tool, reason: error.kind });
      }
    }

    // --- Escalation. The model recognises the signal; the platform decides.
    const escalation = evaluateEscalation(config.escalation, {
      modelConfidence: output.confidence,
      factualQuestion: /\?$/.test(visitorInput.trim()),
      consecutiveNegativeTurns: session.consecutiveNegativeTurns,
      detectedTopics: output.detectedTopics,
      classification: session.classification,
      visitorAskedForHuman: session.humanRequested,
      securityClassifierFired: injection.detected,
    });

    if (escalation.escalate && !executed.includes('escalate_to_human')) {
      try {
        await this.deps.executor.execute(session, config, catalogue, {
          tool: 'escalate_to_human',
          args: { reason: escalation.triggers[0] ?? 'low_confidence', summary: summarise(session) },
        });
        executed.push('escalate_to_human');
      } catch {
        // Escalation is never blocked by policy, but a store failure must not
        // take the conversation down with it.
      }
    }

    // --- Step 9: output validation before anything reaches the visitor.
    //
    // Ordering matters here. An injection attempt suppresses the model's text
    // unconditionally, before validation and independently of whether the turn
    // also escalated: refuse, log, continue. An earlier version applied this
    // only when the turn had not escalated, which meant an injection that also
    // tripped the security escalation trigger let the model's own text through.
    let text: string;
    if (injection.detected) {
      text = 'I can only help with questions about what we do. What are you looking for?';
    } else if (escalation.answerSuppressed) {
      text = 'I would rather not answer that from guesswork. Let me get someone who can answer it properly.';
    } else {
      text = output.text;
    }

    const verdict = validateOutput({
      text,
      config,
      approvedFigures: approvedFigures(config),
      retrievedText,
    });

    if (!verdict.allowed) {
      await this.deps.audit.write({
        tenantId: session.tenantId, type: 'output_blocked',
        correlationId: session.correlationId, sessionId: session.id, actor: 'policy',
        payload: { violations: verdict.violations, notes: verdict.notes },
        versions: session.versions,
      });
      text = BLOCKED_OUTPUT_REPLACEMENT;
    } else {
      text = verdict.text;
    }

    // --- Step 10: emit.
    this.deps.sessions.record(session, 'assistant', text);
    if (session.state === 'Engaged' || session.state === 'NonResolving' || session.state === 'Resolving') {
      this.advance(session);
    }

    return {
      text,
      disclosure,
      toolsExecuted: executed,
      toolsDenied: denied,
      escalated: escalation.escalate,
      outputViolations: verdict.violations,
      injectionDetected: injection.detected,
      correlationId: session.correlationId,
      nextAction: escalation.escalate
        ? this.handoffAction(config, executed.includes('escalate_to_human'))
        : { kind: 'none' },
    };
  }

  /**
   * What the visitor is offered when a human is raised (audit UX-7).
   *
   * The ladder is deliberate: a booking link is the strongest outcome because
   * it converts without anyone being available; waiting for a named human is
   * next, and only says "notified" when the escalation tool actually ran;
   * leaving details is the floor, and is offered rather than assumed.
   */
  private handoffAction(config: TenantConfig, notified: boolean): NextAction {
    if (config.bookingLinkUrl) {
      return { kind: 'booking_link', url: config.bookingLinkUrl, label: 'Book a time with the team' };
    }
    if (notified || config.escalation.humanResponsePromise) {
      return {
        kind: 'await_human',
        promise: config.escalation.humanResponsePromise,
        notified,
      };
    }
    if (config.escalation.offerLeaveDetails !== false) {
      return {
        kind: 'leave_details',
        prompt: 'Nobody is available right now. Leave an email address and the team will come back to you.',
      };
    }
    return { kind: 'none' };
  }

  private async showDisclosure(session: Session, config: TenantConfig): Promise<string> {
    const text = session.modality === 'voice' ? config.disclosure.voiceText : config.disclosure.text;
    session.disclosureShown = true;
    await this.deps.audit.write({
      tenantId: session.tenantId, type: 'disclosure_shown',
      correlationId: session.correlationId, sessionId: session.id, actor: 'system',
      payload: { modality: session.modality, wording: text },
      versions: session.versions,
    });
    return text;
  }

  /**
   * Booking-link-only mode, and the spend-cap degradation that reuses it.
   * Honest about the limitation; still useful. A visitor who arrives after a
   * tenant's cap is reached is given a route on, not an error.
   */
  private async degraded(
    session: Session,
    config: TenantConfig,
    disclosure: string | undefined,
    catalogue: readonly ToolDefinition[],
    reason?: 'spend_cap' | 'conversation_quota' | 'voice_concurrency',
  ): Promise<TurnResult> {
    if (!reason) {
      await this.deps.audit.write({
        tenantId: session.tenantId, type: 'kill_switch_engaged',
        correlationId: session.correlationId, sessionId: session.id, actor: 'system',
        payload: { mode: config.killSwitch },
      });
    }
    void catalogue;
    const link = config.bookingLinkUrl ? ` You can book a time here: ${config.bookingLinkUrl}` : '';
    return {
      text: `I am not able to chat properly right now.${link} Someone from the team will be able to help.`,
      disclosure,
      toolsExecuted: [], toolsDenied: [], escalated: false,
      outputViolations: [], injectionDetected: false,
      correlationId: session.correlationId,
      nextAction: this.handoffAction(config, false),
      degraded: reason,
    };
  }

  private advance(session: Session): void {
    if (session.state === 'Engaged') {
      // Consent state decides the branch. NonResolving is a full path, not a
      // penalty: it qualifies and books without touching a CRM.
      this.deps.sessions.transition(session, session.classification ? 'Consented' : 'NonResolving');
    }
    if (session.state === 'Consented') this.deps.sessions.transition(session, 'Resolving');
    if (session.state === 'Resolving' || session.state === 'NonResolving') {
      this.deps.sessions.transition(session, 'Qualifying');
    }
  }
}

function summarise(session: Session): string {
  const captured = Object.entries(session.qualification.captured)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join('; ');
  return `Conversation ${session.id}. Captured: ${captured || 'nothing yet'}. Turns: ${session.history.length}.`;
}
