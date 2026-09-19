import { AwaError, type Clock, systemClock } from '@detent/awa-core';
import { money, type CurrencyCode, type Money } from './money.js';
import {
  PLAN_CATALOGUE, validatePlan,
  type BillingInterval, type Plan, type PlanCode, type UsageRates,
} from './plans.js';

/**
 * The editable plan catalogue.
 *
 * Package options, credit volumes and prices are commercial settings, not
 * constants in a source file. Changing a price should not require a deploy , 
 * but it must not do the thing that changing a price naively always does:
 *
 *   **A price change must never alter what an existing customer pays.**
 *
 * Every subscription pins the plan *version* it was sold on and the fee it was
 * contracted at. Publishing a new version changes what the next customer is
 * offered and nothing else. A customer moves to new terms only by a deliberate
 * plan change or at renewal with an agreed uplift, never because someone
 * edited a number in the console.
 *
 * Versions are immutable once published, for the same reason invoices are: the
 * question "what were we selling in March, and at what price" has to be
 * answerable a year later, in a dispute, from the system rather than from
 * memory.
 */

export type PlanVersionState = 'draft' | 'published' | 'withdrawn';

export interface PlanVersion {
  readonly planCode: PlanCode;
  readonly version: number;
  readonly state: PlanVersionState;
  readonly name: string;
  readonly currency: CurrencyCode;
  readonly platformFee: Record<BillingInterval, Money>;
  /**
   * Charged once, when the account is activated.
   *
   * Separate from the recurring fee because it behaves differently in every
   * way that matters: it is not prorated, not refunded on downgrade, not
   * included in an annual discount, and it is recognised at a different time.
   */
  readonly activationFee: Money;
  readonly includedCreditsPence: number;
  readonly outcomeFee: Money;
  /** What the outcome fee is charged on. See Plan.outcomeBasis. */
  readonly outcomeBasis: 'assistant_reply' | 'confirmed';
  readonly billableRepliesPerConversation?: number;
  readonly usageRates: UsageRates;
  readonly connectorEntitlement: { readonly tier1: number; readonly tier2: number; readonly tier3: number };
  readonly defaultSpendCapPence: number;
  readonly maxConcurrentVoice: number;
  readonly targetTenant: string;
  /** Shown on the customer's plan picker. Empty hides the plan from self-service. */
  readonly publicDescription?: string;
  /** Whether a customer may select this themselves, or only be sold it. */
  readonly selfServiceAvailable: boolean;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly publishedAt?: string;
  readonly publishedBy?: string;
  readonly withdrawnAt?: string;
  /** Why this version exists. Read a year later in a pricing review. */
  readonly changeNote: string;
}

export interface PlanCatalogueStore {
  get(planCode: PlanCode, version: number): Promise<PlanVersion | undefined>;
  put(version: PlanVersion): Promise<void>;
  listVersions(planCode: PlanCode): Promise<readonly PlanVersion[]>;
  listAll(): Promise<readonly PlanVersion[]>;
}

export class InMemoryPlanCatalogueStore implements PlanCatalogueStore {
  private readonly versions = new Map<string, PlanVersion>();
  private key(planCode: string, version: number): string { return `${planCode}:${version}`; }

  async get(planCode: PlanCode, version: number): Promise<PlanVersion | undefined> {
    return this.versions.get(this.key(planCode, version));
  }
  async put(version: PlanVersion): Promise<void> {
    this.versions.set(this.key(version.planCode, version.version), version);
  }
  async listVersions(planCode: PlanCode): Promise<readonly PlanVersion[]> {
    return [...this.versions.values()]
      .filter((version) => version.planCode === planCode)
      .sort((a, b) => b.version - a.version);
  }
  async listAll(): Promise<readonly PlanVersion[]> {
    return [...this.versions.values()].sort((a, b) =>
      a.planCode.localeCompare(b.planCode) || b.version - a.version);
  }
}

