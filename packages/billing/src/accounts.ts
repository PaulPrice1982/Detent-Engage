import { randomBytes } from 'node:crypto';
import { AwaError, type Clock, systemClock } from '@detent/awa-core';
import { money, type Money } from './money.js';
import { PLAN_CATALOGUE, type BillingInterval, type PlanCode } from './plans.js';

/**
 * Accounts, contract terms and the limits a subscription actually carries.
 *
 * A subscription is more than a plan code and a price. The questions an
 * operator is asked on a support call are: when does this renew, when is the
 * next invoice, how long is the term, how much notice do they have to give, and
 * what are they allowed to use. Those are contract facts. If the console cannot
 * answer them the operator opens the signed PDF, and at that point the system
 * is not the source of truth for its own commercial terms.
 *
 * The distinction that matters here, and that most billing models blur:
 *
 *  - the **term** is what was contracted, twelve months, say, with notice
 *  - the **billing period** is how often an invoice is raised inside it
 *
 * A twelve-month term billed monthly renews once a year and invoices twelve
 * times. Conflating the two is how a customer gets a cancellation honoured that
 * they were not entitled to, or is held to a term that had already lapsed.
 */

export type AccountStatus = 'prospect' | 'active' | 'suspended' | 'closed';

export interface Account {
  readonly accountId: string;
  readonly name: string;
  /** The tenant this account owns. One account, one tenant. */
  readonly tenantId: string;
  readonly status: AccountStatus;
  readonly billingEmail: string;
  readonly billingName?: string;
  readonly vatNumber?: string;
  readonly countryCode: string;
  readonly addressLines?: readonly string[];
  readonly postcode?: string;
  /** Detent's own owner for the relationship. */
  readonly accountManager?: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly closedAt?: string;
  readonly notes?: string;
}

/** How long the customer is committed for. */
export type ContractTerm =
  /** No commitment; cancellable at the end of any billing period. */
  | 'rolling_monthly'
  | 'twelve_months'
  | 'twenty_four_months'
  | 'thirty_six_months';

export const TERM_MONTHS: Readonly<Record<ContractTerm, number>> = {
  rolling_monthly: 1,
  twelve_months: 12,
  twenty_four_months: 24,
  thirty_six_months: 36,
};

/**
 * What a subscription entitles the customer to, per billing period.
 *
 * Zero means none; undefined means unmetered. They are different, and treating
 * a missing limit as zero is how a customer who bought unlimited voice is cut
 * off on day one.
 */
export interface SubscriptionLimits {
  readonly seats?: number;
  readonly conversationsPerPeriod?: number;
  readonly voiceMinutesPerPeriod?: number;
  readonly textMessagesPerPeriod?: number;
  readonly enrichmentRecordsPerPeriod?: number;
  readonly connectorsTier1?: number;
  readonly connectorsTier2?: number;
  readonly connectorsTier3?: number;
  readonly maxConcurrentVoice?: number;
  /** Hard ceiling on cost of goods before the assistant stops spending. */
  readonly spendCap: Money;
}

export interface ContractTerms {
  readonly term: ContractTerm;
  /** When the commitment started. */
  readonly startDate: string;
  /** When the current term ends and renewal is decided. */
  readonly renewalDate: string;
  /** How often an invoice is raised inside the term. */
  readonly billingInterval: BillingInterval;
  /** Day of month invoices are raised. Clamped for short months. */
  readonly billingDay: number;
  readonly nextBillingDate: string;
  /** Days before renewal by which notice must be given. */
  readonly noticePeriodDays: number;
  readonly autoRenew: boolean;
  /** Uplift applied at renewal, in basis points. 500 = 5%. */
  readonly renewalUpliftBasisPoints?: number;
  /** Recorded when the customer gives notice. */
  readonly noticeGivenAt?: string;
  readonly noticeGivenBy?: string;
}

