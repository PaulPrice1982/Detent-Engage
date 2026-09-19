import { newId, type Clock, systemClock } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import type { ConsentService } from '@detent/awa-policy';
import type { CrmAdapter } from '@detent/awa-connectors';
import { extractCorporateDomain, normaliseEmail, normalisePhone } from './normalise.js';
import { classify, scoreAll, type Classification, type ConfidenceBand, type PermittedBehaviour, type ScoredCandidate } from './scoring.js';

/**
 * Identity resolution response, redacted by design (section 22.2).
 *
 * Note what is absent: no record id, no contact name, no company, no deal name,
 * no stage, no value, no activity history. The model cannot leak what it never
 * receives, and this is the strongest structural control in the product. It
 * should not be relaxed for convenience.
 */
export interface ResolutionResponse {
  readonly classification: Classification;
  readonly confidence: ConfidenceBand;
  readonly permittedBehaviour: PermittedBehaviour;
  /** A label, never a name: "your account contact", not "Priya Raman". */
  readonly ownerDisplayName?: string;
  readonly consentEventId?: string;
  readonly correlationId: string;
  readonly reason?: 'no_consent' | 'no_identifier' | 'connection_unavailable';
}

/**
 * Internal resolution result. Stays inside the governed control plane; the
 * owner reference is needed to route and to raise a task, and never crosses
 * into model context.
 */
export interface InternalResolution extends ResolutionResponse {
  readonly ownerRef?: string;
  readonly matchedExternalId?: string;
  readonly matchedObjectType?: string;
  readonly suspectedDuplicates: readonly string[];
}

export interface ResolveInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly subjectRef: string;
  readonly correlationId: string;
  readonly email?: string;
  readonly phone?: string;
  readonly name?: string;
  readonly organisationName?: string;
  readonly tenantSuppliedExternalId?: string;
  readonly customerLifecycleStages?: readonly string[];
  readonly defaultCallingCode?: string;
}

