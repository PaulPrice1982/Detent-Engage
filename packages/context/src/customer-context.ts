import type { Clock } from '@detent/awa-core';
import { systemClock, type VerificationLevel } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import type { Credential } from '@detent/awa-connectors';
import type {
  BillingConnector, BillingFacts, ClmConnector, ClmFacts, EsignatureConnector, EsignatureFacts,
  MarketingAutomationConnector, MarketingConsentFacts, Sentiment, Standing, SupportConnector,
  SupportFacts, SystemCategory, SystemLookup, Trend, UsageFacts, WarehouseConnector,
} from './contract.js';

/**
 * The unified CustomerContext object (section 54.4).
 *
 * All nine categories resolve into one canonical structure. As with identity
 * resolution in v1.0, the language model receives **derived signals and
 * permitted behaviours, never the underlying records.**
 *
 * `permittedBehaviours` is the whole safety design. A visitor in arrears with
 * an open severity-one ticket produces "acknowledge_existing_relationship",
 * "route_to_account_team" and "do_not_sell". The model is told what it may do.
 * **It is never told the customer has not paid, so it cannot say so.**
 */
export type Relationship = 'PROSPECT' | 'CUSTOMER' | 'CHURNED' | 'PARTNER' | 'UNKNOWN';

export type PermittedBehaviour =
  | 'qualify_normally'
  | 'acknowledge_existing_relationship'
  | 'answer_service_question'
  | 'route_to_account_team'
  | 'route_to_enablement'
  | 'route_to_partner'
  | 'do_not_sell'
  | 'do_not_commit'
  | 'escalate_immediately'
  | 'confirm_in_scope'
  | 'confirm_out_of_scope';

export interface Entitlement {
  readonly inScope: readonly string[];
  readonly outOfScope: readonly string[];
  readonly expiresAt?: string;
  readonly autoRenew?: boolean;
  readonly noticeByDate?: string;
}

/**
 * The full context. Internal to the governed control plane.
 *
 * Note the split: `permittedBehaviours` is the only field the model receives;
 * `sourceSystems` exists for audit, not for the model; and the commercial
 * signals — arrears, excess use, renewal exposure — are here so the platform
 * can raise a task, and are structurally absent from the model-facing
 * projection below.
 */
export interface CustomerContext {
  readonly relationship: Relationship;
  readonly standing: Standing;
  readonly sentiment: Sentiment;
  readonly entitlement: Entitlement;
  readonly usage: { readonly trend: Trend; readonly seatUtilisationBand?: 'low' | 'medium' | 'high' };
  readonly commercial: {
    readonly renewalWindow: boolean;
    readonly expansionSignal: boolean;
    readonly excessUseDetected: boolean;
  };
  readonly openItems: {
    readonly supportTickets: number;
    readonly severityBand?: 'severe' | 'moderate' | 'low';
    readonly openQuote: boolean;
  };
  readonly permittedBehaviours: readonly PermittedBehaviour[];
  readonly sourceSystems: readonly SystemCategory[];
  readonly verificationLevel: VerificationLevel;
  /** Categories the tenant has not connected. Disclosed to the tenant, not the visitor. */
  readonly unconnectedCategories: readonly SystemCategory[];
}

/**
 * What crosses into model context. Deliberately tiny.
 *
 * This is the FR-084 boundary: zero source-system data in model context,
 * verified by probe. There is no relationship field, no standing field, no
 * ticket count and no renewal date — because a model that is told a customer is
 * in arrears will, sooner or later, say so.
 */
export interface ModelSafeContext {
  readonly permittedBehaviours: readonly PermittedBehaviour[];
  readonly verificationLevel: VerificationLevel;
}

export interface ContextResolutionInput {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly sessionId?: string;
  readonly lookup: SystemLookup;
  readonly verificationLevel: VerificationLevel;
  /** Renewal window in days. A tenant may narrow it, not widen it past a year. */
  readonly renewalWindowDays?: number;
}

export interface ConnectedSystem {
  readonly connector: BillingConnector | SupportConnector | ClmConnector | WarehouseConnector | EsignatureConnector | MarketingAutomationConnector;
  readonly credential: Credential;
}

export class CustomerContextService {
  constructor(
    private readonly systems: (tenantId: string) => Promise<readonly ConnectedSystem[]>,
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
  ) {}

