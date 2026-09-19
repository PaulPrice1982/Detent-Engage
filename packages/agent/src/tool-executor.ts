import {
  AwaError, FORBIDDEN_WRITE_FIELDS, idempotencyKey, validate,
  type CanonicalWriteEnvelope, type Clock, type TenantConfig, systemClock,
} from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import {
  evaluatePriceAuthority, approvedFigures,
  type ConsentService, type MeteringService, type PolicyEngine,
} from '@detent/awa-policy';
import type { CrmAdapter } from '@detent/awa-connectors';
import type { IdentityResolutionService } from '@detent/awa-identity';
import type { RetrievalService } from '@detent/awa-knowledge';
import { NO_KNOWLEDGE_RESPONSE, wrapAsData } from '@detent/awa-knowledge';
import { toolSchema, type ToolDefinition } from './tools.js';
import type { ProposedToolCall } from './model.js';
import type { Session, SessionManager } from './session.js';
import type { CalendarService, HandoffService, NotificationService } from './services.js';

/**
 * The tool execution service (pipeline steps 4 to 8, section 13.1).
 *
 * There is no fast path that skips validation. Every call runs: schema check,
 * policy gate, least-privilege execution, audit before and after. A tool that
 * throws produces a visitor-safe message and an audit entry, never a stack
 * trace on the page and never a silent no-op.
 */
export interface ToolExecutionResult {
  /** What may cross back into model context. Redacted by construction. */
  readonly modelVisible: Record<string, unknown>;
  /** Side effects the orchestrator must know about but the model must not see. */
  readonly internal?: Record<string, unknown>;
  readonly parked?: boolean;
}

/**
 * Outcome recording, behind a port.
 *
 * The agent package deliberately does not depend on the outcome service: the
 * assistant's job is to recognise which outcome a conversation reached, and
 * everything downstream of that — whether the outcome is enabled, whether it is
 * billable, whether it needs downstream confirmation — is the platform's
 * decision and lives outside this package.
 */
export interface OutcomeRecorder {
  record(input: {
    config: TenantConfig;
    conversationId: string;
    correlationId: string;
    outcome: string;
    person?: { email?: string };
    qualification?: { criteriaMet: readonly string[]; scoreBand: string };
  }): Promise<{ outcome: string; billable: boolean; state: string }>;
}

/**
 * Dry-run staging, behind a port (FR-036).
 *
 * In dry-run the writes are real: fully validated, fully policied, fully formed
 * canonical envelopes the adapter would have executed. They land in a staging
 * ledger so the tenant sees exactly what would happen to their CRM before
 * anything does.
 */
export interface WriteStager {
  stage(envelope: CanonicalWriteEnvelope): { id: string };
}

export interface ToolExecutorDeps {
  readonly policy: PolicyEngine;
  readonly consent: ConsentService;
  readonly metering: MeteringService;
  readonly audit: AuditLog;
  readonly adapter: CrmAdapter;
  readonly identity: IdentityResolutionService;
  readonly retrieval: RetrievalService;
  readonly calendar: CalendarService;
  readonly notifications: NotificationService;
  readonly handoff: HandoffService;
  readonly sessions: SessionManager;
  readonly outcomes?: OutcomeRecorder;
  readonly staging?: WriteStager;
  readonly clock?: Clock;
}

export class ToolExecutor {
  private readonly clock: Clock;

  constructor(private readonly deps: ToolExecutorDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  async execute(
    session: Session,
    config: TenantConfig,
    catalogue: readonly ToolDefinition[],
    call: ProposedToolCall,
  ): Promise<ToolExecutionResult> {
    // Step 4: typed schema validation. An unknown tool has no schema and is
    // refused before policy is even consulted.
    const schema = toolSchema(catalogue, call.tool);
    if (!schema) {
      await this.deps.audit.write({
        tenantId: session.tenantId, type: 'tool_call_rejected_schema',
        correlationId: session.correlationId, sessionId: session.id, actor: 'assistant',
        payload: { tool: call.tool, reason: 'unknown tool' },
      });
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: `unknown tool ${call.tool}` });
    }

