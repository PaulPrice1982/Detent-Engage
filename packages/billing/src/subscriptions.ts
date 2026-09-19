import { AwaError, newId, type Clock, systemClock } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import { allocate, money, type CurrencyCode, type Money } from './money.js';
import { PLAN_CATALOGUE, effectivePlan, validatePlan, type BillingInterval, type Plan, type PlanCode, type PlanOverride } from './plans.js';

/**
 * Subscription lifecycle.
 *
 * The states are deliberately few. Every additional state in a billing system
 * is a combination someone has to reason about at 2am during a payment
 * incident, and most "statuses" people reach for are really facts about the
 * latest invoice rather than about the subscription.
 */
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  /** Payment failed. Service continues while dunning runs. */
  | 'past_due'
  /** Dunning exhausted. Service degraded, subscription still recoverable. */
  | 'suspended'
  | 'paused'
  | 'cancelled';

const TRANSITIONS: Readonly<Record<SubscriptionStatus, readonly SubscriptionStatus[]>> = {
  trialing: ['active', 'cancelled'],
  active: ['past_due', 'paused', 'cancelled'],
  past_due: ['active', 'suspended', 'cancelled'],
  suspended: ['active', 'cancelled'],
  paused: ['active', 'cancelled'],
  cancelled: [],
};

export interface Subscription {
  readonly subscriptionId: string;
  readonly accountId: string;
  /** The tenant this subscription entitles. One tenant, one subscription. */
  readonly tenantId: string;
  status: SubscriptionStatus;
  planCode: PlanCode;
  planVersion: number;
  interval: BillingInterval;
  currency: CurrencyCode;
  override?: PlanOverride;
  /** Current billing period. Invoices are raised for a closed period. */
  periodStart: string;
  periodEnd: string;
  trialEndsAt?: string;
  cancelAt?: string;
  cancelledAt?: string;
  /** Set when the customer asked to cancel at period end rather than at once. */
  cancelAtPeriodEnd: boolean;
  readonly createdAt: string;
  updatedAt: string;
  /** Payment method reference held at the PSP. Never a card number. */
  paymentMethodRef?: string;
  readonly billingEmail: string;
  readonly billingName: string;
  readonly vatNumber?: string;
  readonly countryCode: string;
}

export interface SubscriptionStore {
  put(subscription: Subscription): Promise<void>;
  get(subscriptionId: string): Promise<Subscription | undefined>;
  byTenant(tenantId: string): Promise<Subscription | undefined>;
  list(): Promise<Subscription[]>;
}

export class InMemorySubscriptionStore implements SubscriptionStore {
  private readonly subscriptions = new Map<string, Subscription>();
  async put(subscription: Subscription): Promise<void> { this.subscriptions.set(subscription.subscriptionId, subscription); }
  async get(subscriptionId: string): Promise<Subscription | undefined> { return this.subscriptions.get(subscriptionId); }
  async byTenant(tenantId: string): Promise<Subscription | undefined> {
    return [...this.subscriptions.values()].find((subscription) => subscription.tenantId === tenantId);
  }
  async list(): Promise<Subscription[]> { return [...this.subscriptions.values()]; }
}

export interface CreateSubscriptionInput {
  readonly accountId: string;
  readonly tenantId: string;
  readonly planCode: PlanCode;
  readonly interval: BillingInterval;
  readonly billingEmail: string;
  readonly billingName: string;
  readonly countryCode: string;
  readonly vatNumber?: string;
  readonly trialDays?: number;
  readonly override?: PlanOverride;
  readonly actor: string;
  readonly correlationId: string;
}

/** A change to a live subscription, with what it will cost, before it is applied. */
export interface ChangePreview {
  readonly from: { planCode: PlanCode; interval: BillingInterval };
  readonly to: { planCode: PlanCode; interval: BillingInterval };
  /** Unused portion of the current term, credited back. */
  readonly creditForUnusedTerm: Money;
  /** Remaining portion of the new term, charged now. */
  readonly chargeForRemainingTerm: Money;
  readonly netDueNow: Money;
  readonly effectiveAt: string;
  readonly immediate: boolean;
  readonly warnings: readonly string[];
}

export class SubscriptionService {
  constructor(
    private readonly store: SubscriptionStore,
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
  ) {}

  planFor(subscription: Subscription): Plan {
    const base = PLAN_CATALOGUE[subscription.planCode];
    return effectivePlan(base, subscription.override);
  }

