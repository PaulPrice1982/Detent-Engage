import type { UsageRecord } from '@detent/awa-policy';
import { add, money, rateAtMillis, sum, zero, type CurrencyCode, type Money } from './money.js';
import type { BillingInterval, Plan } from './plans.js';

/**
 * Rating: usage counters become priced lines.
 *
 * The single rule this module exists to enforce is that **rating reads the same
 * counters the tenant reads**. There is no separate billing tally. An invoice a
 * customer cannot reconcile against the usage page they were shown all month is
 * a dispute waiting to be had, and the customer is right to have it.
 *
 * Everything here is pure: counters and a plan in, lines out. Nothing is
 * written, no credit is spent, no invoice is raised. That keeps a rating run
 * repeatable: the same period rates identically however many times it is
 * computed, which is what makes a disputed invoice answerable.
 */

/** What a line is for. Drives presentation and, for credits, applicability. */
export type LineKind =
  /** Recurring platform fee. Not covered by credits. */
  | 'platform'
  /** Metered consumption. Covered by credits. */
  | 'usage'
  /** Per confirmed billable outcome. Covered by credits. */
  | 'outcome'
  /** A discount or correction applied at rating time. */
  | 'adjustment';

export interface RatedLine {
  /** Stable machine code. Safe to key on; the description is not. */
  readonly code: string;
  readonly description: string;
  readonly kind: LineKind;
  readonly quantity: number;
  /**
   * Unit price in millis of a minor unit, or undefined for a line that is not
   * priced per unit (a platform fee). Kept so an invoice can show its working.
   */
  readonly unitRateMillis?: number;
  readonly amount: Money;
}

export interface RatedUsage {
  readonly tenantId: string;
  readonly period: string;
  readonly currency: CurrencyCode;
  readonly planCode: string;
  readonly planVersion: number;
  readonly lines: readonly RatedLine[];
  /** Lines a credit balance may be spent against. */
  readonly creditableTotal: Money;
  /** Lines credits may not touch: the platform fee. */
  readonly nonCreditableTotal: Money;
  readonly total: Money;
}

export interface RatingOptions {
  /** Include the recurring platform fee. False when rating mid-period usage. */
  readonly includePlatformFee?: boolean;
  readonly interval?: BillingInterval;
  /** Applied after usage, e.g. a negotiated credit. Negative amounts allowed. */
  readonly adjustments?: readonly Omit<RatedLine, 'kind'>[];
}

/**
 * Prices one period's usage.
 *
 * Each line rounds once, at the line, from a millis rate, never per unit.
 * Rounding per unit is how a thousand text messages at 0.4p drift into a figure
 * neither party can reproduce.
 */
export function rateUsage(usage: UsageRecord, plan: Plan, options: RatingOptions = {}): RatedUsage {
  const currency = plan.currency;
  const rates = plan.usageRates;
  const lines: RatedLine[] = [];

  if (options.includePlatformFee) {
    const interval = options.interval ?? 'monthly';
    lines.push({
      code: 'platform_fee',
      description: `${plan.name} platform fee (${interval})`,
      kind: 'platform',
      quantity: 1,
      amount: plan.platformFee[interval],
    });
  }

  const metered: readonly (readonly [string, string, number, number])[] = [
    ['conversations', 'Conversations', usage.conversations, rates.conversationMillis],
    ['voice_minutes', 'Voice minutes', usage.voiceMinutes, rates.voiceMinuteMillis],
    ['text_messages', 'Text messages', usage.textMessages, rates.textMessageMillis],
    ['enrichment_records', 'Enrichment records', usage.enrichmentRecords, rates.enrichmentRecordMillis],
    ['company_resolutions', 'Company resolutions', usage.companyResolutions, rates.companyResolutionMillis],
  ];

  for (const [code, description, quantity, rateMillis] of metered) {
    // A zero-quantity line is omitted, but a zero-rate line with quantity is
    // kept and shown at nil: the customer used something, and silently dropping
    // it makes the invoice disagree with the usage page.
    if (quantity <= 0) continue;
    lines.push({
      code,
      description,
      kind: 'usage',
      quantity,
      unitRateMillis: rateMillis,
      amount: rateAtMillis(rateMillis, quantity, currency),
    });
  }

  if (usage.qualifiedOutcomes > 0) {
    lines.push({
      code: 'qualified_outcomes',
      description: 'Confirmed billable outcomes',
      kind: 'outcome',
      quantity: usage.qualifiedOutcomes,
      unitRateMillis: plan.outcomeFee.amount * 1000,
      amount: money(plan.outcomeFee.amount * usage.qualifiedOutcomes, currency),
    });
  }

  for (const adjustment of options.adjustments ?? []) {
    lines.push({ ...adjustment, kind: 'adjustment' });
  }

  // Credits buy consumption and outcomes. They do not buy the subscription:
  // letting a credit grant erase the platform fee turns a goodwill gesture into
  // an unbudgeted discount on recurring revenue.
  const creditable = lines.filter((line) => line.kind === 'usage' || line.kind === 'outcome');
  const nonCreditable = lines.filter((line) => line.kind === 'platform' || line.kind === 'adjustment');

  return {
    tenantId: usage.tenantId,
    period: usage.period,
    currency,
    planCode: plan.code,
    planVersion: plan.version,
    lines,
    creditableTotal: sum(creditable.map((line) => line.amount), currency),
    nonCreditableTotal: sum(nonCreditable.map((line) => line.amount), currency),
    total: sum(lines.map((line) => line.amount), currency),
  };
}

/**
 * Cost of goods for the same period, from the metering service's own accrual.
 *
 * Kept beside rating so margin is computable from one place. `spendPence` is
 * what the meter accrued as it went; it is the operator's number, never shown
 * to the tenant.
 */
export function costOfGoods(usage: UsageRecord, currency: CurrencyCode = 'GBP'): Money {
  return money(Math.round(usage.spendPence), currency);
}

/** Revenue less cost of goods for the period. Negative is a loss-making tenant. */
export function grossMargin(rated: RatedUsage, usage: UsageRecord): {
  readonly revenue: Money;
  readonly cost: Money;
  readonly margin: Money;
  /** Basis points of revenue, or undefined when revenue is nil. */
  readonly marginBasisPoints?: number;
} {
  const revenue = rated.total;
  const cost = costOfGoods(usage, rated.currency);
  const margin = add(revenue, { amount: -cost.amount, currency: rated.currency });
  return {
    revenue,
    cost,
    margin,
    marginBasisPoints: revenue.amount === 0
      ? undefined
      : Math.round((margin.amount / revenue.amount) * 10_000),
  };
}

/** An empty rating, for a period with no usage at all. */
export function emptyRating(tenantId: string, period: string, plan: Plan): RatedUsage {
  return {
    tenantId,
    period,
    currency: plan.currency,
    planCode: plan.code,
    planVersion: plan.version,
    lines: [],
    creditableTotal: zero(plan.currency),
    nonCreditableTotal: zero(plan.currency),
    total: zero(plan.currency),
  };
}