/** The catalogue in code, as version 1 of each plan. The starting point. */
export function seedFromCode(createdBy = 'system'): readonly PlanVersion[] {
  const at = '2026-01-01T00:00:00.000Z';
  return (Object.keys(PLAN_CATALOGUE) as PlanCode[]).map((code) => {
    const plan = PLAN_CATALOGUE[code];
    return {
      planCode: code,
      version: 1,
      state: 'published' as const,
      name: plan.name,
      currency: plan.currency,
      platformFee: plan.platformFee,
      // No activation fee on the seeded versions: introducing one is a
      // commercial decision, and defaulting it to a number nobody chose would
      // start charging customers for something nobody agreed.
      activationFee: money(0, plan.currency),
      includedCreditsPence: plan.includedCreditsPence,
      outcomeFee: plan.outcomeFee,
      outcomeBasis: plan.outcomeBasis,
      billableRepliesPerConversation: plan.billableRepliesPerConversation,
      usageRates: plan.usageRates,
      connectorEntitlement: plan.connectorEntitlement,
      defaultSpendCapPence: plan.defaultSpendCapPence,
      maxConcurrentVoice: plan.maxConcurrentVoice,
      targetTenant: plan.targetTenant,
      selfServiceAvailable: code === 'starter' || code === 'growth',
      createdAt: at,
      createdBy,
      publishedAt: at,
      publishedBy: createdBy,
      changeNote: 'Initial catalogue.',
    };
  });
}

export interface PlanEdit {
  readonly name?: string;
  readonly platformFeeMonthly?: Money;
  readonly platformFeeAnnual?: Money;
  readonly activationFee?: Money;
  readonly includedCreditsPence?: number;
  readonly outcomeFee?: Money;
  readonly outcomeBasis?: 'assistant_reply' | 'confirmed';
  readonly billableRepliesPerConversation?: number;
  readonly usageRates?: Partial<UsageRates>;
  readonly connectorEntitlement?: Partial<{ tier1: number; tier2: number; tier3: number }>;
  readonly defaultSpendCapPence?: number;
  readonly maxConcurrentVoice?: number;
  readonly publicDescription?: string;
  readonly selfServiceAvailable?: boolean;
  readonly targetTenant?: string;
}

export interface PriceImpact {
  readonly planCode: PlanCode;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly monthlyChange: Money;
  readonly annualChange: Money;
  readonly monthlyChangeBasisPoints: number;
  readonly creditsChange: number;
  readonly activationFeeChange: Money;
  /** Set when a change would be invisible to a reviewer skimming the form. */
  readonly warnings: readonly string[];
}

export class PlanCatalogueService {
  constructor(
    private readonly store: PlanCatalogueStore,
    private readonly clock: Clock = systemClock,
  ) {}

  async seed(createdBy = 'system'): Promise<void> {
    for (const version of seedFromCode(createdBy)) {
      if (!(await this.store.get(version.planCode, version.version))) {
        await this.store.put(version);
      }
    }
  }

  /** The version a new sale would use. */
  async current(planCode: PlanCode): Promise<PlanVersion | undefined> {
    const versions = await this.store.listVersions(planCode);
    return versions.find((version) => version.state === 'published');
  }

  /** Every plan a customer may pick themselves, cheapest first. */
  async selfServicePlans(): Promise<readonly PlanVersion[]> {
    const all = await this.store.listAll();
    const current = new Map<PlanCode, PlanVersion>();
    for (const version of all) {
      if (version.state !== 'published') continue;
      if (!current.has(version.planCode)) current.set(version.planCode, version);
    }
    return [...current.values()]
      .filter((version) => version.selfServiceAvailable)
      .sort((a, b) => a.platformFee.monthly.amount - b.platformFee.monthly.amount);
  }

