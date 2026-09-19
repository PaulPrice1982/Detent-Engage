import { type Clock, systemClock } from '@detent/awa-core';
import { format, type Money } from './money.js';
import { daysOverdue, type Invoice } from './invoices.js';

/**
 * Dunning: the ladder from a missed payment to a suspended service.
 *
 * The design constraint is that **service is degraded before it is withdrawn,
 * and withdrawal is never silent**. A B2B customer whose assistant simply stops
 * answering their website has a worse problem than an unpaid invoice, and they
 * will hold us responsible for it, correctly, if we never told them.
 *
 * So the ladder is slow, every step is notified, and the terminal step is a
 * deliberate operator action rather than an automatic one. Nothing here
 * suspends anything on its own: it returns the step that is *due*, and the
 * operator console or a scheduled job acts on it.
 */

export type DunningStage =
  | 'current'
  /** Payment failed or is late. Nothing visible to the tenant's visitors. */
  | 'reminder'
  /** Chased again. Tenant admins warned in-product. */
  | 'warning'
  /** Voice disabled, conversations capped. The assistant still answers. */
  | 'degraded'
  /** Assistant stops. Requires an operator to confirm. */
  | 'suspended'
  /** Written off; the account is closed to new usage. */
  | 'terminated';

export interface DunningStep {
  readonly stage: DunningStage;
  /** Days past due at which this step becomes due. */
  readonly atDaysOverdue: number;
  readonly description: string;
  /** Whether reaching this step needs a human to confirm it. */
  readonly requiresOperatorApproval: boolean;
  /** What the tenant is told. Empty means nothing is sent. */
  readonly notify: 'none' | 'billing_contact' | 'billing_contact_and_admins';
}

/**
 * The default ladder. Deliberately generous before anything degrades: the first
 * two weeks are a finance department's normal latency, not a credit risk.
 */
export const DEFAULT_LADDER: readonly DunningStep[] = [
  {
    stage: 'reminder', atDaysOverdue: 3,
    description: 'Payment is late. Remind the billing contact.',
    requiresOperatorApproval: false, notify: 'billing_contact',
  },
  {
    stage: 'warning', atDaysOverdue: 10,
    description: 'Still unpaid. Warn the billing contact and tenant admins in-product.',
    requiresOperatorApproval: false, notify: 'billing_contact_and_admins',
  },
  {
    stage: 'degraded', atDaysOverdue: 21,
    description: 'Disable voice and cap conversations. The assistant continues to answer.',
    requiresOperatorApproval: false, notify: 'billing_contact_and_admins',
  },
  {
    stage: 'suspended', atDaysOverdue: 35,
    description: 'Stop the assistant. Requires an operator to confirm.',
    requiresOperatorApproval: true, notify: 'billing_contact_and_admins',
  },
  {
    stage: 'terminated', atDaysOverdue: 90,
    description: 'Close the account to new usage and write off. Requires an operator to confirm.',
    requiresOperatorApproval: true, notify: 'billing_contact_and_admins',
  },
];

export interface DunningState {
  readonly accountId: string;
  readonly stage: DunningStage;
  /** The oldest unpaid invoice driving the stage, if any. */
  readonly drivingInvoiceId?: string;
  readonly daysOverdue: number;
  readonly amountOverdue: Money;
  /** The step now due but not yet actioned, if any. */
  readonly pendingStep?: DunningStep;
  /** True when the pending step needs a human before it may be applied. */
  readonly awaitingApproval: boolean;
  readonly assessedAt: string;
}

export interface DunningRecord {
  readonly accountId: string;
  readonly stage: DunningStage;
  /** Stages already applied, so a step is never actioned twice. */
  readonly appliedStages: readonly DunningStage[];
  readonly updatedAt: string;
  /** Set when an operator pauses the ladder: a payment plan, a dispute. */
  readonly heldUntil?: string;
  readonly holdReason?: string;
}

export interface DunningStore {
  get(accountId: string): Promise<DunningRecord | undefined>;
  put(record: DunningRecord): Promise<void>;
}

export class InMemoryDunningStore implements DunningStore {
  private readonly records = new Map<string, DunningRecord>();
  async get(accountId: string): Promise<DunningRecord | undefined> {
    return this.records.get(accountId);
  }
  async put(record: DunningRecord): Promise<void> {
    this.records.set(record.accountId, record);
  }
}

export class DunningService {
  constructor(
    private readonly store: DunningStore,
    private readonly clock: Clock = systemClock,
    private readonly ladder: readonly DunningStep[] = DEFAULT_LADDER,
  ) {}

