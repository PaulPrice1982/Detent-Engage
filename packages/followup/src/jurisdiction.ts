import { PUBLIC_MAILBOX_DOMAINS_FOR_FOLLOWUP } from './mailboxes.js';
import type { Jurisdiction, TenantConfig } from '@detent/awa-core';
import { stricterOf } from '@detent/awa-core';

/**
 * The jurisdiction rules engine (section 42.3, FR-055).
 *
 * **Fail closed is the governing principle.** An unresolvable jurisdiction
 * produces transactional-only, never a guess in the platform's commercial
 * favour. That single rule is what separates a defensible follow-up capability
 * from the thin consent handling competitors ship.
 */
export type SendingLane =
  /** Necessary for the service the visitor requested. */
  | 'TRANSACTIONAL_ONLY'
  /** UK GDPR legitimate interest, with a completed LIA, where PECR permits. */
  | 'LEGITIMATE_INTEREST_FOLLOWUP'
  /** Explicit consent event. */
  | 'CONSENTED_NURTURE';

export interface LaneDecision {
  readonly lane: SendingLane;
  readonly jurisdictionApplied: Jurisdiction;
  readonly reason: string;
  /** True when the jurisdiction could not be resolved and the fail-closed
   *  default was applied. Reported to the compliance scorecard. */
  readonly failedClosed: boolean;
}

export interface Recipient {
  readonly email: string;
  /** ISO country code where the platform can determine it, otherwise absent. */
  readonly countryCode?: string;
  readonly hasMarketingConsentEvent: boolean;
}

/**
 * Resolve a recipient's jurisdiction. Deliberately narrow: it uses a country
 * the tenant or the visitor supplied, or a country-code top-level domain, and
 * nothing else. It does not geolocate an IP, because an IP is personal data and
 * using one to decide a marketing rule would be processing that needs its own
 * basis.
 */
export function resolveJurisdiction(recipient: Recipient): Jurisdiction | undefined {
  if (recipient.countryCode) {
    const mapped = COUNTRY_TO_JURISDICTION[recipient.countryCode.toUpperCase()];
    if (mapped) return mapped;
    // A country we know but have no rule for is not "OTHER by default", it is
    // unresolved, which fails closed.
    return undefined;
  }

  const domain = recipient.email.split('@')[1]?.toLowerCase();
  if (!domain) return undefined;
  // A public mailbox tells us nothing about where the person is.
  if (PUBLIC_MAILBOX_DOMAINS_FOR_FOLLOWUP.has(domain)) return undefined;

  for (const [suffix, jurisdiction] of Object.entries(TLD_TO_JURISDICTION)) {
    if (domain.endsWith(suffix)) return jurisdiction;
  }
  return undefined;
}

const COUNTRY_TO_JURISDICTION: Readonly<Record<string, Jurisdiction>> = {
  GB: 'UK', UK: 'UK',
  IE: 'EU', DE: 'EU', FR: 'EU', NL: 'EU', ES: 'EU', IT: 'EU', BE: 'EU',
  SE: 'EU', DK: 'EU', FI: 'EU', PT: 'EU', AT: 'EU', PL: 'EU', LU: 'EU',
  US: 'US', CA: 'CA', AU: 'AU', NZ: 'NZ',
};

const TLD_TO_JURISDICTION: Readonly<Record<string, Jurisdiction>> = {
  '.co.uk': 'UK', '.org.uk': 'UK', '.ac.uk': 'UK', '.uk': 'UK',
  '.ie': 'EU', '.de': 'EU', '.fr': 'EU', '.nl': 'EU', '.es': 'EU',
  '.it': 'EU', '.be': 'EU', '.se': 'EU', '.dk': 'EU', '.fi': 'EU',
  '.pt': 'EU', '.at': 'EU', '.pl': 'EU', '.eu': 'EU',
  '.com.au': 'AU', '.au': 'AU', '.co.nz': 'NZ', '.nz': 'NZ', '.ca': 'CA', '.us': 'US',
};

