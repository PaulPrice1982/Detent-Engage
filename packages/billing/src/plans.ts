import { money, type CurrencyCode, type Money } from './money.js';

/**
 * The plan catalogue (v1.0 section 32.4).
 *
 * The commercial shape is platform fee plus consumption credits plus a
 * per-qualified-lead outcome fee. That structure exists because pure
 * per-conversation pricing yields gross margin in the mid-thirties: the
 * platform fee covers the fixed cost of connectors, governance and support at
 * high margin, credits cover variable AI cost at a controlled markup, and the
 * outcome fee sits where the buyer's value actually lands.
 *
 * Prices are data, not constants. They are versioned so an invoice can be
 * regenerated years later against the prices that were in force when it was
 * raised, rather than against today's.
 */
export type PlanCode = 'answers' | 'starter' | 'growth' | 'command' | 'enterprise';

export type BillingInterval = 'monthly' | 'annual';

/**
 * Which event the outcome fee attaches to (Go-Live Brief F2).
 *
 * Stated as a type so that adding a third basis forces every rating path to
 * be revisited rather than silently defaulting.
 */
export type OutcomeBasis = 'confirmed' | 'assistant_reply';

/**
 * Per-unit prices in **millis of a minor unit** (thousandths of a penny).
 * Sub-penny rates are real, a text message is well under a penny, and
 * rounding once at the invoice line rather than per unit is what keeps a
 * thousand messages from drifting.
 */
export interface UsageRates {
  readonly conversationMillis: number;
  readonly voiceMinuteMillis: number;
  readonly textMessageMillis: number;
  readonly enrichmentRecordMillis: number;
  readonly companyResolutionMillis: number;
}

export interface Plan {
  readonly code: PlanCode;
  readonly name: string;
  readonly version: number;
  readonly currency: CurrencyCode;
  /** Recurring platform fee, per interval. */
  readonly platformFee: Record<BillingInterval, Money>;
  /** Credits granted at the start of each period, in minor units of value. */
  readonly includedCreditsPence: number;
  /** Charged per confirmed billable outcome, on top of credits. */
  readonly outcomeFee: Money;
  /**
   * What the outcome fee is actually charged on.
   *
   * `confirmed` bills only an outcome a human confirmed; `assistant_reply`
   * bills each substantive reply up to a cap. The difference is material to
   * both margin and the contract, so it is a property of the plan rather than
   * a deployment setting: an invoice has to be reproducible from the plan
   * version that was in force when it was raised.
   */
  readonly outcomeBasis: OutcomeBasis;
  /**
   * Cap on billable replies per conversation under `assistant_reply` basis.
   * A runaway loop must not be able to bill a customer without limit.
   * Undefined means uncapped, which `worstCaseConversationCost` reports
   * honestly rather than implying a bound that does not exist.
   */
  readonly billableRepliesPerConversation?: number;
  readonly usageRates: UsageRates;
  /** How many Tier 1 / Tier 2 connectors the plan entitles. */
  readonly connectorEntitlement: { readonly tier1: number; readonly tier2: number; readonly tier3: number };
  /** Default hard spend ceiling, which the operator may raise per account. */
  readonly defaultSpendCapPence: number;
  readonly maxConcurrentVoice: number;
  readonly targetTenant: string;
}

const GBP: CurrencyCode = 'GBP';

/**
 * Annual is priced at ten months for twelve, which is the conventional two
 * months free. It is stated here rather than computed so that changing the
 * discount is a deliberate edit to a number a commercial person can read.
 */