  async create(input: CreateSubscriptionInput): Promise<Subscription> {
    if (await this.store.byTenant(input.tenantId)) {
      throw new AwaError({ kind: 'CONFLICT', message: `tenant ${input.tenantId} already has a subscription` });
    }

    const plan = effectivePlan(PLAN_CATALOGUE[input.planCode], input.override);
    const problems = validatePlan(plan, input.interval);
    if (problems.length > 0) {
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: `cannot create this subscription: ${problems.join(' ')}`,
        details: { problems },
      });
    }

    const now = this.clock.now();
    const trialing = (input.trialDays ?? 0) > 0;
    const trialEnd = trialing
      ? new Date(now.getTime() + input.trialDays! * 86_400_000).toISOString()
      : undefined;
    const periodStart = trialEnd ?? now.toISOString();

    const subscription: Subscription = {
      subscriptionId: newId('t', this.clock.nowMs()),
      accountId: input.accountId,
      tenantId: input.tenantId,
      status: trialing ? 'trialing' : 'active',
      planCode: input.planCode,
      planVersion: PLAN_CATALOGUE[input.planCode].version,
      interval: input.interval,
      currency: plan.currency,
      override: input.override,
      periodStart,
      periodEnd: addInterval(periodStart, input.interval),
      trialEndsAt: trialEnd,
      cancelAtPeriodEnd: false,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      billingEmail: input.billingEmail,
      billingName: input.billingName,
      vatNumber: input.vatNumber,
      countryCode: input.countryCode.toUpperCase(),
    };

    await this.store.put(subscription);
    await this.record(subscription, 'subscription_created', {
      planCode: input.planCode, interval: input.interval, trialDays: input.trialDays ?? 0,
      overridden: Boolean(input.override), actor: input.actor,
    }, input.correlationId);
    return subscription;
  }

  /**
   * Preview a plan change before applying it.
   *
   * The console shows this and requires the operator to confirm the figure. A
   * plan change that silently produces an unexpected charge is the fastest way
   * to turn a routine upgrade into a chargeback.
   */
  preview(subscription: Subscription, to: { planCode: PlanCode; interval?: BillingInterval }): ChangePreview {
    const interval = to.interval ?? subscription.interval;
    const currentPlan = this.planFor(subscription);
    const nextPlan = effectivePlan(PLAN_CATALOGUE[to.planCode], subscription.override);
    const warnings: string[] = [...validatePlan(nextPlan, interval)];

    const currentFee = currentPlan.platformFee[subscription.interval];
    const nextFee = nextPlan.platformFee[interval];
    const upgrade = nextFee.amount > currentFee.amount;

    const totalMs = Date.parse(subscription.periodEnd) - Date.parse(subscription.periodStart);
    const remainingMs = Math.max(0, Date.parse(subscription.periodEnd) - this.clock.nowMs());
    const usedMs = Math.max(0, totalMs - remainingMs);

    // Proration by exact allocation, so credit and charge always reconcile to
    // the whole fee rather than drifting by a penny.
    const [, unusedShare] = allocate(currentFee, [Math.round(usedMs / 1000), Math.round(remainingMs / 1000)]);
    const [, remainingShare] = allocate(nextFee, [Math.round(usedMs / 1000), Math.round(remainingMs / 1000)]);

    const credit = unusedShare ?? money(0, subscription.currency);
    const charge = remainingShare ?? money(0, subscription.currency);

    if (!upgrade) {
      warnings.push('This is a downgrade. Connector and concurrency entitlements drop immediately; check the tenant is not relying on them.');
    }
    if (subscription.status === 'past_due' || subscription.status === 'suspended') {
      warnings.push(`This subscription is ${subscription.status}. Resolve the outstanding balance before changing the plan.`);
    }

    return {
      from: { planCode: subscription.planCode, interval: subscription.interval },
      to: { planCode: to.planCode, interval },
      creditForUnusedTerm: credit,
      chargeForRemainingTerm: charge,
      netDueNow: money(charge.amount - credit.amount, subscription.currency),
      // Upgrades take effect at once because the customer wants what they are
      // paying for; downgrades wait for the period end so nobody loses access
      // they have already paid for.
      effectiveAt: upgrade ? this.clock.iso() : subscription.periodEnd,
      immediate: upgrade,
      warnings,
    };
  }

  async changePlan(input: {
    subscriptionId: string; planCode: PlanCode; interval?: BillingInterval;
    actor: string; correlationId: string; acknowledgedNetDue: Money;
  }): Promise<{ subscription: Subscription; preview: ChangePreview }> {
    const subscription = await this.require(input.subscriptionId);
    const preview = this.preview(subscription, { planCode: input.planCode, interval: input.interval });

    // The operator confirmed a figure; if it has moved since, refuse rather than
    // charge a number nobody agreed to.
    if (preview.netDueNow.amount !== input.acknowledgedNetDue.amount) {
      throw new AwaError({
        kind: 'CONFLICT',
        message: `the net amount changed from ${input.acknowledgedNetDue.amount} to ${preview.netDueNow.amount} since the preview; re-check and confirm again`,
      });
    }

    if (preview.immediate) {
      subscription.planCode = input.planCode;
      subscription.planVersion = PLAN_CATALOGUE[input.planCode].version;
      subscription.interval = preview.to.interval;
    }
    subscription.updatedAt = this.clock.iso();
    await this.store.put(subscription);

    await this.record(subscription, 'subscription_plan_changed', {
      from: preview.from, to: preview.to, immediate: preview.immediate,
      netDuePence: preview.netDueNow.amount, actor: input.actor,
    }, input.correlationId);

    return { subscription, preview };
  }

  async transition(input: {
    subscriptionId: string; to: SubscriptionStatus; reason: string; actor: string; correlationId: string;
  }): Promise<Subscription> {
    const subscription = await this.require(input.subscriptionId);
    if (subscription.status === input.to) return subscription;
    if (!TRANSITIONS[subscription.status].includes(input.to)) {
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message: `illegal subscription transition ${subscription.status} -> ${input.to}`,
      });
    }
    const from = subscription.status;
    subscription.status = input.to;
    subscription.updatedAt = this.clock.iso();
    if (input.to === 'cancelled') subscription.cancelledAt = this.clock.iso();
    await this.store.put(subscription);

    await this.record(subscription, 'subscription_status_changed', {
      from, to: input.to, reason: input.reason, actor: input.actor,
    }, input.correlationId);
    return subscription;
  }

  /**
   * Cancel. Defaults to the end of the paid period, because cancelling
   * immediately takes away service the customer has already paid for and then
   * obliges us to refund it, two operations where one would do.
   */
  async cancel(input: {
    subscriptionId: string; immediate?: boolean; reason: string; actor: string; correlationId: string;
  }): Promise<Subscription> {
    const subscription = await this.require(input.subscriptionId);
    if (input.immediate) {
      return this.transition({ ...input, to: 'cancelled' });
    }
    subscription.cancelAtPeriodEnd = true;
    subscription.cancelAt = subscription.periodEnd;
    subscription.updatedAt = this.clock.iso();
    await this.store.put(subscription);
    await this.record(subscription, 'subscription_cancel_scheduled', {
      cancelAt: subscription.periodEnd, reason: input.reason, actor: input.actor,
    }, input.correlationId);
    return subscription;
  }

  /** Roll the period forward after a successful invoice. */
  async advancePeriod(subscriptionId: string, correlationId: string): Promise<Subscription> {
    const subscription = await this.require(subscriptionId);
    if (subscription.cancelAtPeriodEnd) {
      return this.transition({
        subscriptionId, to: 'cancelled',
        reason: 'Scheduled cancellation reached the period end', actor: 'system', correlationId,
      });
    }
    subscription.periodStart = subscription.periodEnd;
    subscription.periodEnd = addInterval(subscription.periodStart, subscription.interval);
    subscription.updatedAt = this.clock.iso();
    await this.store.put(subscription);
    return subscription;
  }

  async byTenant(tenantId: string): Promise<Subscription | undefined> { return this.store.byTenant(tenantId); }
  async list(): Promise<Subscription[]> { return this.store.list(); }

  private async require(subscriptionId: string): Promise<Subscription> {
    const subscription = await this.store.get(subscriptionId);
    if (!subscription) {
      throw new AwaError({ kind: 'NOT_FOUND', message: `subscription ${subscriptionId} not found` });
    }
    return subscription;
  }

  private async record(subscription: Subscription, change: string, payload: Record<string, unknown>, correlationId: string): Promise<void> {
    await this.audit.write({
      tenantId: subscription.tenantId, type: 'policy_allowed', correlationId,
      actor: 'platform_admin', payload: { change, subscriptionId: subscription.subscriptionId, ...payload },
    });
  }
}

/**
 * Add a billing interval, clamping the day of month.
 *
 * The 31st of January plus one month is the 28th or 29th of February, not the
 * 2nd or 3rd of March. Getting this wrong bills people twice in a short month,
 * which is the sort of bug that reaches a regulator rather than a support desk.
 */
export function addInterval(fromIso: string, interval: BillingInterval): string {
  const from = new Date(fromIso);
  const months = interval === 'annual' ? 12 : 1;
  const day = from.getUTCDate();
  const target = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, 1,
    from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds()));
  const daysInTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, daysInTarget));
  return target.toISOString();
}
