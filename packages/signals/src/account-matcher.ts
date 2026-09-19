import type { CrmAdapter, MatchCandidate } from '@detent/awa-connectors';
import type { CompanyResolution } from './visitor-signal.js';

/**
 * The account matcher (FR-064).
 *
 * Matches a resolved company to CRM accounts and open opportunities. The hard
 * constraint, restated in the return type: it **must not match to a person from
 * company-level data alone.** A company match tells the assistant that someone
 * from Acme is on the site; it does not tell it who, and the difference is the
 * whole of section 43.2.
 */
export interface AccountMatch {
  readonly accountExternalId: string;
  readonly accountName?: string;
  readonly hasOpenOpportunity: boolean;
  /** Owner reference, used to route. Never disclosed to the visitor. */
  readonly ownerRef?: string;
  readonly confidence: number;
}

export interface AccountMatchResult {
  readonly match?: AccountMatch;
  readonly reason: string;
}

export class AccountMatcher {
  constructor(private readonly adapter: CrmAdapter) {}

  async match(tenantId: string, company: CompanyResolution): Promise<AccountMatchResult> {
    let candidates: MatchCandidate[];
    try {
      candidates = await this.adapter.searchOrganisationByDomain(tenantId, company.domain);
    } catch {
      return { reason: 'CRM unavailable; proceeding without an account match' };
    }

    if (candidates.length === 0) return { reason: 'no CRM account matched this domain' };
    if (candidates.length > 1) {
      // Two accounts on the same domain is a tenant data problem. The platform
      // does not pick one, for the same reason it never picks between two
      // person candidates.
      return { reason: `${candidates.length} accounts share this domain; declining to guess` };
    }

    const candidate = candidates[0]!;
    let hasOpenOpportunity = false;
    try {
      // Opportunities are read against the account, not against a person: there
      // is no person here and there must not be one.
      const opportunities = await this.adapter.readOpportunities(tenantId, candidate.externalId);
      hasOpenOpportunity = opportunities.some((opportunity) => opportunity.isOpen);
    } catch {
      hasOpenOpportunity = false;
    }

    return {
      match: {
        accountExternalId: candidate.externalId,
        accountName: candidate.name,
        hasOpenOpportunity,
        ownerRef: candidate.ownerRef,
        confidence: company.confidence,
      },
      reason: 'single account matched on domain',
    };
  }
}