export const PLAN_CATALOGUE: Readonly<Record<PlanCode, Plan>> = {
  /**
   * The self-serve tier: one seller, card on file, no connector.
   *
   * It is the only plan billed per reply rather than per confirmed outcome,
   * because there is no CRM to confirm an outcome in. The reply cap is what
   * makes the worst case quotable: six replies at 50p, so a conversation
   * cannot cost more than £3 however long somebody talks.
   */
  answers: {
    code: 'answers', name: 'Answers', version: 1, currency: GBP,
    platformFee: { monthly: money(999, GBP), annual: money(9_990, GBP) },
    // Ten replies at the list price, so a quiet month costs the subscription
    // and nothing else. A customer should not meet the per-reply rate for the
    // first time on their first real invoice.
    includedCreditsPence: 500,
    outcomeFee: money(50, GBP),
    outcomeBasis: 'assistant_reply',
    billableRepliesPerConversation: 6,
    usageRates: {
      conversationMillis: 40, voiceMinuteMillis: 120, textMessageMillis: 4,
      enrichmentRecordMillis: 12_000, companyResolutionMillis: 3_000,
    },
    connectorEntitlement: { tier1: 0, tier2: 0, tier3: 0 },
    defaultSpendCapPence: 5_000,
    maxConcurrentVoice: 0,
    targetTenant: 'Individual seller, self-serve',
  },
  starter: {
    code: 'starter', name: 'Starter', version: 1, currency: GBP,
    platformFee: { monthly: money(35_000, GBP), annual: money(350_000, GBP) },
    includedCreditsPence: 5_000,
    outcomeFee: money(600, GBP),
    outcomeBasis: 'confirmed',
    usageRates: {
      conversationMillis: 40, voiceMinuteMillis: 120, textMessageMillis: 4,
      enrichmentRecordMillis: 12_000, companyResolutionMillis: 3_000,
    },
    connectorEntitlement: { tier1: 1, tier2: 0, tier3: 0 },
    defaultSpendCapPence: 25_000,
    maxConcurrentVoice: 3,
    targetTenant: 'Sub-20 seat SMB',
  },
  growth: {
    code: 'growth', name: 'Growth', version: 1, currency: GBP,
    platformFee: { monthly: money(75_000, GBP), annual: money(750_000, GBP) },
    includedCreditsPence: 15_000,
    outcomeFee: money(500, GBP),
    outcomeBasis: 'confirmed',
    usageRates: {
      conversationMillis: 35, voiceMinuteMillis: 110, textMessageMillis: 4,
      enrichmentRecordMillis: 11_000, companyResolutionMillis: 2_500,
    },
    connectorEntitlement: { tier1: 99, tier2: 1, tier3: 0 },
    defaultSpendCapPence: 75_000,
    maxConcurrentVoice: 10,
    targetTenant: 'Mid-market, 20 to 100 seats',
  },
  command: {
    code: 'command', name: 'Command', version: 1, currency: GBP,
    platformFee: { monthly: money(120_000, GBP), annual: money(1_200_000, GBP) },
    includedCreditsPence: 30_000,
    outcomeFee: money(400, GBP),
    outcomeBasis: 'confirmed',
    usageRates: {
      conversationMillis: 30, voiceMinuteMillis: 100, textMessageMillis: 3,
      enrichmentRecordMillis: 10_000, companyResolutionMillis: 2_000,
    },
    connectorEntitlement: { tier1: 99, tier2: 99, tier3: 99 },
    defaultSpendCapPence: 200_000,
    maxConcurrentVoice: 25,
    targetTenant: 'Multi-entity, multi-CRM',
  },
  enterprise: {
    code: 'enterprise', name: 'Enterprise', version: 1, currency: GBP,
    // Negotiated. The zeroes are deliberate: an enterprise subscription without
    // a negotiated override is a configuration error, and `validatePlan` says so
    // rather than quietly invoicing nothing.
    platformFee: { monthly: money(0, GBP), annual: money(0, GBP) },
    includedCreditsPence: 0,
    outcomeFee: money(0, GBP),
    outcomeBasis: 'confirmed',
    usageRates: {
      conversationMillis: 0, voiceMinuteMillis: 0, textMessageMillis: 0,
      enrichmentRecordMillis: 0, companyResolutionMillis: 0,
    },
    connectorEntitlement: { tier1: 99, tier2: 99, tier3: 99 },
    defaultSpendCapPence: 1_000_000,
    maxConcurrentVoice: 100,
    targetTenant: 'Residency, white-label, reseller',
  },
};

/**
 * A per-account override of any plan field. Enterprise deals are the reason
 * this exists, but it is also how a retention discount or a pilot rate is
 * expressed, always as a recorded override with a reason, never by editing the
 * catalogue underneath other accounts.
 */
export interface PlanOverride {
  readonly platformFee?: Partial<Record<BillingInterval, Money>>;
  readonly includedCreditsPence?: number;
  readonly outcomeFee?: Money;
  readonly usageRates?: Partial<UsageRates>;
  readonly defaultSpendCapPence?: number;
  readonly maxConcurrentVoice?: number;
  /** Why this account is not on list price. Required, and shown in the console. */
  readonly reason: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export function effectivePlan(plan: Plan, override?: PlanOverride): Plan {
  if (!override) return plan;
  return {
    ...plan,
    platformFee: { ...plan.platformFee, ...override.platformFee },
    includedCreditsPence: override.includedCreditsPence ?? plan.includedCreditsPence,
    outcomeFee: override.outcomeFee ?? plan.outcomeFee,
    usageRates: { ...plan.usageRates, ...override.usageRates },
    defaultSpendCapPence: override.defaultSpendCapPence ?? plan.defaultSpendCapPence,
    maxConcurrentVoice: override.maxConcurrentVoice ?? plan.maxConcurrentVoice,
  };
}

/**
 * Refuse a plan that would invoice nothing. An enterprise account with no
 * negotiated override is the single most likely way this system silently fails
 * to bill someone, so it is checked rather than assumed.
 */
export function validatePlan(plan: Plan, interval: BillingInterval): string[] {
  const problems: string[] = [];
  if (plan.platformFee[interval].amount <= 0) {
    problems.push(`${plan.name} has no ${interval} platform fee. An enterprise account needs a negotiated override before it can be invoiced.`);
  }
  const rates = Object.values(plan.usageRates);
  if (rates.every((rate) => rate === 0) && plan.includedCreditsPence === 0) {
    problems.push(`${plan.name} has no usage rates and no included credits, so consumption would never be charged.`);
  }
  return problems;
}
