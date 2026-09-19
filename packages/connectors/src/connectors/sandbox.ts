import {
  AwaError,
  type AssociationType, type CanonicalActivity, type CanonicalOpportunity,
  type CanonicalOrganisation, type CanonicalOwner, type CanonicalPerson,
  type CanonicalPipeline, type WriteResult,
} from '@detent/awa-core';
import type {
  CapabilityDeclaration, Credential, CrmConnector, MatchCandidate,
  OrganisationQuery, PersonQuery, Subscription,
} from '../contract.js';

/**
 * In-memory reference CRM.
 *
 * This exists for three jobs: the contract test suite every real connector must
 * also pass, the deduplication precision harness, and the runnable demo. It
 * models the awkward parts deliberately — a separate lead object, owner and
 * lifecycle stage that are read-only, and a configurable failure mode — because
 * a fake that only models the easy path proves nothing.
 */
export interface SandboxRecord {
  id: string;
  objectType: 'lead' | 'contact' | 'organisation';
  email?: string;
  phone?: string;
  name?: string;
  jobTitle?: string;
  organisationName?: string;
  domain?: string;
  ownerRef?: string;
  lifecycleStage?: string;
  qualificationState?: string;
  writeKey?: string;
  lastModified: string;
}

export interface SandboxOptions {
  readonly hasSeparateLeadObject?: boolean;
  /** Injected failure for reconciliation and degradation tests. */
  failNextWrites?: number;
  failureKind?: 'UPSTREAM_UNAVAILABLE' | 'RATE_LIMITED' | 'CONNECTION_DEGRADED';
}

export class SandboxConnector implements CrmConnector {
  readonly name = 'sandbox';
  readonly records = new Map<string, SandboxRecord>();
  readonly activities: Array<CanonicalActivity & { id: string; objectType: string }> = [];
  readonly associations: Array<{ from: string; to: string; type: AssociationType }> = [];
  private opportunities: CanonicalOpportunity[] = [];
  private owners: CanonicalOwner[] = [
    { id: 'owner_1', name: 'Priya Raman', email: 'priya@tenant.example', active: true },
    { id: 'owner_2', name: 'Tom Haslett', email: 'tom@tenant.example', active: true },
  ];
  private sequence = 0;

  constructor(private readonly options: SandboxOptions = {}) {}

  capabilities(): CapabilityDeclaration {
    return {
      connector: this.name, tier: 1,
      personSearchByEmail: 'FULL',
      idempotentUpsert: 'FULL',
      organisationResolutionByDomain: 'FULL',
      opportunityReadWithStageAndOwner: 'FULL',
      associationWrite: 'FULL',
      meetingEngagementWrite: 'FULL',
      changeNotification: 'FULL',
      duplicateDetectionOrMerge: 'NONE',
      fieldHistory: 'NONE',
      customFields: 'FULL',
      sandbox: 'FULL',
      dedicatedErasureEndpoint: 'FULL',
      hasSeparateLeadObject: this.options.hasSeparateLeadObject ?? true,
      rateLimit: { requestsPerSecond: 100, searchRequestsPerSecond: 100 },
      degradationNotes: ['Reference implementation. Not a production CRM.'],
    };
  }

  // --- test fixtures ------------------------------------------------------

  seed(record: Omit<SandboxRecord, 'id' | 'lastModified'> & { id?: string }): SandboxRecord {
    const stored: SandboxRecord = {
      ...record,
      id: record.id ?? `sbx_${++this.sequence}`,
      lastModified: new Date().toISOString(),
    };
    this.records.set(stored.id, stored);
    return stored;
  }

  seedOpportunity(opportunity: CanonicalOpportunity): void {
    this.opportunities.push(opportunity);
  }

  setOwners(owners: CanonicalOwner[]): void { this.owners = owners; }

  private maybeFail(): void {
    if ((this.options.failNextWrites ?? 0) > 0) {
      (this.options as { failNextWrites?: number }).failNextWrites!--;
      throw new AwaError({
        kind: this.options.failureKind ?? 'UPSTREAM_UNAVAILABLE',
        message: 'sandbox injected failure',
      });
    }
  }

  // --- reads --------------------------------------------------------------

  async searchPerson(_credential: Credential, query: PersonQuery): Promise<MatchCandidate[]> {
    const matches = [...this.records.values()].filter((record) => {
      if (record.objectType === 'organisation') return false;
      if (query.email && record.email?.toLowerCase() === query.email.toLowerCase()) return true;
      if (query.phoneE164 && record.phone === query.phoneE164) return true;
      if (query.name && record.name?.toLowerCase() === query.name.toLowerCase()) return true;
      return false;
    });
    return matches.map((record) => ({
      externalId: record.id,
      objectType: record.objectType,
      email: record.email,
      phone: record.phone,
      name: record.name,
      organisationName: record.organisationName,
      organisationDomain: record.domain,
      ownerRef: record.ownerRef,
      lifecycleStage: record.lifecycleStage,
      lastModified: record.lastModified,
    }));
  }

