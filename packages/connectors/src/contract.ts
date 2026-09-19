import type {
  AssociationType,
  CanonicalActivity,
  CanonicalOpportunity,
  CanonicalOrganisation,
  CanonicalOwner,
  CanonicalPerson,
  CanonicalPipeline,
  WriteResult,
} from '@detent/awa-core';

/**
 * The connector contract (section 16.6). Fixed and small on purpose: adding a
 * CRM must be a task, not a project, and a contract that grows per integration
 * is how a connector estate becomes a permanent engineering tax.
 */

export type ConnectorTier = 1 | 2 | 3;

/**
 * Capability declaration (section 16.2). Drives graceful degradation: where a
 * capability is partial or absent the product degrades explicitly, and a tenant
 * is told that returning-visitor recognition will lag rather than quietly given
 * a worse experience.
 */
export type CapabilityLevel = 'FULL' | 'PARTIAL' | 'NONE';

export interface CapabilityDeclaration {
  readonly connector: string;
  readonly tier: ConnectorTier;
  readonly personSearchByEmail: CapabilityLevel;
  readonly idempotentUpsert: CapabilityLevel;
  readonly organisationResolutionByDomain: CapabilityLevel;
  readonly opportunityReadWithStageAndOwner: CapabilityLevel;
  readonly associationWrite: CapabilityLevel;
  readonly meetingEngagementWrite: CapabilityLevel;
  readonly changeNotification: CapabilityLevel;
  readonly duplicateDetectionOrMerge: CapabilityLevel;
  readonly fieldHistory: CapabilityLevel;
  readonly customFields: CapabilityLevel;
  readonly sandbox: CapabilityLevel;
  readonly dedicatedErasureEndpoint: CapabilityLevel;
  /** Whether the CRM maintains a Lead object distinct from Contact (section 21.3). */
  readonly hasSeparateLeadObject: boolean;
  /** Published rate limit the token bucket is sized below. */
  readonly rateLimit: { readonly requestsPerSecond: number; readonly searchRequestsPerSecond: number };
  /** Notes surfaced verbatim to the tenant admin at connection time. */
  readonly degradationNotes: readonly string[];
}

export interface Credential {
  readonly kind: 'oauth2' | 'api_key' | 'private_app';
  readonly accessToken: string;
  /**
   * Refresh token, where the CRM issues one. Held so a rotation can happen
   * without a re-consent round trip, and encrypted at rest with the access
   * token (audit SEC-4).
   */
  readonly refreshToken?: string;
  readonly instanceUrl?: string;
  readonly expiresAt?: string;
  readonly region?: string;
}

export interface MatchCandidate {
  readonly externalId: string;
  readonly objectType: 'lead' | 'contact' | 'person' | 'organisation';
  readonly email?: string;
  readonly phone?: string;
  readonly name?: string;
  readonly organisationName?: string;
  readonly organisationDomain?: string;
  readonly ownerRef?: string;
  readonly lifecycleStage?: string;
  readonly lastModified?: string;
}

export interface PersonQuery {
  readonly email?: string;
  readonly phoneE164?: string;
  readonly externalId?: string;
  readonly name?: string;
}

export interface OrganisationQuery {
  readonly domain?: string;
  readonly name?: string;
}

export interface Subscription {
  readonly id: string;
  readonly callbackUrl: string;
  readonly events: readonly string[];
}

/**
 * Every connector implements exactly this. Nothing upstream knows which CRM a
 * tenant uses, and no method here accepts an owner, lifecycle stage, pipeline
 * or stage: those are read-only from the CRM, always (decision 4, section 1.3).
 */
export interface CrmConnector {
  readonly name: string;
  capabilities(): CapabilityDeclaration;

  searchPerson(credential: Credential, query: PersonQuery): Promise<MatchCandidate[]>;
  searchOrganisation(credential: Credential, query: OrganisationQuery): Promise<MatchCandidate[]>;
  readOpportunities(credential: Credential, personExternalId: string): Promise<CanonicalOpportunity[]>;
  readOwners(credential: Credential): Promise<CanonicalOwner[]>;
  readPipelines(credential: Credential): Promise<CanonicalPipeline[]>;

  upsertPerson(credential: Credential, person: CanonicalPerson, idempotencyKey: string): Promise<WriteResult>;
  upsertOrganisation(credential: Credential, organisation: CanonicalOrganisation, idempotencyKey: string): Promise<WriteResult>;
  createNote(credential: Credential, activity: CanonicalActivity, idempotencyKey: string): Promise<WriteResult>;
  createTask(credential: Credential, activity: CanonicalActivity, idempotencyKey: string): Promise<WriteResult>;
  createMeeting(credential: Credential, activity: CanonicalActivity, idempotencyKey: string): Promise<WriteResult>;
  associate(credential: Credential, from: { type: string; id: string }, to: { type: string; id: string }, type: AssociationType): Promise<WriteResult>;

  subscribeChanges?(credential: Credential, callbackUrl: string): Promise<Subscription>;
  /** Permanent erasure where the CRM offers an endpoint distinct from archival. */
  eraseSubject?(credential: Credential, externalId: string): Promise<void>;
}
