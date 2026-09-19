import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  AwaError, isBillable, newId, requiresConfirmation,
  type Clock, type ConversationOutcome, type TenantConfig, systemClock,
} from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import type { MeteringService } from '@detent/awa-policy';

/**
 * The outcome service (section 40).
 *
 * Two rules here are commercial decisions expressed as code:
 *
 *  - escalation, disqualification and abandonment are **never** billable
 *    (FR-047). This aligns the platform's revenue with the tenant's outcome and
 *    removes the incentive to over-qualify, which is the most common criticism
 *    levelled at per-conversation pricing;
 *  - an outcome that requires downstream confirmation is not billable until the
 *    tenant's own system confirms it happened (FR-046). The platform does not
 *    bill for a routing decision that failed downstream.
 */
export type OutcomeState = 'RECORDED' | 'AWAITING_CONFIRMATION' | 'CONFIRMED' | 'FAILED' | 'NOT_BILLABLE';

export interface RecordedOutcome {
  readonly id: string;
  readonly tenantId: string;
  readonly conversationId: string;
  readonly correlationId: string;
  readonly outcome: ConversationOutcome;
  state: OutcomeState;
  readonly billable: boolean;
  readonly recordedAt: string;
  confirmedAt?: string;
  failureReason?: string;
  readonly person?: { email?: string; name?: string; organisation?: string };
  readonly attribution?: Attribution;
  readonly partnerId?: string;
}

export interface Attribution {
  readonly source?: string;
  readonly campaign?: string;
  readonly landingPage?: string;
}

export interface TrialProvisioningPayload {
  readonly outcome: 'start_trial';
  readonly tenant_id: string;
  readonly correlation_id: string;
  readonly person: { email?: string; name?: string; organisation?: string };
  readonly qualification: { criteria_met: readonly string[]; score_band: string };
  readonly consent: { marketing_consent_event_id: string | null; transactional_ok: boolean };
  readonly attribution: Attribution;
  readonly success_callback: string;
}

export interface OutcomeDispatcher {
  /** Call the tenant's webhook. Never holds a credential for their product. */
  post(url: string, payload: unknown, signature: string): Promise<{ status: number }>;
}

export interface OutcomeStore {
  put(outcome: RecordedOutcome): Promise<void>;
  get(tenantId: string, id: string): Promise<RecordedOutcome | undefined>;
  byCorrelation(tenantId: string, correlationId: string): Promise<RecordedOutcome[]>;
  list(tenantId: string): Promise<RecordedOutcome[]>;
}

export class InMemoryOutcomeStore implements OutcomeStore {
  private readonly outcomes = new Map<string, RecordedOutcome>();
  private key(tenantId: string, id: string): string { return `${tenantId}:${id}`; }
  async put(outcome: RecordedOutcome): Promise<void> { this.outcomes.set(this.key(outcome.tenantId, outcome.id), outcome); }
  async get(tenantId: string, id: string): Promise<RecordedOutcome | undefined> { return this.outcomes.get(this.key(tenantId, id)); }
  async byCorrelation(tenantId: string, correlationId: string): Promise<RecordedOutcome[]> {
    return [...this.outcomes.values()].filter((o) => o.tenantId === tenantId && o.correlationId === correlationId);
  }
  async list(tenantId: string): Promise<RecordedOutcome[]> {
    return [...this.outcomes.values()].filter((o) => o.tenantId === tenantId);
  }
}

export interface RecordOutcomeInput {
  readonly config: TenantConfig;
  readonly conversationId: string;
  readonly correlationId: string;
  readonly outcome: ConversationOutcome;
  readonly person?: { email?: string; name?: string; organisation?: string };
  readonly qualification?: { criteriaMet: readonly string[]; scoreBand: string };
  readonly marketingConsentEventId?: string;
  readonly attribution?: Attribution;
  readonly callbackBaseUrl?: string;
}

export class OutcomeService {
  constructor(
    private readonly store: OutcomeStore,
    private readonly metering: MeteringService,
    private readonly audit: AuditLog,
    private readonly dispatcher: OutcomeDispatcher,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Record the outcome a conversation reached.
   *
   * The model recognises which outcome was reached; this function decides
   * whether it is billable and whether it needs confirming. That split is the
   * section 48.2 boundary extension.
   */
  async record(input: RecordOutcomeInput): Promise<RecordedOutcome> {
    const { config, outcome } = input;

    if (!config.outcomes.enabled.includes(outcome)) {
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message: `outcome ${outcome} is not enabled for tenant ${config.tenantId}`,
        tenantId: config.tenantId,
        correlationId: input.correlationId,
      });
    }

    const billable = isBillable(outcome);
    const needsConfirmation = billable && requiresConfirmation(outcome);

    const recorded: RecordedOutcome = {
      id: newId('corr', this.clock.nowMs()),
      tenantId: config.tenantId,
      conversationId: input.conversationId,
      correlationId: input.correlationId,
      outcome,
      state: !billable ? 'NOT_BILLABLE' : needsConfirmation ? 'AWAITING_CONFIRMATION' : 'CONFIRMED',
      billable,
      recordedAt: this.clock.iso(),
      confirmedAt: !billable || needsConfirmation ? undefined : this.clock.iso(),
      person: input.person,
      attribution: input.attribution,
    };

