import { AwaError, type Clock, type SpendCaps, systemClock } from '@detent/awa-core';

/**
 * Per-tenant metering, quota and spend-cap enforcement (FR-026, section 32.5).
 *
 * Denial of wallet is the acute multi-tenant risk: a bot flood on one tenant's
 * site burns pooled voice minutes at burst pricing. The cap is therefore
 * enforced here, before the spend is incurred, rather than reconciled at
 * invoicing. Approaching the cap degrades to text; reaching it stops spend.
 */
export type MeterKind =
  | 'conversation' | 'text_message' | 'voice_minute' | 'crm_call' | 'llm_token'
  /** A confirmed billable outcome (section 40). Revenue, not cost. */
  | 'qualified_outcome'
  /** A per-record third-party enrichment cost (section 43.4). */
  | 'enrichment_record'
  | 'company_resolution';

export interface UsageRecord {
  readonly tenantId: string;
  readonly period: string; // YYYY-MM
  conversations: number;
  textMessages: number;
  voiceMinutes: number;
  crmCalls: number;
  llmTokens: number;
  /** Confirmed billable outcomes. Counted, never a cost. */
  qualifiedOutcomes: number;
  enrichmentRecords: number;
  companyResolutions: number;
  /** Accrued cost of goods in pence, so the cap is enforced in money, not units. */
  spendPence: number;
  concurrentVoice: number;
}

/**
 * Blended unit costs in pence (section 32.1, at £1 = $1.27). These are cost of
 * goods, not price. They are configuration, not constants, precisely because
 * every one of them is a vendor figure that moves.
 */
export interface UnitCostsPence {
  readonly voiceMinute: number;
  readonly voiceMinuteBurst: number;
  readonly textMessage: number;
  readonly llmPerThousandTokens: number;
  readonly crmCall: number;
  readonly conversationOverhead: number;
  /**
   * Enrichment is the first component with a per-record marginal cost paid to a
   * third party (section 43.4), and it changes the unit economics materially.
   * It is metered as credits and the cost is shown before a bulk routine runs.
   */
  readonly enrichmentRecord: number;
  readonly companyResolution: number;
}

export const DEFAULT_UNIT_COSTS: UnitCostsPence = {
  voiceMinute: 6.3,        // $0.08 at 1.27
  voiceMinuteBurst: 12.6,  // $0.16 burst above the concurrency limit
  textMessage: 0.24,       // $0.003
  llmPerThousandTokens: 0.4,
  crmCall: 0.01,
  conversationOverhead: 2.0, // infrastructure, vector storage, observability
  enrichmentRecord: 8.0,     // vendor per-record cost, cached per tenant
  companyResolution: 1.5,    // reverse-IP company resolution, cached monthly
};

export type MeterVerdict =
  | { readonly state: 'OK' }
  | { readonly state: 'WARN'; readonly fractionUsed: number }
  | { readonly state: 'DEGRADE_TO_TEXT'; readonly fractionUsed: number }
  | { readonly state: 'BLOCKED'; readonly reason: 'spend_cap' | 'conversation_quota' | 'voice_concurrency' };

/**
 * Counter deltas applied in one atomic step.
 *
 * Every field is optional and additive; `concurrentVoiceFloorAtZero` exists
 * because closing a voice session decrements and must not go negative.
 */
export interface UsageDelta {
  readonly conversations?: number;
  readonly textMessages?: number;
  readonly voiceMinutes?: number;
  readonly crmCalls?: number;
  readonly llmTokens?: number;
  readonly qualifiedOutcomes?: number;
  readonly enrichmentRecords?: number;
  readonly companyResolutions?: number;
  readonly spendPence?: number;
  readonly concurrentVoice?: number;
}