  /**
   * Works out where an account stands. Pure assessment, nothing is applied and
   * nothing is sent. The operator console reads this; a job acts on it.
   */
  async assess(accountId: string, overdueInvoices: readonly Invoice[]): Promise<DunningState> {
    const now = this.clock.iso();
    const record = await this.store.get(accountId);

    // A hold is an explicit commercial decision: a payment plan, a disputed
    // invoice, and it outranks the ladder entirely. Chasing a customer who has
    // agreed terms with us is how a solvable problem becomes a lost account.
    if (record?.heldUntil && record.heldUntil > now) {
      return {
        accountId, stage: record.stage, daysOverdue: 0,
        amountOverdue: { amount: 0, currency: 'GBP' },
        awaitingApproval: false, assessedAt: now,
      };
    }

    if (overdueInvoices.length === 0) {
      if (record && record.stage !== 'current') {
        await this.store.put({
          accountId, stage: 'current', appliedStages: [], updatedAt: now,
        });
      }
      return {
        accountId, stage: 'current', daysOverdue: 0,
        amountOverdue: { amount: 0, currency: overdueInvoices[0]?.currency ?? 'GBP' },
        awaitingApproval: false, assessedAt: now,
      };
    }

    const oldest = overdueInvoices[0]!;
    const days = daysOverdue(oldest, now);
    const currency = oldest.currency;
    const amountOverdue: Money = {
      amount: overdueInvoices.reduce((total, invoice) => total + invoice.amountDue.amount, 0),
      currency,
    };

    // The highest rung reached, not merely the next one: an account that has
    // been ignored for 40 days is at 'suspended', not stepping through
    // 'reminder' as though the earlier days had not happened.
    const reached = this.ladder.filter((step) => days >= step.atDaysOverdue);
    const due = reached[reached.length - 1];
    const applied = record?.appliedStages ?? [];
    const pendingStep = due && !applied.includes(due.stage) ? due : undefined;

    return {
      accountId,
      stage: due?.stage ?? 'current',
      drivingInvoiceId: oldest.invoiceId,
      daysOverdue: days,
      amountOverdue,
      pendingStep,
      awaitingApproval: pendingStep?.requiresOperatorApproval ?? false,
      assessedAt: now,
    };
  }

  /**
   * Records that a step was carried out.
   *
   * A step needing approval may only be applied with an operator named. That is
   * the whole point of the flag: suspending a paying customer's assistant is a
   * commercial decision, and it should have somebody's name against it.
   */
  async applyStep(accountId: string, step: DunningStep, actor?: string): Promise<DunningRecord> {
    if (step.requiresOperatorApproval && !actor) {
      throw new Error(`Stage ${step.stage} requires a named operator to approve it.`);
    }
    const existing = await this.store.get(accountId);
    const record: DunningRecord = {
      accountId,
      stage: step.stage,
      appliedStages: [...(existing?.appliedStages ?? []), step.stage],
      updatedAt: this.clock.iso(),
    };
    await this.store.put(record);
    return record;
  }

  /** Pauses the ladder: a payment plan, a dispute, a goodwill decision. */
  async hold(accountId: string, untilIso: string, reason: string): Promise<DunningRecord> {
    if (!reason.trim()) throw new Error('A dunning hold requires a reason.');
    const existing = await this.store.get(accountId);
    const record: DunningRecord = {
      accountId,
      stage: existing?.stage ?? 'current',
      appliedStages: existing?.appliedStages ?? [],
      updatedAt: this.clock.iso(),
      heldUntil: untilIso,
      holdReason: reason,
    };
    await this.store.put(record);
    return record;
  }

  /** Clears the ladder after payment. */
  async resolve(accountId: string): Promise<DunningRecord> {
    const record: DunningRecord = {
      accountId, stage: 'current', appliedStages: [], updatedAt: this.clock.iso(),
    };
    await this.store.put(record);
    return record;
  }

  async get(accountId: string): Promise<DunningRecord | undefined> {
    return this.store.get(accountId);
  }
}

/** What the tenant is told at a stage. Plain, factual, no threats. */
export function dunningMessage(state: DunningState, billingName = 'there'): string {
  const amount = format(state.amountOverdue);
  switch (state.stage) {
    case 'reminder':
      return `Hi ${billingName}, an invoice of ${amount} is now ${state.daysOverdue} days past due. If it is already paid, please ignore this.`;
    case 'warning':
      return `Hi ${billingName}, ${amount} remains outstanding after ${state.daysOverdue} days. Please settle it or contact us to agree terms.`;
    case 'degraded':
      return `Hi ${billingName}, ${amount} is ${state.daysOverdue} days overdue, so voice has been disabled and conversation volume capped. The assistant is still answering. Settling the invoice restores full service immediately.`;
    case 'suspended':
      return `Hi ${billingName}, the assistant has been suspended because ${amount} has been outstanding for ${state.daysOverdue} days. Your data and configuration are retained. Settling the invoice restores service.`;
    case 'terminated':
      return `Hi ${billingName}, this account has been closed to new usage after ${state.daysOverdue} days. Please contact us to discuss reinstatement.`;
    default:
      return '';
  }
}