    await this.store.put(recorded);

    // Metering happens only on a confirmed billable outcome. An outcome
    // awaiting confirmation is not metered, and one that never confirms is
    // never billed.
    if (recorded.state === 'CONFIRMED') {
      await this.metering.record(config.tenantId, 'qualified_outcome', 1);
    }

    await this.audit.write({
      tenantId: config.tenantId,
      type: 'tool_call_executed',
      correlationId: input.correlationId,
      actor: 'system',
      payload: { change: 'outcome_recorded', outcome, billable, state: recorded.state },
    });

    if (outcome === 'start_trial') {
      await this.provisionTrial(recorded, input);
    }

    return recorded;
  }

  /**
   * Trial provisioning (section 40.3). Three patterns in order of preference:
   * a tenant-supplied webhook, a signed magic link, or a redirect with
   * attribution.
   *
   * The platform never holds credentials for the tenant's product and never
   * creates accounts directly: that would extend the credential blast radius
   * described in section 24.2 for marginal benefit.
   */
  private async provisionTrial(recorded: RecordedOutcome, input: RecordOutcomeInput): Promise<void> {
    const provisioning = input.config.outcomes.trialProvisioning;
    if (!provisioning) {
      recorded.state = 'FAILED';
      recorded.failureReason = 'no trial provisioning configured for this tenant';
      await this.store.put(recorded);
      return;
    }

    const payload: TrialProvisioningPayload = {
      outcome: 'start_trial',
      tenant_id: recorded.tenantId,
      correlation_id: recorded.correlationId,
      person: input.person ?? {},
      qualification: {
        criteria_met: input.qualification?.criteriaMet ?? [],
        score_band: input.qualification?.scoreBand ?? 'unknown',
      },
      consent: {
        // Null unless a marketing consent event genuinely exists. The tenant's
        // own system must not infer permission from the absence of a field.
        marketing_consent_event_id: input.marketingConsentEventId ?? null,
        transactional_ok: true,
      },
      attribution: input.attribution ?? {},
      success_callback: `${input.callbackBaseUrl ?? ''}/v1/outcomes/${recorded.correlationId}/confirm`,
    };

    if (provisioning.method !== 'webhook') {
      // Magic link and redirect are tenant-driven: the confirmation callback is
      // still the only thing that makes the outcome billable.
      return;
    }

    try {
      const signature = signPayload(provisioning.signingKeyRef ?? '', payload);
      const response = await this.dispatcher.post(provisioning.endpoint, payload, signature);
      if (response.status >= 400) {
        recorded.state = 'FAILED';
        recorded.failureReason = `trial webhook returned ${response.status}`;
        await this.store.put(recorded);
      }
    } catch (cause) {
      recorded.state = 'FAILED';
      recorded.failureReason = cause instanceof Error ? cause.message : 'trial webhook failed';
      await this.store.put(recorded);
    }
  }

  /**
   * The confirmation callback (FR-046). Closes the loop: an outcome is not
   * billable until the tenant's system confirms it actually happened.
   */
  async confirm(tenantId: string, correlationId: string, options: { succeeded: boolean; reason?: string } = { succeeded: true }): Promise<RecordedOutcome> {
    const matches = await this.store.byCorrelation(tenantId, correlationId);
    const pending = matches.find((outcome) => outcome.state === 'AWAITING_CONFIRMATION');
    if (!pending) {
      throw new AwaError({
        kind: 'NOT_FOUND',
        message: `no outcome awaiting confirmation for correlation ${correlationId}`,
        tenantId,
      });
    }

    if (options.succeeded) {
      pending.state = 'CONFIRMED';
      pending.confirmedAt = this.clock.iso();
      await this.metering.record(tenantId, 'qualified_outcome', 1);
    } else {
      pending.state = 'FAILED';
      pending.failureReason = options.reason ?? 'downstream system reported failure';
    }

    await this.store.put(pending);
    await this.audit.write({
      tenantId, type: 'tool_call_executed', correlationId, actor: 'system',
      payload: { change: 'outcome_confirmation', outcome: pending.outcome, state: pending.state, reason: pending.failureReason },
    });
    return pending;
  }

  async list(tenantId: string): Promise<RecordedOutcome[]> {
    return this.store.list(tenantId);
  }

  /** Only CONFIRMED billable outcomes count. Everything else is zero revenue. */
  async billableCount(tenantId: string): Promise<number> {
    const outcomes = await this.store.list(tenantId);
    return outcomes.filter((outcome) => outcome.billable && outcome.state === 'CONFIRMED').length;
  }
}

export function signPayload(key: string, payload: unknown): string {
  return createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex');
}

export function verifySignature(key: string, rawBody: string, signature: string): boolean {
  const expected = createHmac('sha256', key).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
