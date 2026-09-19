import type { CanonicalOpportunity } from '@detent/awa-core';
import type { MatchCandidate } from '@detent/awa-connectors';
import { normaliseEmail, normalisePhone, normaliseOrganisationName, similarity } from './normalise.js';

/**
 * Deterministic matching waterfall (section 16.4, table 24).
 *
 * "Confidence is scored, never assumed." The scoring is a fixed table rather
 * than a model, so the same inputs always produce the same band, the band is
 * explainable to a tenant, and the deduplication precision figure measured in
 * CI means something.
 */
export type ConfidenceBand = 'HIGH' | 'MEDIUM_HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export type MatchSignal =
  | 'exact_email'
  | 'exact_phone'
  | 'tenant_supplied_id'
  | 'corporate_domain'
  | 'organisation_name_fuzzy'
  | 'person_name_fuzzy';

export interface ScoredCandidate {
  readonly candidate: MatchCandidate;
  readonly score: number;
  readonly band: ConfidenceBand;
  readonly signals: readonly MatchSignal[];
  /** True where the evidence is company-level only and must not be used per person. */
  readonly companyLevelOnly: boolean;
}

export interface ScoringInput {
  readonly email?: string;
  readonly phoneE164?: string;
  readonly name?: string;
  readonly organisationName?: string;
  /** A record id handed over by the tenant, e.g. from an authenticated portal. */
  readonly tenantSuppliedExternalId?: string;
}

/**
 * Signal weights. Person-name fuzzy matching is worth almost nothing on
 * purpose: it is an ambiguity signal, never evidence, and treating it as
 * evidence is how a website assistant greets the wrong person by name.
 */
const WEIGHTS: Record<MatchSignal, number> = {
  tenant_supplied_id: 100,
  exact_email: 90,
  exact_phone: 60,
  corporate_domain: 25,
  organisation_name_fuzzy: 10,
  person_name_fuzzy: 4,
};

const HIGH_THRESHOLD = 85;
const MEDIUM_HIGH_THRESHOLD = 55;
const MEDIUM_THRESHOLD = 30;
const LOW_THRESHOLD = 10;

export function scoreCandidate(input: ScoringInput, candidate: MatchCandidate): ScoredCandidate {
  const signals: MatchSignal[] = [];
  let score = 0;

  if (input.tenantSuppliedExternalId && input.tenantSuppliedExternalId === candidate.externalId) {
    signals.push('tenant_supplied_id');
    score += WEIGHTS.tenant_supplied_id;
  }

  if (input.email && candidate.email) {
    const a = normaliseEmail(input.email);
    const b = normaliseEmail(candidate.email);
    if (a.matchKey === b.matchKey) {
      signals.push('exact_email');
      score += WEIGHTS.exact_email;
    } else if (!a.isPublicMailbox && a.domain === b.domain) {
      // Same corporate domain, different person. Company-level evidence only.
      signals.push('corporate_domain');
      score += WEIGHTS.corporate_domain;
    }
  }

  if (input.phoneE164 && candidate.phone) {
    const normalised = normalisePhone(candidate.phone);
    if (normalised && normalised === input.phoneE164) {
      signals.push('exact_phone');
      score += WEIGHTS.exact_phone;
    }
  }

  if (input.organisationName && candidate.organisationName) {
    const ratio = similarity(
      normaliseOrganisationName(input.organisationName),
      normaliseOrganisationName(candidate.organisationName),
    );
    if (ratio >= 0.9) {
      signals.push('organisation_name_fuzzy');
      score += WEIGHTS.organisation_name_fuzzy * ratio;
    }
  }

  if (input.name && candidate.name) {
    const ratio = similarity(input.name.toLowerCase(), candidate.name.toLowerCase());
    if (ratio >= 0.9) {
      signals.push('person_name_fuzzy');
      score += WEIGHTS.person_name_fuzzy * ratio;
    }
  }

  const personLevelSignals = signals.filter((s) => s === 'exact_email' || s === 'exact_phone' || s === 'tenant_supplied_id');
  return {
    candidate,
    score: Math.round(score * 100) / 100,
    band: toBand(score),
    signals,
    companyLevelOnly: personLevelSignals.length === 0,
  };
}

function toBand(score: number): ConfidenceBand {
  if (score >= HIGH_THRESHOLD) return 'HIGH';
  if (score >= MEDIUM_HIGH_THRESHOLD) return 'MEDIUM_HIGH';
  if (score >= MEDIUM_THRESHOLD) return 'MEDIUM';
  if (score >= LOW_THRESHOLD) return 'LOW';
  return 'NONE';
}

export function scoreAll(input: ScoringInput, candidates: readonly MatchCandidate[]): ScoredCandidate[] {
  return candidates
    .map((candidate) => scoreCandidate(input, candidate))
    .filter((scored) => scored.band !== 'NONE')
    .sort((a, b) => b.score - a.score);
}

/**
 * Classification (section 16.4, table 25).
 *
 * What this returns changes what the assistant *does*. It never changes what
 * the assistant *says about the CRM* — that separation is enforced at the
 * response boundary in `resolution.ts`, which strips record contents entirely.
 */
export type Classification =
  | 'NEW_PROSPECT'
  | 'KNOWN_PROSPECT'
  | 'OPEN_OPPORTUNITY'
  | 'EXISTING_CUSTOMER'
  | 'AMBIGUOUS';

export type PermittedBehaviour =
  | 'normal_qualification'
  | 'route_to_owner'
  | 'route_to_account_team'
  | 'disambiguate_or_escalate';

export interface ClassificationResult {
  readonly classification: Classification;
  readonly permittedBehaviour: PermittedBehaviour;
  readonly confidence: ConfidenceBand;
}

export interface ClassificationContext {
  readonly opportunities: readonly CanonicalOpportunity[];
  /** Lifecycle values the tenant treats as "already a customer". */
  readonly customerLifecycleStages: readonly string[];
}

export function classify(
  scored: readonly ScoredCandidate[],
  context: ClassificationContext,
): ClassificationResult {
  const best = scored[0];
  const second = scored[1];

  // No person-level evidence at all. A domain match is not a person.
  if (!best || best.companyLevelOnly || best.band === 'LOW' || best.band === 'MEDIUM') {
    return { classification: 'NEW_PROSPECT', permittedBehaviour: 'normal_qualification', confidence: best?.band ?? 'NONE' };
  }

  // Two candidates in the same band is a tie the platform must not break.
  // Never guess, never merge (FR-021).
  if (second && second.band === best.band && second.candidate.externalId !== best.candidate.externalId) {
    return { classification: 'AMBIGUOUS', permittedBehaviour: 'disambiguate_or_escalate', confidence: best.band };
  }

  const closedWon = context.opportunities.some((o) => o.isClosedWon);
  const lifecycle = best.candidate.lifecycleStage?.toLowerCase();
  const isCustomer =
    closedWon ||
    (lifecycle !== undefined && context.customerLifecycleStages.some((stage) => stage.toLowerCase() === lifecycle));

  if (isCustomer) {
    return { classification: 'EXISTING_CUSTOMER', permittedBehaviour: 'route_to_account_team', confidence: best.band };
  }

  if (context.opportunities.some((o) => o.isOpen)) {
    return { classification: 'OPEN_OPPORTUNITY', permittedBehaviour: 'route_to_owner', confidence: best.band };
  }

  return { classification: 'KNOWN_PROSPECT', permittedBehaviour: 'route_to_owner', confidence: best.band };
}