  async resolve(input: ContextResolutionInput): Promise<CustomerContext> {
    const connected = await this.systems(input.tenantId);
    const present = new Set(connected.map((system) => system.connector.category));

    let billing: BillingFacts | undefined;
    let support: SupportFacts | undefined;
    let clm: ClmFacts | undefined;
    let usage: UsageFacts | undefined;
    let esign: EsignatureFacts | undefined;
    let marketing: MarketingConsentFacts | undefined;

    // Each system is read independently. One failing does not fail the others:
    // graceful degradation per category is FR-085, and an assistant that stops
    // working because a warehouse query timed out is worse than one that knows
    // slightly less.
    for (const system of connected) {
      try {
        switch (system.connector.category) {
          case 'billing': billing = await system.connector.readBilling(system.credential, input.lookup); break;
          case 'support': support = await system.connector.readSupport(system.credential, input.lookup); break;
          case 'clm': clm = await system.connector.readContract(system.credential, input.lookup); break;
          case 'warehouse': usage = await system.connector.readUsage(system.credential, input.lookup); break;
          case 'esignature': esign = await system.connector.readAgreements(system.credential, input.lookup); break;
          case 'marketing_automation': marketing = await system.connector.readConsent(system.credential, input.lookup); break;
        }
      } catch {
        present.delete(system.connector.category);
      }
    }

    const context = derive({
      billing, support, clm, usage, esign, marketing,
      verificationLevel: input.verificationLevel,
      sourceSystems: [...present],
      renewalWindowDays: Math.min(input.renewalWindowDays ?? 90, 365),
      now: this.clock.iso(),
    });

    await this.audit.write({
      tenantId: input.tenantId,
      type: 'resolution_complete',
      correlationId: input.correlationId,
      sessionId: input.sessionId,
      actor: 'policy',
      payload: {
        change: 'customer_context_resolved',
        // Bands and behaviours only. The audit log records what was decided,
        // not the customer's balance.
        relationship: context.relationship,
        standing: context.standing,
        sentiment: context.sentiment,
        permittedBehaviours: context.permittedBehaviours,
        sourceSystems: context.sourceSystems,
        unconnectedCategories: context.unconnectedCategories,
        verificationLevel: context.verificationLevel,
      },
    });

    return context;
  }

  /**
   * Project down to what may cross into model context.
   *
   * Structurally, not by redaction: the returned object has two fields and
   * neither can carry a source record.
   */
  toModelSafe(context: CustomerContext): ModelSafeContext {
    return {
      permittedBehaviours: context.permittedBehaviours,
      verificationLevel: context.verificationLevel,
    };
  }
}

const PRIORITY_ONE: readonly SystemCategory[] = ['billing', 'support', 'clm'];

interface DeriveInput {
  billing?: BillingFacts;
  support?: SupportFacts;
  clm?: ClmFacts;
  usage?: UsageFacts;
  esign?: EsignatureFacts;
  marketing?: MarketingConsentFacts;
  verificationLevel: VerificationLevel;
  sourceSystems: readonly SystemCategory[];
  renewalWindowDays: number;
  now: string;
}

/**
 * Derivation is deterministic and total: every combination of missing systems
 * produces a defined context, and an unknown is always UNKNOWN rather than an
 * optimistic guess.
 */
