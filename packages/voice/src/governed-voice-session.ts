import type { AuditLog } from '@detent/awa-audit';
import { type Clock, type TenantConfig, systemClock } from '@detent/awa-core';
import type { MeteringService } from '@detent/awa-policy';
import type { Session, TurnOrchestrator } from '@detent/awa-agent';
import {
  assertGoverned, type RealtimeSessionConfig, type VoiceEvent, type VoiceProvider,
  type VoiceSession,
} from './voice-provider.js';

/**
 * The governed voice session.
 *
 * This is the whole argument for how Detent does voice, and it is one rule:
 *
 *   **Every word spoken to a caller has been through the same ten-step pipeline
 *   as every word typed to a visitor.**
 *
 * A speech-to-speech model answering directly is faster and feels better. It is
 * also ungovernable: output validation, injection suppression, grounding checks,
 * the permitted-behaviours gate and the source-of-truth rules all operate in the
 * gap between a proposed answer and a delivered one, and speech-to-speech
 * removes the gap. A regulated buyer cannot accept that, and the audit trail
 * they need cannot be produced after the fact.
 *
 * So the provider is used as three things: a microphone, a transcriber and a
 * mouth, and never as a brain. It is configured with automatic responses
 * disabled, and `assertGoverned` refuses to open a session otherwise.
 *
 * The cost is latency: a turn goes caller → transcript → pipeline → speech
 * rather than caller → speech. That is a real product cost and it is the right
 * trade, because it is the only version of voice that can be sold to someone
 * with a compliance function.
 */

export interface VoiceTurnRecord {
  readonly at: string;
  readonly caller: string;
  readonly spoken: string;
  readonly correlationId: string;
  readonly injectionDetected: boolean;
  readonly outputViolations: readonly string[];
  readonly escalated: boolean;
  readonly latencyMs: number;
}

export interface GovernedVoiceDeps {
  readonly provider: VoiceProvider;
  readonly orchestrator: TurnOrchestrator;
  readonly audit: AuditLog;
  readonly metering: MeteringService;
  readonly clock?: Clock;
}

export interface StartVoiceInput {
  readonly session: Session;
  readonly config: TenantConfig;
  readonly realtime: RealtimeSessionConfig;
}

export class GovernedVoiceSession {
  private voice?: VoiceSession;
  private speaking = false;
  private turnInFlight = false;
  /** Utterances that arrived while a turn was running. Answered in order. */
  private readonly queue: string[] = [];
  private readonly turns: VoiceTurnRecord[] = [];
  private audioMsSinceLastMeter = 0;
  private startedAtMs = 0;
  private readonly clock: Clock;