    const outcome = validate(call.args, schema);
    if (!outcome.valid) {
      await this.deps.audit.write({
        tenantId: session.tenantId, type: 'tool_call_rejected_schema',
        correlationId: session.correlationId, sessionId: session.id, actor: 'assistant',
        payload: { tool: call.tool, issues: outcome.issues.map((i) => `${i.path}: ${i.message}`) },
      });
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: `${call.tool} failed schema validation`,
        details: { issues: outcome.issues },
      });
    }

    // Step 5: the deterministic policy gate.
    const decision = await this.deps.policy.evaluate({
      tenantConfig: config,
      tool: call.tool,
      args: call.args,
      correlationId: session.correlationId,
      sessionId: session.id,
      subjectRef: session.subjectRef,
      connectionState: await this.deps.adapter.connectionState(session.tenantId),
      humanRequested: session.humanRequested,
      mode: session.mode,
      modeForbiddenTools: session.modeForbiddenTools,
    });

    if (decision.effect === 'DENY') {
      throw new AwaError({
        kind: decision.reasons.some((r) => r.includes('consent')) ? 'CONSENT_REQUIRED' : 'POLICY_DENIED',
        message: `${call.tool} denied: ${decision.reasons.join('; ')}`,
        correlationId: session.correlationId,
        details: { obligations: decision.obligations },
      });
    }

    if (decision.effect === 'REQUIRE_HUMAN_APPROVAL') {
      // Not an error. The request is captured and a human decides.
      await this.deps.handoff.raise({
        tenantId: session.tenantId, sessionId: session.id, correlationId: session.correlationId,
        reason: `approval required for ${call.tool}`,
        transcript: session.history.map((m) => ({ role: m.role, text: m.text })),
        qualification: session.qualification.captured,
        classification: session.classification,
        ownerRef: session.ownerRef,
      });
      return { modelVisible: { status: 'awaiting_human_approval' } };
    }

    await this.deps.audit.write({
      tenantId: session.tenantId, type: 'tool_call_requested',
      correlationId: session.correlationId, sessionId: session.id, actor: 'assistant',
      consentEventId: decision.consentEventId,
      payload: { tool: call.tool },
      versions: session.versions,
    });

    // Steps 6 and 7: least-privilege execution.
    const result = await this.dispatch(session, config, call, decision.consentEventId);

    // Step 8: post-execution audit.
    await this.deps.audit.write({
      tenantId: session.tenantId, type: 'tool_call_executed',
      correlationId: session.correlationId, sessionId: session.id, actor: 'system',
      consentEventId: decision.consentEventId,
      payload: {
        tool: call.tool,
        parked: result.parked ?? false,
        // Chunk ids travel to the audit log so the content-performance view can
        // answer "which knowledge item resolved this, and which preceded an
        // escalation" without a second store to keep in step.
        ...(Array.isArray(result.internal?.['chunkIds']) ? { chunkIds: result.internal['chunkIds'] } : {}),
      },
      versions: session.versions,
    });

    return result;
  }

  private async dispatch(
    session: Session,
    config: TenantConfig,
    call: ProposedToolCall,
    consentEventId: string | undefined,
  ): Promise<ToolExecutionResult> {
    const args = call.args;

    switch (call.tool) {
      case 'classify_intent':
        return { modelVisible: { acknowledged: true } };

      case 'knowledge_lookup': {
        const chunks = this.deps.retrieval.retrieve(session.tenantId, String(args['query']), { limit: 4 });
        if (chunks.length === 0) {
          return { modelVisible: { found: false, guidance: NO_KNOWLEDGE_RESPONSE } };
        }
        const envelope = wrapAsData(chunks);
        session.valueDelivered = true;
        return {
          modelVisible: { found: true, reference: envelope.text },
          internal: { chunkIds: envelope.chunkIds, retrievedText: chunks.map((c) => c.chunk.text).join(' ') },
        };
      }

      case 'resolve_identity': {
        const resolution = await this.deps.identity.resolve({
          tenantId: session.tenantId,
          sessionId: session.id,
          subjectRef: session.subjectRef,
          correlationId: session.correlationId,
          email: args['work_email'] as string | undefined,
          phone: args['phone_e164'] as string | undefined,
        });

        // Internal fields stay internal. The model gets a classification and a
        // permitted behaviour and nothing else (section 22.2).
        session.classification = resolution.classification;
        session.ownerRef = resolution.ownerRef;
        session.personExternalId = resolution.matchedExternalId;

        if (resolution.suspectedDuplicates.length > 0 && resolution.ownerRef) {
          await this.raiseDuplicateTask(session, resolution.suspectedDuplicates.length);
        }

        return {
          modelVisible: this.deps.identity.toModelSafe(resolution) as unknown as Record<string, unknown>,
          internal: { ownerRef: resolution.ownerRef, matchedExternalId: resolution.matchedExternalId },
        };
      }

      case 'capture_contact': {
        // Capture is a platform-side record. Nothing is written to a CRM until
        // the visitor is qualified, because creating a Contact for an
        // unqualified visitor corrupts the tenant's conversion reporting.
        const captured = { ...session.qualification.captured };
        for (const field of ['work_email', 'full_name', 'phone_e164', 'organisation', 'job_title', 'service_interest']) {
          const value = args[field];
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            captured[field] = value;
          }
        }
        session.qualification = { ...session.qualification, captured };
        return { modelVisible: { captured: Object.keys(captured), stored: true } };
      }

      case 'upsert_person': {
        const envelope = this.envelope(session, 'upsert_person', {
          emails: [String(args['work_email'])],
          phones: args['phone_e164'] ? [String(args['phone_e164'])] : undefined,
          name: splitName(args['full_name'] as string | undefined),
          jobTitle: args['job_title'] as string | undefined,
          qualificationState: (args['qualification_state'] as string) ?? 'CAPTURED',
          organisation: args['organisation_domain']
            ? { domains: [String(args['organisation_domain'])], name: args['organisation_name'] as string | undefined }
            : undefined,
        });
        return this.writeOrPark(session, envelope, (result) => {
          session.personExternalId = result.externalId;
          return { externalId: result.externalId };
        }, config);
      }

      case 'upsert_organisation': {
        const envelope = this.envelope(session, 'upsert_organisation', {
          domains: [String(args['domain'])],
          name: args['name'] as string | undefined,
          sizeBand: args['size_band'] as string | undefined,
        });
        return this.writeOrPark(session, envelope, (result) => ({ externalId: result.externalId }), config);
      }

      case 'create_note': {
        const envelope = this.envelope(session, 'create_note', {
          type: 'note',
          subject: String(args['subject']),
          body: String(args['body'] ?? ''),
          personRef: (args['person_external_id'] as string | undefined) ?? session.personExternalId,
          occurredAt: this.clock.iso(),
        });
        return this.writeOrPark(session, envelope, (result) => ({ externalId: result.externalId }), config);
      }

      case 'create_task': {
        const envelope = this.envelope(session, 'create_task', {
          type: 'task',
          subject: String(args['subject']),
          body: args['body'] as string | undefined,
          personRef: (args['person_external_id'] as string | undefined) ?? session.personExternalId,
          // The owner comes from the CRM-resolved reference, never from the model.
          ownerRef: session.ownerRef,
          dueAt: args['due_at'] as string | undefined,
        });
        return this.writeOrPark(session, envelope, (result) => ({ externalId: result.externalId }), config);
      }

      case 'create_opportunity': {
        // Deliberately not a CRM write in this build. Stage and pipeline are
        // CRM-authoritative, and an opportunity created without them is worse
        // than none. The request is captured for the owner to action.
        const envelope = this.envelope(session, 'create_task', {
          type: 'task',
          subject: 'Website assistant: opportunity requested',
          body: String(args['summary']),
          personRef: (args['person_external_id'] as string | undefined) ?? session.personExternalId,
          ownerRef: session.ownerRef,
        });
        return this.writeOrPark(session, envelope, () => ({ opportunityRequested: true }), config);
      }

      case 'check_availability': {
        const from = (args['from'] as string) ?? this.clock.iso();
        const to = (args['to'] as string) ?? new Date(this.clock.nowMs() + 14 * 86_400_000).toISOString();
        const slots = await this.deps.calendar.availability(
          session.tenantId, (args['owner_ref'] as string | undefined) ?? session.ownerRef, from, to,
        );
        session.valueDelivered = true;
        return {
          modelVisible: {
            slots: slots.slice(0, 5).map((slot) => ({ slot_id: slot.id, starts_at: slot.startsAt, ends_at: slot.endsAt })),
          },
        };
      }

      case 'book_meeting': {
        const slotId = String(args['slot_id']);
        const key = idempotencyKey(session.id, 'book_meeting', this.deps.sessions.nextWriteSequence(session));

        // Hold, then confirm against the provider. The provider is
        // authoritative and we never confirm a slot we have not held.
        await this.deps.calendar.hold(session.tenantId, slotId);
        const booking = await this.deps.calendar.confirm(session.tenantId, slotId, String(args['work_email']), key);

        // The CRM write may fail. The booking is confirmed to the visitor
        // regardless, and consistency is repaired asynchronously (flow 12).
        const envelope = this.envelope(session, 'create_meeting', {
          type: 'meeting',
          subject: 'Meeting booked via website assistant',
          body: `Booked by the website assistant for ${booking.visitorEmail}.`,
          personRef: session.personExternalId,
          ownerRef: booking.slot.ownerRef,
          startsAt: booking.slot.startsAt,
          endsAt: booking.slot.endsAt,
        });

        let crmLogged = true;
        try {
          await this.deps.adapter.write(envelope);
        } catch {
          crmLogged = false;
          booking.state = 'ReconciliationPending';
          await this.deps.audit.write({
            tenantId: session.tenantId, type: 'crm_write_parked',
            correlationId: session.correlationId, sessionId: session.id, actor: 'system',
            payload: { reason: 'booking confirmed, CRM meeting write failed', bookingId: booking.id },
          });
        }

        // settle, not transition: the calendar has already confirmed.
        this.deps.sessions.settle(session, 'Booked');
        return {
          // The visitor is never told a meeting failed when the calendar
          // accepted it. This is the invariant, not a nicety.
          modelVisible: { booked: true, starts_at: booking.slot.startsAt },
          internal: { bookingId: booking.id, crmLogged },
        };
      }

      case 'notify_owner': {
        await this.deps.notifications.notifyOwner({
          tenantId: session.tenantId,
          to: (args['owner_ref'] as string) ?? session.ownerRef ?? 'sales@tenant',
          subject: `Website assistant: ${String(args['reason'])}`,
          body: String(args['summary']),
          correlationId: session.correlationId,
        });
        return { modelVisible: { notified: true } };
      }

      case 'send_transactional_email': {
        await this.deps.notifications.sendTransactional({
          tenantId: session.tenantId,
          to: String(args['work_email']),
          subject: TRANSACTIONAL_SUBJECTS[String(args['template'])] ?? 'Your request',
          body: 'Transactional content only. No promotional material is included.',
          correlationId: session.correlationId,
        });
        return { modelVisible: { sent: true } };
      }

      case 'enrol_sequence': {
        if (!consentEventId) {
          // Unreachable through the policy gate. Kept as a second, independent
          // refusal so a policy regression cannot produce an unlawful enrolment.
          throw new AwaError({ kind: 'CONSENT_REQUIRED', message: 'enrol_sequence requires a stored marketing consent event' });
        }
        await this.deps.notifications.enrolInSequence({
          tenantId: session.tenantId,
          to: String(args['work_email']),
          subject: `Sequence ${String(args['sequence_id'])}`,
          body: 'Enrolled with evidenced consent.',
          correlationId: session.correlationId,
          consentEventId,
        });
        return { modelVisible: { enrolled: true } };
      }

      case 'record_outcome': {
        if (!this.deps.outcomes) {
          return { modelVisible: { recorded: false, reason: 'outcome recording is not configured' } };
        }
        const captured = session.qualification.captured;
        const result = await this.deps.outcomes.record({
          config,
          conversationId: session.id,
          correlationId: session.correlationId,
          outcome: String(args['outcome']),
          person: { email: (args['work_email'] as string | undefined) ?? (captured['work_email'] as string | undefined) },
          qualification: {
            criteriaMet: Object.keys(captured),
            scoreBand: Object.keys(captured).length >= 3 ? 'high' : 'low',
          },
        });
        // The model is told the outcome was recorded. It is not told whether it
        // was billable, because that is not its business and telling it invites
        // it to optimise for the billable ones.
        return {
          modelVisible: { recorded: true, outcome: result.outcome },
          internal: { billable: result.billable, state: result.state },
        };
      }

      case 'start_recording':
        return { modelVisible: { recording: true, consentEventId } };

      case 'escalate_to_human': {
        const handoff = await this.deps.handoff.raise({
          tenantId: session.tenantId, sessionId: session.id, correlationId: session.correlationId,
          reason: String(args['reason']),
          transcript: session.history.map((m) => ({ role: m.role, text: m.text })),
          qualification: session.qualification.captured,
          classification: session.classification,
          ownerRef: session.ownerRef,
        });
        await this.deps.audit.write({
          tenantId: session.tenantId, type: 'escalated_to_human',
          correlationId: session.correlationId, sessionId: session.id, actor: 'policy',
          payload: { reason: String(args['reason']), handoffId: handoff.handoffId },
        });
        this.deps.sessions.settle(session, 'HandedOff');
        return { modelVisible: { escalated: true } };
      }

      case 'quote_price': {
        // The platform decides what may be said; the assistant relays it. A
        // model that wants to state a different figure has no path to do so.
        const outcome = evaluatePriceAuthority(config, {
          sku: args['sku'] as string | undefined,
          discountRequested: args['discount_requested'] === true,
          customScopeRequested: args['custom_scope_requested'] === true,
        });
        if (outcome.kind === 'ROUTE_TO_HUMAN') {
          await this.deps.handoff.raise({
            tenantId: session.tenantId, sessionId: session.id, correlationId: session.correlationId,
            reason: `price authority: ${outcome.reason}`,
            transcript: session.history.map((m) => ({ role: m.role, text: m.text })),
            qualification: session.qualification.captured,
            ownerRef: session.ownerRef,
          });
        }
        return {
          modelVisible: { outcome: outcome.kind, say: outcome.statement },
          internal: { approvedFigures: [...approvedFigures(config)] },
        };
      }

      default:
        throw new AwaError({ kind: 'POLICY_DENIED', message: `tool ${call.tool} has no execution path` });
    }
  }

  private envelope(session: Session, operation: CanonicalWriteEnvelope['operation'], canonical: unknown): CanonicalWriteEnvelope {
    return {
      tenantId: session.tenantId,
      correlationId: session.correlationId,
      idempotencyKey: idempotencyKey(session.id, operation, this.deps.sessions.nextWriteSequence(session)),
      operation,
      canonical: canonical as CanonicalWriteEnvelope['canonical'],
      sourceOfTruthPolicy: 'assistant_may_write_contact_fields_only',
      forbiddenFields: [...FORBIDDEN_WRITE_FIELDS],
    };
  }

  /**
   * Attempt a CRM write; park it on a degraded connection rather than failing
   * the conversation. Fail closed on the credential, fail open on the
   * conversation (flow 19).
   */
  private async writeOrPark(
    session: Session,
    envelope: CanonicalWriteEnvelope,
    onSuccess: (result: { externalId: string }) => Record<string, unknown>,
    config?: TenantConfig,
  ): Promise<ToolExecutionResult> {
    // Dry-run: the envelope is staged rather than executed. Checked here, after
    // schema validation and the policy gate, so a staged write is one that
    // would genuinely have been permitted — staging an envelope the policy
    // engine would have refused would make the diff a lie.
    if (config?.dryRun && this.deps.staging) {
      const staged = this.deps.staging.stage(envelope);
      await this.deps.audit.write({
        tenantId: session.tenantId,
        type: 'crm_write_parked',
        correlationId: session.correlationId,
        sessionId: session.id,
        actor: 'system',
        payload: { reason: 'dry-run: staged for tenant review', operation: envelope.operation, stagedId: staged.id },
      });
      return { modelVisible: { written: false, staged: true }, internal: { stagedId: staged.id } };
    }

    try {
      const result = await this.deps.adapter.write(envelope);
      await this.deps.metering.record(session.tenantId, 'crm_call', 1);
      return { modelVisible: { written: true, ...onSuccess(result) } };
    } catch (cause) {
      const error = cause instanceof AwaError ? cause : new AwaError({ kind: 'INTERNAL', message: String(cause), cause });
      if (error.kind === 'CONNECTION_DEGRADED' || error.retryable) {
        // The visitor is told the team has their details, which is true: the
        // write is durably queued and will drain idempotently on reconnect.
        return { modelVisible: { written: false, queued: true }, parked: true };
      }
      throw error;
    }
  }

  private async raiseDuplicateTask(session: Session, count: number): Promise<void> {
    const envelope = this.envelope(session, 'create_task', {
      type: 'task',
      subject: 'Possible duplicate record detected',
      body: `The website assistant matched this person against ${count + 1} records and did not merge them. Please review.`,
      personRef: session.personExternalId,
      ownerRef: session.ownerRef,
    });
    try {
      await this.deps.adapter.write(envelope);
    } catch {
      // A failed duplicate task is not worth failing the conversation over; the
      // suspicion is already in the audit log.
    }
  }
}

const TRANSACTIONAL_SUBJECTS: Record<string, string> = {
  meeting_confirmation: 'Your meeting is confirmed',
  requested_information: 'The information you asked for',
  callback_confirmation: 'We will call you back',
};

function splitName(full?: string): { given?: string; family?: string; full?: string } | undefined {
  if (!full) return undefined;
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { full, given: parts[0] };
  return { full, given: parts[0], family: parts.slice(1).join(' ') };
}
