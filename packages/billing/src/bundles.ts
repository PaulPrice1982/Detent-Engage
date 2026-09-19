import { AwaError } from '@detent/awa-core';
import { money, type CurrencyCode, type Money } from './money.js';

/**
 * Outcome credit bundles.
 *
 * On the per-reply plan, credits are what replies are paid for out of. The
 * subscription buys access and a small starting balance; a customer who is
 * actually being used buys bundles.
 *
 * Bundles are sold at a discount that grows with size, which is the ordinary
 * shape and does two useful things: it rewards commitment, and it means the
 * customer who uses the product most has the lowest marginal cost, so the
 * account least likely to churn is also the one least likely to feel
 * overcharged.
 *
 * The list price per reply is the plan's outcome fee. A bundle never prices
 * *above* it: a bundle that costs more per reply than paying as you go is a
 * trap, and a customer who spots one stops trusting the pricing page.
 */

export interface CreditBundle {
  readonly code: string;
  readonly name: string;
  /** Replies this bundle pays for, at the plan's list price. */
  readonly replies: number;
  /** What the customer pays. */
  readonly price: Money;
  /** Shown on the pricing page, computed rather than typed. */
  readonly effectivePencePerReply: number;
  readonly savingPercent: number;
}

/** The list price of one reply on the self-serve plan. */
export const LIST_PENCE_PER_REPLY = 50;

interface BundleSpec {
  readonly code: string;
  readonly name: string;
  readonly replies: number;
  readonly pricePence: number;
}

const SPECS: readonly BundleSpec[] = [
  { code: 'bundle_100', name: '100 replies', replies: 100, pricePence: 5_000 },
  { code: 'bundle_500', name: '500 replies', replies: 500, pricePence: 22_500 },
  { code: 'bundle_2000', name: '2,000 replies', replies: 2_000, pricePence: 80_000 },
  { code: 'bundle_10000', name: '10,000 replies', replies: 10_000, pricePence: 350_000 },
];

function describe(spec: BundleSpec, currency: CurrencyCode = 'GBP'): CreditBundle {
  // Rounded to the nearest tenth of a penny for display. The stored figures are
  // whole pence; this exists to be read, not to be billed against.
  const effective = Math.round((spec.pricePence / spec.replies) * 10) / 10;
  const listTotal = spec.replies * LIST_PENCE_PER_REPLY;
  return {
    code: spec.code,
    name: spec.name,
    replies: spec.replies,
    price: money(spec.pricePence, currency),
    effectivePencePerReply: effective,
    savingPercent: Math.round(((listTotal - spec.pricePence) / listTotal) * 100),
  };
}

export const CREDIT_BUNDLES: readonly CreditBundle[] = SPECS.map((spec) => describe(spec));

export function bundleByCode(code: string): CreditBundle | undefined {
  return CREDIT_BUNDLES.find((bundle) => bundle.code === code);
}

/**
 * Checks a bundle list before it is offered.
 *
 * Called on the catalogue at start-up and on anything an operator edits. Each
 * rule is here because breaking it produces a pricing page that costs more to
 * explain than the bundle earns.
 */
export function checkBundles(bundles: readonly CreditBundle[]): readonly string[] {
  const problems: string[] = [];
  for (const bundle of bundles) {
    if (bundle.replies <= 0) {
      problems.push(`${bundle.code} buys no replies.`);
    }
    if (bundle.price.amount <= 0) {
      problems.push(`${bundle.code} is free, which is a promotion rather than a bundle.`);
    }
    if (bundle.effectivePencePerReply > LIST_PENCE_PER_REPLY) {
      // Paying more to buy in advance is the one thing a bundle must never do.
      problems.push(
        `${bundle.code} costs ${bundle.effectivePencePerReply}p a reply, which is more than `
        + `the ${LIST_PENCE_PER_REPLY}p list price. A customer is better off not buying it.`,
      );
    }
  }
  const sorted = [...bundles].sort((left, right) => left.replies - right.replies);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.effectivePencePerReply > sorted[index - 1]!.effectivePencePerReply) {
      // Bigger must not be dearer per reply, or the page argues against itself.
      problems.push(
        `${sorted[index]!.code} is larger than ${sorted[index - 1]!.code} but costs more per `
        + 'reply. Bundles must get cheaper as they get bigger.',
      );
    }
  }
  return problems;
}

/**
 * The credit value a bundle grants, in minor units.
 *
 * A bundle is sold as replies and granted as *value*, at the list price rather
 * than at the discounted price. That is the point of the discount: 500 replies
 * bought for £225 grant £250 of credit, and the customer gets what they were
 * sold rather than what they paid.
 */
export function creditValueOf(bundle: CreditBundle): Money {
  return money(bundle.replies * LIST_PENCE_PER_REPLY, bundle.price.currency);
}

export function assertSellable(bundle: CreditBundle): void {
  const problems = checkBundles([bundle]);
  if (problems.length > 0) {
    throw new AwaError({ kind: 'SCHEMA_INVALID', message: problems[0]! });
  }
}