export class IdentityResolutionService {
  constructor(
    private readonly consent: ConsentService,
    private readonly adapter: CrmAdapter,
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * The consent-gated resolution path (section 22.5).
   *
   * Step one is the gate and it is unconditional. There is no configuration,
   * no tenant override and no fast path that reaches a CRM search before it.
   */
  async resolve(input: ResolveInput): Promise<InternalResolution> {
    const consentEvent = await this.consent.get(input.tenantId, input.subjectRef, 'IDENTITY_RESOLUTION');
    if (consentEvent?.choice !== 'GRANTED') {
      await this.audit.write({
        tenantId: input.tenantId,
        type: 'resolution_blocked_no_consent',
        correlationId: input.correlationId,
        sessionId: input.sessionId,
        actor: 'policy',
        subjectRef: input.subjectRef,
        payload: { storedChoice: consentEvent?.choice ?? 'none' },
      });
      // Stateless and non-resolving. The visitor is a new prospect, and no CRM
      // call has been made.
      return {
        classification: 'NEW_PROSPECT',
        confidence: 'NONE',
        permittedBehaviour: 'normal_qualification',
        correlationId: input.correlationId,
        reason: 'no_consent',
        suspectedDuplicates: [],
      };
    }

    await this.audit.write({
      tenantId: input.tenantId,
      type: 'resolution_started',
      correlationId: input.correlationId,
      sessionId: input.sessionId,
      actor: 'policy',
      subjectRef: input.subjectRef,
      consentEventId: consentEvent.id,
    });

    // Step 2: normalise.
    const email = input.email ? normaliseEmail(input.email) : undefined;
    const phoneE164 = input.phone ? normalisePhone(input.phone, input.defaultCallingCode) : undefined;

    if ((!email || !email.valid) && !phoneE164 && !input.tenantSuppliedExternalId) {
      return {
        classification: 'NEW_PROSPECT',
        confidence: 'NONE',
        permittedBehaviour: 'normal_qualification',
        consentEventId: consentEvent.id,
        correlationId: input.correlationId,
        reason: 'no_identifier',
        suspectedDuplicates: [],
      };
    }

    // Step 3: search. A degraded connection is not a resolution failure worth
    // stopping the conversation for; the visitor is simply treated as new.
    let candidates;
    try {
      candidates = await this.adapter.searchPerson(input.tenantId, {
        email: email?.valid ? email.normalised : undefined,
        phoneE164,
        externalId: input.tenantSuppliedExternalId,
      });
    } catch {
      return {
        classification: 'NEW_PROSPECT',
        confidence: 'NONE',
        permittedBehaviour: 'normal_qualification',
        consentEventId: consentEvent.id,
        correlationId: input.correlationId,
        reason: 'connection_unavailable',
        suspectedDuplicates: [],
      };
    }

    // Step 4: score, deterministically.
    const scored = scoreAll(
      {
        email: email?.valid ? email.normalised : undefined,
        phoneE164,
        name: input.name,
        organisationName: input.organisationName ?? (email ? extractCorporateDomain(email.normalised) : undefined),
        tenantSuppliedExternalId: input.tenantSuppliedExternalId,
      },
      candidates,
    );

    const best = scored[0];
    const opportunities = best && !best.companyLevelOnly
      ? await this.adapter.readOpportunities(input.tenantId, best.candidate.externalId).catch(() => [])
      : [];

    // Step 5: classify against the tenant's live pipeline configuration.
    const result = classify(scored, {
      opportunities,
      customerLifecycleStages: input.customerLifecycleStages ?? ['customer', 'client', 'closedwon'],
    });

    const duplicates = suspectedDuplicates(scored);
    if (result.classification === 'AMBIGUOUS') {
      await this.audit.write({
        tenantId: input.tenantId,
        type: 'ambiguous_match',
        correlationId: input.correlationId,
        sessionId: input.sessionId,
        actor: 'policy',
        subjectRef: input.subjectRef,
        consentEventId: consentEvent.id,
        payload: { candidateCount: scored.length, topBand: best?.band },
      });
    } else if (duplicates.length > 0) {
      // Detected, never merged. Merging is destructive and belongs to the
      // tenant; the assistant raises an owner task instead (section 17.2).
      await this.audit.write({
        tenantId: input.tenantId,
        type: 'duplicate_suspected',
        correlationId: input.correlationId,
        sessionId: input.sessionId,
        actor: 'policy',
        subjectRef: input.subjectRef,
        payload: { count: duplicates.length },
      });
    }

    await this.audit.write({
      tenantId: input.tenantId,
      type: 'resolution_complete',
      correlationId: input.correlationId,
      sessionId: input.sessionId,
      actor: 'policy',
      subjectRef: input.subjectRef,
      consentEventId: consentEvent.id,
      payload: { classification: result.classification, confidence: result.confidence, signals: best?.signals ?? [] },
    });

    return {
      classification: result.classification,
      confidence: result.confidence,
      permittedBehaviour: result.permittedBehaviour,
      ownerDisplayName: best?.candidate.ownerRef ? 'your account contact' : undefined,
      ownerRef: best?.candidate.ownerRef,
      matchedExternalId: result.classification === 'AMBIGUOUS' ? undefined : best?.candidate.externalId,
      matchedObjectType: result.classification === 'AMBIGUOUS' ? undefined : best?.candidate.objectType,
      consentEventId: consentEvent.id,
      correlationId: input.correlationId,
      suspectedDuplicates: duplicates,
    };
  }

  /**
   * Project the internal result down to what may cross into model context.
   * This is boundary B2 for identity: the model receives a classification and a
   * permitted behaviour, and nothing else.
   */
  toModelSafe(resolution: InternalResolution): ResolutionResponse {
    return {
      classification: resolution.classification,
      confidence: resolution.confidence,
      permittedBehaviour: resolution.permittedBehaviour,
      ownerDisplayName: resolution.ownerDisplayName,
      consentEventId: resolution.consentEventId,
      correlationId: resolution.correlationId,
      reason: resolution.reason,
    };
  }

  newCorrelationId(): string {
    return newId('corr', this.clock.nowMs());
  }
}

/**
 * Suspected duplicates: more than one record carrying person-level evidence.
 * Reported for an owner task; never acted on by merging.
 */
function suspectedDuplicates(scored: readonly ScoredCandidate[]): string[] {
  const personLevel = scored.filter((s) => !s.companyLevelOnly && (s.band === 'HIGH' || s.band === 'MEDIUM_HIGH'));
  return personLevel.length > 1 ? personLevel.slice(1).map((s) => s.candidate.externalId) : [];
}