export interface UsageStore {
  get(tenantId: string, period: string): Promise<UsageRecord | undefined>;
  /**
   * Apply deltas atomically and return the resulting record (audit PERF-3).
   *
   * The previous interface was get/put, and `record()` was a read-modify-write
   * across an await: two concurrent turns read the same snapshot and the second
   * `put` discarded the first one's spend. Lost updates are most likely under
   * exactly the load that makes the cap matter, so the interface itself now
   * carries the atomicity requirement; a Postgres adapter implements this as
   * `UPDATE ... SET spend_pence = spend_pence + $1 ... RETURNING`, and Redis as
   * `INCRBY`, neither of which can lose an update.
   *
   * `guard` is evaluated against the post-increment record inside the same
   * critical section; when it returns false nothing is written and the call
   * reports the refusal. That is how voice concurrency is claimed without a
   * check-then-act race.
   */
  increment(
    tenantId: string,
    period: string,
    delta: UsageDelta,
    guard?: (next: UsageRecord) => boolean,
  ): Promise<{ record: UsageRecord; applied: boolean }>;
}

function applyDelta(record: UsageRecord, delta: UsageDelta): UsageRecord {
  const next: UsageRecord = {
    ...record,
    conversations: record.conversations + (delta.conversations ?? 0),
    textMessages: record.textMessages + (delta.textMessages ?? 0),
    voiceMinutes: record.voiceMinutes + (delta.voiceMinutes ?? 0),
    crmCalls: record.crmCalls + (delta.crmCalls ?? 0),
    llmTokens: record.llmTokens + (delta.llmTokens ?? 0),
    qualifiedOutcomes: record.qualifiedOutcomes + (delta.qualifiedOutcomes ?? 0),
    enrichmentRecords: record.enrichmentRecords + (delta.enrichmentRecords ?? 0),
    companyResolutions: record.companyResolutions + (delta.companyResolutions ?? 0),
    // Rounded to a thousandth of a penny on every step, so a long month of
    // sub-penny increments does not accumulate float drift.
    spendPence: Math.round((record.spendPence + (delta.spendPence ?? 0)) * 1000) / 1000,
    concurrentVoice: Math.max(0, record.concurrentVoice + (delta.concurrentVoice ?? 0)),
  };
  return next;
}

export class InMemoryUsageStore implements UsageStore {
  private readonly records = new Map<string, UsageRecord>();
  private key(tenantId: string, period: string): string { return `${tenantId}:${period}`; }

  async get(tenantId: string, period: string): Promise<UsageRecord | undefined> {
    return this.records.get(this.key(tenantId, period));
  }

  async increment(
    tenantId: string,
    period: string,
    delta: UsageDelta,
    guard?: (next: UsageRecord) => boolean,
  ): Promise<{ record: UsageRecord; applied: boolean }> {
    // No await between read and write: on a single-threaded runtime that is a
    // genuine critical section, and it is the same contract the Postgres and
    // Redis adapters implement with a single statement.
    const key = this.key(tenantId, period);
    const current = this.records.get(key) ?? emptyRecord(tenantId, period);
    const next = applyDelta(current, delta);
    if (guard && !guard(next)) return { record: current, applied: false };
    this.records.set(key, next);
    return { record: next, applied: true };
  }
}

function emptyRecord(tenantId: string, period: string): UsageRecord {
  return {
    tenantId, period,
    conversations: 0, textMessages: 0, voiceMinutes: 0, crmCalls: 0, llmTokens: 0,
    qualifiedOutcomes: 0, enrichmentRecords: 0, companyResolutions: 0,
    spendPence: 0, concurrentVoice: 0,
  };
}

export class MeteringService {
  constructor(
    private readonly store: UsageStore,
    private readonly costs: UnitCostsPence = DEFAULT_UNIT_COSTS,
    private readonly clock: Clock = systemClock,
  ) {}

  private period(): string {
    return this.clock.iso().slice(0, 7);
  }

  async usage(tenantId: string): Promise<UsageRecord> {
    const period = this.period();
    return (await this.store.get(tenantId, period)) ?? emptyRecord(tenantId, period);
  }