export function derive(input: DeriveInput): CustomerContext {
  const { billing, support, clm, usage, now } = input;

  const relationship: Relationship =
    billing?.isCustomer === true || clm?.hasExecutedAgreement === true ? 'CUSTOMER'
    : billing?.isCustomer === false && input.sourceSystems.includes('billing') ? 'PROSPECT'
    : 'UNKNOWN';

  const standing: Standing =
    billing === undefined ? 'UNKNOWN'
    : billing.paymentStatus === 'overdue' || billing.paymentStatus === 'failed' ? 'IN_ARREARS'
    : support?.recentEscalations && support.recentEscalations > 1 ? 'AT_RISK'
    : billing.paymentStatus === 'current' ? 'GOOD'
    : 'UNKNOWN';

  const sentiment: Sentiment = support?.sentiment ?? 'UNKNOWN';

  const severityBand =
    support?.highestSeverity === undefined ? undefined
    : support.highestSeverity <= 2 ? 'severe' as const
    : support.highestSeverity === 3 ? 'moderate' as const
    : 'low' as const;

  const renewalWindow = Boolean(
    clm?.expiresAt && withinDays(clm.expiresAt, now, input.renewalWindowDays),
  ) || Boolean(clm?.noticeByDate && withinDays(clm.noticeByDate, now, input.renewalWindowDays));

  const excessUseDetected = Boolean(
    (usage?.consumedAgainstLimit && usage.consumedAgainstLimit.consumed > usage.consumedAgainstLimit.limit) ||
    (billing?.usageAgainstPlanPct !== undefined && billing.usageAgainstPlanPct > 100),
  );

  const expansionSignal = Boolean(
    excessUseDetected ||
    usage?.trend === 'UP' ||
    (usage?.seatUtilisationPct !== undefined && usage.seatUtilisationPct > 90),
  );

  const entitlement: Entitlement = {
    inScope: (clm?.inScope ?? []).map((item) => item.category),
    outOfScope: clm?.outOfScope ?? [],
    expiresAt: clm?.expiresAt,
    autoRenew: clm?.autoRenew,
    noticeByDate: clm?.noticeByDate,
  };

  return {
    relationship,
    standing,
    sentiment,
    entitlement,
    usage: {
      trend: usage?.trend ?? 'UNKNOWN',
      seatUtilisationBand:
        usage?.seatUtilisationPct === undefined ? undefined
        : usage.seatUtilisationPct > 80 ? 'high'
        : usage.seatUtilisationPct > 40 ? 'medium'
        : 'low',
    },
    commercial: { renewalWindow, expansionSignal, excessUseDetected },
    openItems: {
      supportTickets: support?.openTicketCount ?? 0,
      severityBand,
      openQuote: false,
    },
    permittedBehaviours: derivePermittedBehaviours({ relationship, standing, sentiment, severityBand, renewalWindow, entitlement, verificationLevel: input.verificationLevel }),
    sourceSystems: input.sourceSystems,
    verificationLevel: input.verificationLevel,
    unconnectedCategories: PRIORITY_ONE.filter((category) => !input.sourceSystems.includes(category)),
  };
}

/**
 * The permitted behaviours, derived deterministically.
 *
 * The rule that matters most, and the one no competitor implements because none
 * of them can see the support system: **when a customer is unhappy, selling is
 * disabled entirely.** Every human account manager knows this. No AI sales
 * agent does it.
 */
export function derivePermittedBehaviours(input: {
  relationship: Relationship;
  standing: Standing;
  sentiment: Sentiment;
  severityBand?: 'severe' | 'moderate' | 'low';
  renewalWindow: boolean;
  entitlement: Entitlement;
  verificationLevel: VerificationLevel;
}): PermittedBehaviour[] {
  const behaviours: PermittedBehaviour[] = [];

  if (input.relationship !== 'CUSTOMER') {
    behaviours.push('qualify_normally');
    return behaviours;
  }

  behaviours.push('acknowledge_existing_relationship');

  // Arrears or dispute: route to the account team without comment. No selling,
  // no service commitments. The visitor is never told why.
  if (input.standing === 'IN_ARREARS' || input.standing === 'IN_DISPUTE') {
    behaviours.push('route_to_account_team', 'do_not_sell', 'do_not_commit', 'escalate_immediately');
    return behaviours;
  }

  // Unhappy, or a severe open ticket: help or escalate. Selling is off.
  if (input.sentiment === 'NEGATIVE' || input.severityBand === 'severe') {
    behaviours.push('answer_service_question', 'do_not_sell', 'escalate_immediately');
    return behaviours;
  }

  behaviours.push('answer_service_question', 'route_to_account_team');

  // Entitlement statements need level 2. Below that the assistant knows the
  // answer and may not say it, which is the correct trade.
  if (input.verificationLevel >= 2) {
    if (input.entitlement.inScope.length > 0) behaviours.push('confirm_in_scope');
    if (input.entitlement.outOfScope.length > 0) behaviours.push('confirm_out_of_scope');
    behaviours.push('route_to_enablement');
  }

  // A renewal window is flagged internally. It never becomes pressure on the
  // visitor, so it adds no behaviour that lets the model raise it.
  return behaviours;
}

function withinDays(dateIso: string, nowIso: string, days: number): boolean {
  const target = Date.parse(dateIso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(target) || !Number.isFinite(now)) return false;
  const delta = target - now;
  return delta >= 0 && delta <= days * 86_400_000;
}