  /**
   * Drafts a new version.
   *
   * Always a new version, never an edit in place. Editing a published version
   * would silently change what a signed contract referred to.
   */
  async draft(planCode: PlanCode, edit: PlanEdit, input: {
    readonly createdBy: string;
    readonly changeNote: string;
  }): Promise<PlanVersion> {
    if (!input.changeNote.trim()) {
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: 'Say why this version exists. Someone will read it in a pricing review.',
      });
    }
    const base = (await this.current(planCode)) ?? (await this.store.listVersions(planCode))[0];
    if (!base) throw new AwaError({ kind: 'NOT_FOUND', message: `No plan ${planCode}.` });

    const versions = await this.store.listVersions(planCode);
    const nextNumber = Math.max(...versions.map((version) => version.version)) + 1;

    const draft: PlanVersion = {
      ...base,
      version: nextNumber,
      state: 'draft',
      name: edit.name ?? base.name,
      platformFee: {
        monthly: edit.platformFeeMonthly ?? base.platformFee.monthly,
        annual: edit.platformFeeAnnual ?? base.platformFee.annual,
      },
      activationFee: edit.activationFee ?? base.activationFee,
      includedCreditsPence: edit.includedCreditsPence ?? base.includedCreditsPence,
      outcomeFee: edit.outcomeFee ?? base.outcomeFee,
      outcomeBasis: edit.outcomeBasis ?? base.outcomeBasis,
      billableRepliesPerConversation:
        edit.billableRepliesPerConversation ?? base.billableRepliesPerConversation,
      usageRates: { ...base.usageRates, ...edit.usageRates },
      connectorEntitlement: { ...base.connectorEntitlement, ...edit.connectorEntitlement },
      defaultSpendCapPence: edit.defaultSpendCapPence ?? base.defaultSpendCapPence,
      maxConcurrentVoice: edit.maxConcurrentVoice ?? base.maxConcurrentVoice,
      targetTenant: edit.targetTenant ?? base.targetTenant,
      publicDescription: edit.publicDescription ?? base.publicDescription,
      selfServiceAvailable: edit.selfServiceAvailable ?? base.selfServiceAvailable,
      createdAt: this.clock.iso(),
      createdBy: input.createdBy,
      publishedAt: undefined,
      publishedBy: undefined,
      withdrawnAt: undefined,
      changeNote: input.changeNote,
    };

    const problems = validatePlan(this.asPlan(draft), 'monthly');
    if (problems.length > 0) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: problems[0]! });
    }
    if (draft.platformFee.annual.amount > draft.platformFee.monthly.amount * 12) {
      // Annual costing more than twelve months is almost always a typo, and it
      // is one a customer will find before we do.
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: 'The annual price is higher than twelve monthly payments. Check it.',
      });
    }
    await this.store.put(draft);
    return draft;
  }

  /**
   * What a draft would change, in the terms a commercial person thinks in.
   *
   * Shown before publishing because a price edit is a number in a form and its
   * consequence is a percentage across a cohort. The warnings exist for the
   * changes that look small on the form and are not.
   */
  async impact(planCode: PlanCode, version: number): Promise<PriceImpact> {
    const draft = await this.require(planCode, version);
    const current = await this.current(planCode);
    if (!current) throw new AwaError({ kind: 'NOT_FOUND', message: 'No published version to compare.' });

    const monthlyChange = draft.platformFee.monthly.amount - current.platformFee.monthly.amount;
    const warnings: string[] = [];

    if (draft.includedCreditsPence < current.includedCreditsPence) {
      warnings.push(
        `Included credits fall from ${current.includedCreditsPence / 100} to ` +
        `${draft.includedCreditsPence / 100} pounds. Existing customers keep their current grant; ` +
        'new customers get less for the same money.',
      );
    }
    if (draft.activationFee.amount > current.activationFee.amount) {
      warnings.push(
        `Introduces or raises an activation fee of ${draft.activationFee.amount / 100} pounds. ` +
        'This is charged once, at sign-up, and is not prorated or refunded.',
      );
    }
    if (!draft.selfServiceAvailable && current.selfServiceAvailable) {
      warnings.push('This removes the plan from self-service sign-up. Nobody will be able to buy it online.');
    }
    if (Math.abs(monthlyChange) > current.platformFee.monthly.amount * 0.2) {
      warnings.push('That is more than a 20% price move. Confirm it is intended.');
    }
    for (const [key, rate] of Object.entries(draft.usageRates)) {
      const before = current.usageRates[key as keyof UsageRates];
      if (rate > before * 1.5 && before > 0) {
        warnings.push(`${key} rises from ${before} to ${rate} millis, more than half again.`);
      }
    }

    return {
      planCode,
      fromVersion: current.version,
      toVersion: draft.version,
      monthlyChange: money(monthlyChange, draft.currency),
      annualChange: money(
        draft.platformFee.annual.amount - current.platformFee.annual.amount, draft.currency,
      ),
      monthlyChangeBasisPoints: current.platformFee.monthly.amount === 0
        ? 0
        : Math.round((monthlyChange / current.platformFee.monthly.amount) * 10_000),
      creditsChange: draft.includedCreditsPence - current.includedCreditsPence,
      activationFeeChange: money(
        draft.activationFee.amount - current.activationFee.amount, draft.currency,
      ),
      warnings,
    };
  }

  /**
   * Publishes a draft. The previous published version is withdrawn.
   *
   * Withdrawn, not deleted: subscriptions sold on it still point at it, and
   * "what were we selling in March" must stay answerable.
   */
  async publish(planCode: PlanCode, version: number, publishedBy: string): Promise<PlanVersion> {
    const draft = await this.require(planCode, version);
    if (draft.state !== 'draft') {
      throw new AwaError({ kind: 'CONFLICT', message: `That version is ${draft.state}, not a draft.` });
    }
    const current = await this.current(planCode);
    if (current && current.version === version) {
      throw new AwaError({ kind: 'CONFLICT', message: 'That version is already published.' });
    }
    if (current) {
      await this.store.put({ ...current, state: 'withdrawn', withdrawnAt: this.clock.iso() });
    }
    const published: PlanVersion = {
      ...draft, state: 'published', publishedAt: this.clock.iso(), publishedBy,
    };
    await this.store.put(published);
    return published;
  }

  async discard(planCode: PlanCode, version: number): Promise<void> {
    const draft = await this.require(planCode, version);
    if (draft.state !== 'draft') {
      throw new AwaError({ kind: 'CONFLICT', message: 'Only a draft can be discarded.' });
    }
    await this.store.put({ ...draft, state: 'withdrawn', withdrawnAt: this.clock.iso() });
  }

  async versions(planCode: PlanCode): Promise<readonly PlanVersion[]> {
    return this.store.listVersions(planCode);
  }

  async all(): Promise<readonly PlanVersion[]> {
    return this.store.listAll();
  }

  /** The exact version a subscription was sold on, whatever has happened since. */
  async versionFor(planCode: PlanCode, version: number): Promise<PlanVersion | undefined> {
    return this.store.get(planCode, version);
  }

  /** A catalogue version as the Plan shape the rest of billing expects. */
  asPlan(version: PlanVersion): Plan {
    return {
      code: version.planCode,
      name: version.name,
      version: version.version,
      currency: version.currency,
      platformFee: version.platformFee,
      includedCreditsPence: version.includedCreditsPence,
      outcomeFee: version.outcomeFee,
      outcomeBasis: version.outcomeBasis,
      billableRepliesPerConversation: version.billableRepliesPerConversation,
      usageRates: version.usageRates,
      connectorEntitlement: version.connectorEntitlement,
      defaultSpendCapPence: version.defaultSpendCapPence,
      maxConcurrentVoice: version.maxConcurrentVoice,
      targetTenant: version.targetTenant,
    };
  }

  private async require(planCode: PlanCode, version: number): Promise<PlanVersion> {
    const found = await this.store.get(planCode, version);
    if (!found) {
      throw new AwaError({ kind: 'NOT_FOUND', message: `No version ${version} of ${planCode}.` });
    }
    return found;
  }
}