export interface AccountSubscription {
  readonly subscriptionId: string;
  readonly accountId: string;
  readonly tenantId: string;
  readonly planCode: PlanCode;
  readonly planVersion: number;
  readonly terms: ContractTerms;
  readonly limits: SubscriptionLimits;
  /** Credits granted at the start of every billing period. */
  readonly monthlyCreditsPence: number;
  /** Contracted price, which may differ from the catalogue after negotiation. */
  readonly contractedPlatformFee: Money;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface AccountStore {
  get(accountId: string): Promise<Account | undefined>;
  findByTenant(tenantId: string): Promise<Account | undefined>;
  put(account: Account): Promise<void>;
  list(): Promise<readonly Account[]>;
  getSubscription(accountId: string): Promise<AccountSubscription | undefined>;
  putSubscription(subscription: AccountSubscription): Promise<void>;
}

export class InMemoryAccountStore implements AccountStore {
  private readonly accounts = new Map<string, Account>();
  private readonly subscriptions = new Map<string, AccountSubscription>();

  async get(accountId: string): Promise<Account | undefined> { return this.accounts.get(accountId); }
  async findByTenant(tenantId: string): Promise<Account | undefined> {
    return [...this.accounts.values()].find((account) => account.tenantId === tenantId);
  }
  async put(account: Account): Promise<void> { this.accounts.set(account.accountId, account); }
  async list(): Promise<readonly Account[]> {
    return [...this.accounts.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  async getSubscription(accountId: string): Promise<AccountSubscription | undefined> {
    return this.subscriptions.get(accountId);
  }
  async putSubscription(subscription: AccountSubscription): Promise<void> {
    this.subscriptions.set(subscription.accountId, subscription);
  }
}

/**
 * Adds months, clamping the day.
 *
 * The 31st plus one month is the 28th of February, not the 3rd of March.
 * Rolling over is how a customer billed on the 31st of January is billed twice
 * in March and complains, correctly.
 */
export function addMonths(fromIso: string, months: number, day?: number): string {
  const from = new Date(fromIso);
  const targetMonth = from.getUTCMonth() + months;
  const year = from.getUTCFullYear() + Math.floor(targetMonth / 12);
  const month = ((targetMonth % 12) + 12) % 12;
  const wanted = day ?? from.getUTCDate();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const safeDay = Math.min(wanted, lastDay);
  return new Date(Date.UTC(
    year, month, safeDay,
    from.getUTCHours(), from.getUTCMinutes(), from.getUTCSeconds(), from.getUTCMilliseconds(),
  )).toISOString();
}

/** Limits taken from the plan, as the starting point before negotiation. */
export function defaultLimitsFor(planCode: PlanCode): SubscriptionLimits {
  const plan = PLAN_CATALOGUE[planCode];
  return {
    connectorsTier1: plan.connectorEntitlement.tier1,
    connectorsTier2: plan.connectorEntitlement.tier2,
    connectorsTier3: plan.connectorEntitlement.tier3,
    maxConcurrentVoice: plan.maxConcurrentVoice,
    spendCap: money(plan.defaultSpendCapPence, plan.currency),
  };
}

export interface CreateAccountInput {
  readonly name: string;
  readonly tenantId: string;
  readonly billingEmail: string;
  readonly countryCode: string;
  readonly billingName?: string;
  readonly vatNumber?: string;
  readonly accountManager?: string;
  readonly notes?: string;
  readonly createdBy: string;
}

export interface StartSubscriptionInput {
  readonly accountId: string;
  readonly planCode: PlanCode;
  readonly term: ContractTerm;
  readonly billingInterval: BillingInterval;
  readonly startDate: string;
  readonly billingDay?: number;
  readonly noticePeriodDays?: number;
  readonly autoRenew?: boolean;
  readonly renewalUpliftBasisPoints?: number;
  readonly limits?: Partial<SubscriptionLimits>;
  readonly monthlyCreditsPence?: number;
  readonly contractedPlatformFee?: Money;
  readonly createdBy: string;
}

export class AccountService {
  constructor(
    private readonly store: AccountStore,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: CreateAccountInput): Promise<Account> {
    if (!input.name.trim()) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'An account needs a name.' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.billingEmail)) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'A valid billing email is required.' });
    }
    if (!/^[A-Z]{2}$/.test(input.countryCode)) {
      // The country decides the VAT treatment, so a wrong or missing one is a
      // tax error rather than a cosmetic one.
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'Country must be a two-letter ISO code.' });
    }
    if (await this.store.findByTenant(input.tenantId)) {
      throw new AwaError({ kind: 'CONFLICT', message: 'That tenant already belongs to an account.' });
    }

    const account: Account = {
      accountId: `acc_${randomBytes(8).toString('base64url')}`,
      name: input.name.trim(),
      tenantId: input.tenantId,
      // New accounts start as prospects. An account becomes active when a
      // subscription starts, not when someone types a name into a form.
      status: 'prospect',
      billingEmail: input.billingEmail.trim().toLowerCase(),
      billingName: input.billingName,
      vatNumber: input.vatNumber,
      countryCode: input.countryCode.toUpperCase(),
      accountManager: input.accountManager,
      createdAt: this.clock.iso(),
      createdBy: input.createdBy,
      notes: input.notes,
    };
    await this.store.put(account);
    return account;
  }

  /** Starts a subscription and moves the account to active. */
  async startSubscription(input: StartSubscriptionInput): Promise<AccountSubscription> {
    const account = await this.store.get(input.accountId);
    if (!account) throw new AwaError({ kind: 'NOT_FOUND', message: 'No such account.' });
    if (await this.store.getSubscription(input.accountId)) {
      throw new AwaError({ kind: 'CONFLICT', message: 'This account already has a subscription.' });
    }
    const plan = PLAN_CATALOGUE[input.planCode];
    const billingDay = input.billingDay ?? new Date(input.startDate).getUTCDate();
    if (billingDay < 1 || billingDay > 28) {
      // Capped at 28 so the date exists in February. A billing day of 31 is a
      // date that does not exist in seven months of the year.
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: 'Billing day must be between 1 and 28, so it exists in every month.',
      });
    }

    const termMonths = TERM_MONTHS[input.term];
    const terms: ContractTerms = {
      term: input.term,
      startDate: input.startDate,
      renewalDate: addMonths(input.startDate, termMonths),
      billingInterval: input.billingInterval,
      billingDay,
      nextBillingDate: addMonths(input.startDate, input.billingInterval === 'annual' ? 12 : 1, billingDay),
      // Ninety days is the common enterprise default and is deliberately
      // explicit: a notice period nobody recorded is a notice period the
      // customer will say was thirty.
      noticePeriodDays: input.noticePeriodDays ?? (input.term === 'rolling_monthly' ? 30 : 90),
      autoRenew: input.autoRenew ?? true,
      renewalUpliftBasisPoints: input.renewalUpliftBasisPoints,
    };

    const subscription: AccountSubscription = {
      subscriptionId: `sub_${randomBytes(8).toString('base64url')}`,
      accountId: input.accountId,
      tenantId: account.tenantId,
      planCode: input.planCode,
      planVersion: plan.version,
      terms,
      limits: { ...defaultLimitsFor(input.planCode), ...input.limits },
      monthlyCreditsPence: input.monthlyCreditsPence ?? plan.includedCreditsPence,
      contractedPlatformFee: input.contractedPlatformFee ?? plan.platformFee[input.billingInterval],
      createdAt: this.clock.iso(),
      createdBy: input.createdBy,
    };
    await this.store.putSubscription(subscription);
    await this.store.put({ ...account, status: 'active' });
    return subscription;
  }

  /** Advances the billing date after an invoice is raised. */
  async advanceBilling(accountId: string): Promise<AccountSubscription> {
    const subscription = await this.requireSubscription(accountId);
    const { terms } = subscription;
    const months = terms.billingInterval === 'annual' ? 12 : 1;
    const updated: AccountSubscription = {
      ...subscription,
      terms: {
        ...terms,
        nextBillingDate: addMonths(terms.nextBillingDate, months, terms.billingDay),
      },
    };
    await this.store.putSubscription(updated);
    return updated;
  }

  /** Rolls the term forward at renewal, applying any agreed uplift. */
  async renew(accountId: string): Promise<AccountSubscription> {
    const subscription = await this.requireSubscription(accountId);
    const { terms } = subscription;
    if (!terms.autoRenew) {
      throw new AwaError({ kind: 'CONFLICT', message: 'This subscription does not auto-renew.' });
    }
    if (terms.noticeGivenAt) {
      throw new AwaError({ kind: 'CONFLICT', message: 'Notice has been given; this term does not renew.' });
    }
    const uplift = terms.renewalUpliftBasisPoints ?? 0;
    const updated: AccountSubscription = {
      ...subscription,
      terms: {
        ...terms,
        startDate: terms.renewalDate,
        renewalDate: addMonths(terms.renewalDate, TERM_MONTHS[terms.term]),
      },
      contractedPlatformFee: uplift === 0
        ? subscription.contractedPlatformFee
        : money(
            Math.round(subscription.contractedPlatformFee.amount * (10_000 + uplift) / 10_000),
            subscription.contractedPlatformFee.currency,
          ),
    };
    await this.store.putSubscription(updated);
    return updated;
  }

  /**
   * Records notice to terminate.
   *
   * Refuses notice given too late for the current term and says when the
   * deadline was. Accepting late notice quietly is how a term is cancelled that
   * the customer was still committed to.
   */
  async giveNotice(accountId: string, by: string): Promise<{
    readonly subscription: AccountSubscription;
    readonly effectiveDate: string;
    readonly inTimeForThisTerm: boolean;
  }> {
    const subscription = await this.requireSubscription(accountId);
    const { terms } = subscription;
    const now = this.clock.iso();
    const deadline = new Date(
      Date.parse(terms.renewalDate) - terms.noticePeriodDays * 86_400_000,
    ).toISOString();
    const inTime = now <= deadline;
    const effectiveDate = inTime
      ? terms.renewalDate
      : addMonths(terms.renewalDate, TERM_MONTHS[terms.term]);

    const updated: AccountSubscription = {
      ...subscription,
      terms: { ...terms, noticeGivenAt: now, noticeGivenBy: by, autoRenew: false },
    };
    await this.store.putSubscription(updated);
    return { subscription: updated, effectiveDate, inTimeForThisTerm: inTime };
  }

  async setLimits(accountId: string, limits: Partial<SubscriptionLimits>): Promise<AccountSubscription> {
    const subscription = await this.requireSubscription(accountId);
    const updated = { ...subscription, limits: { ...subscription.limits, ...limits } };
    await this.store.putSubscription(updated);
    return updated;
  }

  async get(accountId: string): Promise<Account | undefined> { return this.store.get(accountId); }
  async byTenant(tenantId: string): Promise<Account | undefined> { return this.store.findByTenant(tenantId); }
  async list(): Promise<readonly Account[]> { return this.store.list(); }
  async subscription(accountId: string): Promise<AccountSubscription | undefined> {
    return this.store.getSubscription(accountId);
  }

  private async requireSubscription(accountId: string): Promise<AccountSubscription> {
    const subscription = await this.store.getSubscription(accountId);
    if (!subscription) {
      throw new AwaError({ kind: 'NOT_FOUND', message: 'This account has no subscription.' });
    }
    return subscription;
  }
}

/** Days until a date, negative if it has passed. */
export function daysUntil(iso: string, nowIso: string): number {
  return Math.ceil((Date.parse(iso) - Date.parse(nowIso)) / 86_400_000);
}

/** Whether the notice deadline for the current term has passed. */
export function noticeDeadline(terms: ContractTerms): string {
  return new Date(Date.parse(terms.renewalDate) - terms.noticePeriodDays * 86_400_000).toISOString();
}