  constructor(private readonly deps: GovernedVoiceDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  get transcript(): readonly VoiceTurnRecord[] {
    return this.turns;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /**
   * Opens the provider session and speaks the disclosure before anything else.
   *
   * Article 50 disclosure is spoken first, always, and cannot be disabled or
   * deferred. On a phone call there is no banner to read, so the first thing
   * the caller hears is what they are talking to. Doing this after a greeting,
   * or only on request, is not disclosure.
   */
  async start(input: StartVoiceInput): Promise<void> {
    assertGoverned(input.realtime);
    this.startedAtMs = this.clock.nowMs();

    this.voice = await this.deps.provider.open(input.realtime, (event) =>
      this.onProviderEvent(event, input));

    await this.deps.audit.write({
      tenantId: input.session.tenantId,
      type: 'voice_session_opened',
      correlationId: input.session.correlationId,
      sessionId: input.session.id,
      actor: 'system',
      payload: {
        provider: this.deps.provider.name,
        // Recorded so an auditor can see, per session, that the provider was
        // never permitted to answer for itself.
        autoRespond: input.realtime.autoRespond,
        voice: input.realtime.voice,
      },
    });

    const disclosure = input.config.disclosure.voiceText;
    input.session.disclosureShown = true;
    await this.deps.audit.write({
      tenantId: input.session.tenantId,
      type: 'disclosure_shown',
      correlationId: input.session.correlationId,
      sessionId: input.session.id,
      actor: 'system',
      payload: { modality: 'voice', wording: disclosure },
    });
    await this.say(disclosure);
  }

  /** Caller audio in. Metered by wall-clock duration, not by byte count. */
  async pushAudio(chunk: Uint8Array, durationMs: number, session: Session): Promise<void> {
    if (!this.voice || this.voice.closed) return;
    await this.voice.sendAudio(chunk);

    // Metered a minute at a time. Metering per chunk would write thousands of
    // records an hour; metering only at the end loses the spend on a dropped
    // call, which is exactly when a cap matters.
    this.audioMsSinceLastMeter += durationMs;
    while (this.audioMsSinceLastMeter >= 60_000) {
      this.audioMsSinceLastMeter -= 60_000;
      await this.deps.metering.record(session.tenantId, 'voice_minute', 1);
    }
  }

  private async onProviderEvent(event: VoiceEvent, input: StartVoiceInput): Promise<void> {
    switch (event.type) {
      case 'speech_started':
        // Barge-in. If the caller starts talking while the assistant is
        // speaking, the assistant stops. Talking over someone is the single
        // most disliked behaviour of a phone bot, and it is also how a caller
        // misses a disclosure or a price correction.
        if (this.speaking) await this.stopSpeaking();
        break;

      case 'transcript':
        await this.handleUtterance(event.text, input);
        break;

      case 'transcript_failed':
        // A failed transcription is not an excuse to guess. Say so and invite
        // the caller to repeat, rather than answering a question we did not hear.
        await this.say('Sorry, I did not catch that. Could you say it again?');
        break;

      case 'audio_done':
        this.speaking = false;
        break;

      case 'error':
        await this.deps.audit.write({
          tenantId: input.session.tenantId,
          type: 'voice_provider_error',
          correlationId: input.session.correlationId,
          sessionId: input.session.id,
          actor: 'system',
          payload: { code: event.code, message: event.message },
        });
        break;

      default:
        break;
    }
  }

  /**
   * One caller utterance through the governed pipeline.
   *
   * Utterances that arrive mid-turn are queued rather than run concurrently:
   * two pipeline runs against one session race on state, and on a phone call
   * the visible symptom is the assistant answering the previous question.
   */
  private async handleUtterance(text: string, input: StartVoiceInput): Promise<void> {
    if (this.turnInFlight) {
      this.queue.push(text);
      return;
    }
    this.turnInFlight = true;
    try {
      let utterance: string | undefined = text;
      while (utterance !== undefined) {
        await this.runTurn(utterance, input);
        utterance = this.queue.shift();
      }
    } finally {
      this.turnInFlight = false;
    }
  }

  private async runTurn(utterance: string, input: StartVoiceInput): Promise<void> {
    const startedMs = this.clock.nowMs();

    // The transcript is untrusted input, exactly like typed text. It crosses the
    // same boundary and gets the same treatment: a caller can read a prompt
    // injection aloud just as easily as paste one.
    const result = await this.deps.orchestrator.run({
      session: input.session,
      config: input.config,
      visitorInput: utterance,
    });

    // Only the validated text is ever spoken. There is no path from a model to
    // the caller that does not pass through here.
    await this.say(result.text);

    this.turns.push({
      at: this.clock.iso(),
      caller: utterance,
      spoken: result.text,
      correlationId: result.correlationId,
      injectionDetected: result.injectionDetected,
      outputViolations: result.outputViolations,
      escalated: result.escalated,
      latencyMs: this.clock.nowMs() - startedMs,
    });
  }

  /** Speak approved text. The only route to the caller's ear. */
  private async say(text: string): Promise<void> {
    if (!this.voice || this.voice.closed || text.trim().length === 0) return;
    this.speaking = true;
    await this.voice.speak(text);
  }

  private async stopSpeaking(): Promise<void> {
    if (!this.voice || !this.speaking) return;
    await this.voice.cancelSpeech();
    this.speaking = false;
  }

  /** Ends the call and writes the session summary. */
  async end(session: Session, reason: string): Promise<void> {
    if (!this.voice) return;
    // Any part-minute at the end is charged as a whole minute, which is the
    // telephony convention and what the vendor charges us.
    if (this.audioMsSinceLastMeter > 0) {
      await this.deps.metering.record(session.tenantId, 'voice_minute', 1);
      this.audioMsSinceLastMeter = 0;
    }
    await this.voice.close(reason);
    await this.deps.audit.write({
      tenantId: session.tenantId,
      type: 'voice_session_closed',
      correlationId: session.correlationId,
      sessionId: session.id,
      actor: 'system',
      payload: {
        reason,
        turns: this.turns.length,
        durationMs: this.clock.nowMs() - this.startedAtMs,
        injectionsDetected: this.turns.filter((turn) => turn.injectionDetected).length,
        escalated: this.turns.some((turn) => turn.escalated),
      },
    });
  }

  /**
   * Median and worst turn latency.
   *
   * Reported because the governed design trades latency for auditability, and a
   * trade you do not measure is a trade you cannot defend. Above roughly 1.5
   * seconds a caller starts talking over the pause.
   */
  latency(): { readonly medianMs: number; readonly worstMs: number; readonly turns: number } {
    if (this.turns.length === 0) return { medianMs: 0, worstMs: 0, turns: 0 };
    const sorted = this.turns.map((turn) => turn.latencyMs).sort((a, b) => a - b);
    return {
      medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
      worstMs: sorted[sorted.length - 1] ?? 0,
      turns: this.turns.length,
    };
  }
}