  /**
   * Check before spending. Called at session open and before any voice session
   * or bulk routine, so a tenant is never silently overspent on.
   */
  async check(tenantId: string, caps: SpendCaps, intent: { voice?: boolean } = {}): Promise<MeterVerdict> {
    const usage = await this.usage(tenantId);

    if (usage.spendPence >= caps.monthlyPence) {
      return { state: 'BLOCKED', reason: 'spend_cap' };
    }
    if (usage.conversations >= caps.maxConversationsPerMonth) {
      return { state: 'BLOCKED', reason: 'conversation_quota' };
    }
    if (intent.voice && usage.concurrentVoice >= caps.maxConcurrentVoice) {
      return { state: 'BLOCKED', reason: 'voice_concurrency' };
    }

    const fractionUsed = usage.spendPence / caps.monthlyPence;
    if (fractionUsed >= caps.degradeToTextAtFraction) {
      return { state: 'DEGRADE_TO_TEXT', fractionUsed };
    }
    if (fractionUsed >= caps.warnAtFraction) {
      return { state: 'WARN', fractionUsed };
    }
    return { state: 'OK' };
  }

  async record(tenantId: string, kind: MeterKind, quantity: number, options: { burst?: boolean } = {}): Promise<UsageRecord> {
    const { record } = await this.store.increment(tenantId, this.period(), deltaFor(kind, quantity, this.costs, options));
    return record;
  }

  /**
   * Claim a voice slot atomically. The concurrency test and the increment used
   * to be separate awaits, which made `maxConcurrentVoice` advisory under
   * concurrency; the guard now runs inside the store's critical section.
   */
  async openVoiceSession(tenantId: string, caps: SpendCaps): Promise<void> {
    const { applied } = await this.store.increment(
      tenantId, this.period(), { concurrentVoice: 1 },
      (next) => next.concurrentVoice <= caps.maxConcurrentVoice,
    );
    if (!applied) {
      throw new AwaError({
        kind: 'QUOTA_EXCEEDED',
        message: `voice concurrency cap of ${caps.maxConcurrentVoice} reached`,
        tenantId,
      });
    }
  }

  async closeVoiceSession(tenantId: string): Promise<void> {
    await this.store.increment(tenantId, this.period(), { concurrentVoice: -1 });
  }

  /** Blended cost of goods per conversation, tracked against the £0.60 target (NFR-015). */
  async costPerConversationPence(tenantId: string): Promise<number | undefined> {
    const usage = await this.usage(tenantId);
    if (usage.conversations === 0) return undefined;
    return usage.spendPence / usage.conversations;
  }
}

/** Translate a metered event into counter deltas and its cost of goods. */
function deltaFor(
  kind: MeterKind,
  quantity: number,
  costs: UnitCostsPence,
  options: { burst?: boolean },
): UsageDelta {
  switch (kind) {
    case 'conversation':
      return { conversations: quantity, spendPence: quantity * costs.conversationOverhead };
    case 'text_message':
      return { textMessages: quantity, spendPence: quantity * costs.textMessage };
    case 'voice_minute':
      return {
        voiceMinutes: quantity,
        spendPence: quantity * (options.burst ? costs.voiceMinuteBurst : costs.voiceMinute),
      };
    case 'crm_call':
      return { crmCalls: quantity, spendPence: quantity * costs.crmCall };
    case 'llm_token':
      return { llmTokens: quantity, spendPence: (quantity / 1000) * costs.llmPerThousandTokens };
    case 'qualified_outcome':
      // Counted, never costed. A confirmed outcome is what the tenant pays for,
      // so adding it to spendPence would double-count it as a cost.
      return { qualifiedOutcomes: quantity };
    case 'enrichment_record':
      return { enrichmentRecords: quantity, spendPence: quantity * costs.enrichmentRecord };
    case 'company_resolution':
      return { companyResolutions: quantity, spendPence: quantity * costs.companyResolution };
  }
}