/**
 * A "corporate subscriber" for PECR purposes. The platform is deliberately
 * conservative: a named individual at a corporate domain may be an individual
 * subscriber, and Regulation 22 turns on the subscriber, not the domain. Only a
 * generic role address is treated as clearly corporate.
 */
const ROLE_LOCAL_PARTS = new Set([
  'info', 'sales', 'enquiries', 'enquiry', 'contact', 'hello', 'admin',
  'accounts', 'support', 'office', 'team', 'marketing', 'procurement',
]);

export function isCorporateSubscriber(recipient: Recipient): boolean {
  const [local, domain] = recipient.email.toLowerCase().split('@');
  if (!local || !domain) return false;
  if (PUBLIC_MAILBOX_DOMAINS_FOR_FOLLOWUP.has(domain)) return false;
  return ROLE_LOCAL_PARTS.has(local);
}

/**
 * Determine the permitted lane. Mirrors the pseudocode in section 42.3, with
 * the stricter-of rule applied between the recipient's jurisdiction and the
 * tenant's own.
 */
export function permittedLane(recipient: Recipient, config: TenantConfig): LaneDecision {
  // Consent, where it genuinely exists, is the strongest basis and is checked
  // first, it is the only path to nurture regardless of jurisdiction.
  if (recipient.hasMarketingConsentEvent) {
    return {
      lane: 'CONSENTED_NURTURE',
      jurisdictionApplied: config.homeJurisdiction,
      reason: 'a stored marketing consent event exists for this recipient',
      failedClosed: false,
    };
  }

  const resolved = resolveJurisdiction(recipient);
  if (!resolved) {
    return {
      lane: 'TRANSACTIONAL_ONLY',
      jurisdictionApplied: config.homeJurisdiction,
      reason: 'recipient jurisdiction could not be resolved; failing closed',
      failedClosed: true,
    };
  }

  const applied = stricterOf(resolved, config.homeJurisdiction);

  switch (applied) {
    case 'CA':
      // CASL requires express consent, with no implied-consent path built.
      return { lane: 'TRANSACTIONAL_ONLY', jurisdictionApplied: applied, reason: 'CASL requires express consent', failedClosed: false };
    case 'EU':
      return { lane: 'TRANSACTIONAL_ONLY', jurisdictionApplied: applied, reason: 'several member states extend the opt-in rule to corporate subscribers', failedClosed: false };
    case 'UK':
      if (isCorporateSubscriber(recipient) && config.followUp.liaComplete) {
        return {
          lane: 'LEGITIMATE_INTEREST_FOLLOWUP',
          jurisdictionApplied: applied,
          reason: 'corporate subscriber and the tenant legitimate interests assessment is complete',
          failedClosed: false,
        };
      }
      return {
        lane: 'TRANSACTIONAL_ONLY',
        jurisdictionApplied: applied,
        reason: config.followUp.liaComplete
          ? 'a named individual at a corporate domain may be an individual subscriber; do not assume'
          : 'the tenant legitimate interests assessment is not complete',
        failedClosed: false,
      };
    case 'US':
      // CAN-SPAM is an opt-out regime, so a single relevant follow-up with a
      // prominent opt-out is permitted.
      return { lane: 'LEGITIMATE_INTEREST_FOLLOWUP', jurisdictionApplied: applied, reason: 'CAN-SPAM is an opt-out regime', failedClosed: false };
    case 'AU':
    case 'NZ':
      return { lane: 'TRANSACTIONAL_ONLY', jurisdictionApplied: applied, reason: 'consent-based regime with inferred consent construed narrowly', failedClosed: false };
    default:
      return { lane: 'TRANSACTIONAL_ONLY', jurisdictionApplied: applied, reason: 'no rule for this jurisdiction; failing closed', failedClosed: true };
  }
}