  async searchOrganisation(_credential: Credential, query: OrganisationQuery): Promise<MatchCandidate[]> {
    return [...this.records.values()]
      .filter((r) => r.objectType === 'organisation' && (
        (query.domain && r.domain === query.domain) ||
        (query.name && r.name?.toLowerCase() === query.name.toLowerCase())
      ))
      .map((r) => ({ externalId: r.id, objectType: 'organisation' as const, name: r.name, organisationDomain: r.domain, ownerRef: r.ownerRef }));
  }

  async readOpportunities(_credential: Credential, personExternalId: string): Promise<CanonicalOpportunity[]> {
    return this.opportunities.filter((o) => o.personRef === personExternalId);
  }

  async readOwners(): Promise<CanonicalOwner[]> { return this.owners; }

  async readPipelines(): Promise<CanonicalPipeline[]> {
    return [{
      id: 'default',
      label: 'New business',
      stages: [
        { id: 'discovery', label: 'Discovery', isOpen: true, isClosedWon: false, order: 0 },
        { id: 'proposal', label: 'Proposal', isOpen: true, isClosedWon: false, order: 1 },
        { id: 'closedwon', label: 'Closed won', isOpen: false, isClosedWon: true, order: 2 },
        { id: 'closedlost', label: 'Closed lost', isOpen: false, isClosedWon: false, order: 3 },
      ],
    }];
  }

  // --- writes -------------------------------------------------------------

  async upsertPerson(_credential: Credential, person: CanonicalPerson, idempotencyKey: string): Promise<WriteResult> {
    this.maybeFail();
    const email = person.emails[0];
    if (!email) throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'sandbox upsertPerson requires an email' });

    // Idempotent on the write key first, then on email — the same order a real
    // native-upsert CRM resolves in.
    const existing =
      [...this.records.values()].find((r) => r.writeKey === idempotencyKey) ??
      [...this.records.values()].find((r) => r.objectType !== 'organisation' && r.email?.toLowerCase() === email.toLowerCase());

    const objectType: SandboxRecord['objectType'] =
      this.capabilities().hasSeparateLeadObject && person.qualificationState !== 'QUALIFIED' ? 'lead' : 'contact';

    if (existing) {
      // Note what is not touched: ownerRef and lifecycleStage. They are
      // CRM-authoritative, and overwriting them is the single failure a RevOps
      // buyer will not forgive.
      Object.assign(existing, {
        email,
        phone: person.phones?.[0] ?? existing.phone,
        name: person.name?.full ?? ([person.name?.given, person.name?.family].filter(Boolean).join(' ') || existing.name),
        jobTitle: person.jobTitle ?? existing.jobTitle,
        organisationName: person.organisation?.name ?? existing.organisationName,
        qualificationState: person.qualificationState,
        writeKey: idempotencyKey,
        lastModified: new Date().toISOString(),
      });
      return { externalId: existing.id, created: false, connector: this.name, objectType: existing.objectType };
    }

    const created = this.seed({
      objectType,
      email,
      phone: person.phones?.[0],
      name: person.name?.full ?? [person.name?.given, person.name?.family].filter(Boolean).join(' '),
      jobTitle: person.jobTitle,
      organisationName: person.organisation?.name,
      qualificationState: person.qualificationState,
      writeKey: idempotencyKey,
    });
    return { externalId: created.id, created: true, connector: this.name, objectType };
  }

  async upsertOrganisation(_credential: Credential, organisation: CanonicalOrganisation, idempotencyKey: string): Promise<WriteResult> {
    this.maybeFail();
    const domain = organisation.domains[0];
    const existing = [...this.records.values()].find((r) => r.objectType === 'organisation' && r.domain === domain);
    if (existing) return { externalId: existing.id, created: false, connector: this.name, objectType: 'organisation' };
    const created = this.seed({ objectType: 'organisation', name: organisation.name, domain, writeKey: idempotencyKey });
    return { externalId: created.id, created: true, connector: this.name, objectType: 'organisation' };
  }

  private addActivity(activity: CanonicalActivity, objectType: string): WriteResult {
    this.maybeFail();
    const id = `act_${++this.sequence}`;
    this.activities.push({ ...activity, id, objectType });
    return { externalId: id, created: true, connector: this.name, objectType };
  }

  async createNote(_c: Credential, activity: CanonicalActivity): Promise<WriteResult> { return this.addActivity(activity, 'note'); }
  async createTask(_c: Credential, activity: CanonicalActivity): Promise<WriteResult> { return this.addActivity(activity, 'task'); }
  async createMeeting(_c: Credential, activity: CanonicalActivity): Promise<WriteResult> { return this.addActivity(activity, 'meeting'); }

  async associate(_c: Credential, from: { type: string; id: string }, to: { type: string; id: string }, type: AssociationType): Promise<WriteResult> {
    this.maybeFail();
    this.associations.push({ from: from.id, to: to.id, type });
    return { externalId: `${from.id}:${to.id}`, created: true, connector: this.name, objectType: `association:${type}` };
  }

  async subscribeChanges(_c: Credential, callbackUrl: string): Promise<Subscription> {
    return { id: 'sandbox-sub', callbackUrl, events: ['person.changed'] };
  }

  async eraseSubject(_c: Credential, externalId: string): Promise<void> {
    this.records.delete(externalId);
  }
}
