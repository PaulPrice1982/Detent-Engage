import type { AuditLog } from '@detent/awa-audit';

/**
 * Partner registry and routing (section 59).
 *
 * Every competitor routes only to internal owners. Businesses selling through
 * resellers, referral partners or franchisees have no way to route a website
 * visitor to the right partner.
 *
 * Two rules are absolute here: **routing to a partner is a disclosure to a
 * third party**, so the visitor is told and consent is recorded before any data
 * crosses (FR-110); and where an internal owner and a partner both claim the
 * account, it escalates to a human and is never resolved automatically
 * (FR-112).
 */
export interface Partner {
  readonly partnerId: string;
  readonly name: string;
  readonly entityId?: string;
  readonly territories: readonly string[];
  readonly sectors: readonly string[];
  readonly services: readonly string[];
  /** Remaining monthly capacity. Zero means do not route. */
  readonly capacity: number;
  readonly tier: 1 | 2 | 3;
  readonly crmConnected: boolean;
  readonly portalUrl?: string;
}

export interface RoutingSignals {
  readonly territory?: string;
  readonly sector?: string;
  readonly service?: string;
}

export type PartnerRoutingOutcome =
  | { readonly kind: 'ROUTED'; readonly partner: Partner; readonly reason: string }
  | { readonly kind: 'NO_MATCH'; readonly reason: string }
  | { readonly kind: 'CONFLICT_ESCALATED'; readonly reason: string; readonly claimants: readonly string[] }
  | { readonly kind: 'CONSENT_REQUIRED'; readonly reason: string };

export class PartnerRegistry {
  private readonly partners = new Map<string, Partner[]>();
  private readonly roundRobin = new Map<string, number>();

  constructor(private readonly audit: AuditLog) {}

  register(tenantId: string, partner: Partner): void {
    const list = this.partners.get(tenantId) ?? [];
    list.push(partner);
    this.partners.set(tenantId, list);
  }

  list(tenantId: string): Partner[] {
    return [...(this.partners.get(tenantId) ?? [])];
  }

  /**
   * Deterministic selection by geography, sector, service and capacity, with
   * round-robin within a tier. No model involvement: which partner receives a
   * routing is a commercial and often a contractual question.
   */
  async route(input: {
    tenantId: string;
    correlationId: string;
    signals: RoutingSignals;
    /** True once the visitor has been told and consent recorded. */
    thirdPartyDisclosureConsentRecorded: boolean;
    /** An internal owner already on the account, if any. */
    internalOwnerRef?: string;
  }): Promise<PartnerRoutingOutcome> {
    const eligible = this.list(input.tenantId).filter((partner) =>
      partner.capacity > 0 &&
      matchesList(partner.territories, input.signals.territory) &&
      matchesList(partner.sectors, input.signals.sector) &&
      matchesList(partner.services, input.signals.service),
    );

    if (eligible.length === 0) {
      return { kind: 'NO_MATCH', reason: 'no partner matched territory, sector, service and capacity' };
    }

    // Conflict handling comes before consent: there is no point asking a
    // visitor to consent to a disclosure that is going to escalate anyway.
    if (input.internalOwnerRef) {
      const outcome: PartnerRoutingOutcome = {
        kind: 'CONFLICT_ESCALATED',
        reason: 'an internal owner and a partner both claim this account',
        claimants: [input.internalOwnerRef, ...eligible.map((partner) => partner.partnerId)],
      };
      await this.audit.write({
        tenantId: input.tenantId, type: 'escalated_to_human', correlationId: input.correlationId,
        actor: 'policy',
        payload: { change: 'partner_conflict', internalOwnerRef: input.internalOwnerRef, partners: eligible.map((p) => p.partnerId) },
      });
      return outcome;
    }

    // Routing to a partner discloses personal data to a third party.
    if (!input.thirdPartyDisclosureConsentRecorded) {
      await this.audit.write({
        tenantId: input.tenantId, type: 'policy_denied', correlationId: input.correlationId, actor: 'policy',
        payload: { change: 'partner_routing_blocked', reason: 'no third-party disclosure consent recorded' },
      });
      return {
        kind: 'CONSENT_REQUIRED',
        reason: 'routing to a partner discloses the visitor to a third party; consent must be recorded first',
      };
    }

    const topTier = Math.min(...eligible.map((partner) => partner.tier));
    const tierPartners = eligible.filter((partner) => partner.tier === topTier);
    const key = `${input.tenantId}:${topTier}`;
    const index = (this.roundRobin.get(key) ?? 0) % tierPartners.length;
    this.roundRobin.set(key, index + 1);
    const partner = tierPartners[index]!;

    await this.audit.write({
      tenantId: input.tenantId, type: 'tool_call_executed', correlationId: input.correlationId, actor: 'policy',
      payload: {
        change: 'partner_routed', partnerId: partner.partnerId, tier: partner.tier,
        consentRecorded: true, signals: input.signals,
      },
    });

    return {
      kind: 'ROUTED',
      partner,
      reason: `tier ${topTier} round-robin across ${tierPartners.length} eligible partner(s)`,
    };
  }

  /**
   * Deal registration into the partner's own CRM or portal, with source
   * attribution preserved end to end (FR-111).
   */
  buildDealRegistration(input: {
    partner: Partner;
    person: { email?: string; name?: string; organisation?: string };
    attribution: { source?: string; campaign?: string; landingPage?: string };
    correlationId: string;
  }): { destination: 'partner_crm' | 'partner_portal' | 'none'; payload: Record<string, unknown> } {
    return {
      destination: input.partner.crmConnected ? 'partner_crm' : input.partner.portalUrl ? 'partner_portal' : 'none',
      payload: {
        partner_id: input.partner.partnerId,
        person: input.person,
        // Attribution travels with the lead. A partner-sourced lead whose
        // origin is lost is a lead the tenant cannot pay commission on.
        attribution: { ...input.attribution, routed_by: 'detent-website-assistant', correlation_id: input.correlationId },
      },
    };
  }
}

/** An empty list means "no restriction", which is the sane default for coverage. */
function matchesList(list: readonly string[], value: string | undefined): boolean {
  if (list.length === 0) return true;
  if (!value) return false;
  return list.some((entry) => entry.toLowerCase() === value.toLowerCase());
}
