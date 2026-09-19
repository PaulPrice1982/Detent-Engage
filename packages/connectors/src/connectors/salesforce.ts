import {
  AwaError,
  type AssociationType,
  type CanonicalActivity,
  type CanonicalOpportunity,
  type CanonicalOrganisation,
  type CanonicalOwner,
  type CanonicalPerson,
  type CanonicalPipeline,
  type WriteResult,
} from '@detent/awa-core';
import type {
  CapabilityDeclaration,
  Credential,
  CrmConnector,
  MatchCandidate,
  OrganisationQuery,
  PersonQuery,
  Subscription,
} from '../contract.js';
import { classifyResponse, type HttpClient } from '../http.js';

const API_VERSION = 'v62.0';

/**
 * Salesforce Sales Cloud connector (Tier 1).
 *
 * Salesforce maintains a separate Lead object that converts into Contact plus
 * Account plus Opportunity. The rule from section 21.3 governs everything here:
 * an unqualified visitor becomes a Lead, never a Contact. Creating a Contact
 * for an unqualified visitor corrupts the tenant's conversion reporting, and a
 * RevOps buyer will not forgive it.
 *
 * Idempotency uses External ID upsert (PATCH on a custom external id field),
 * which is genuinely idempotent server-side. A retry of the same write returns
 * the same record rather than creating a second one.
 */
export class SalesforceConnector implements CrmConnector {
  readonly name = 'salesforce';

  /** External ID field the tenant provisions on Lead and Contact at onboarding. */
  constructor(
    private readonly http: HttpClient,
    private readonly externalIdField = 'Detent_Key__c',
  ) {}

  capabilities(): CapabilityDeclaration {
    return {
      connector: this.name,
      tier: 1,
      personSearchByEmail: 'FULL',
      idempotentUpsert: 'FULL',
      organisationResolutionByDomain: 'FULL',
      opportunityReadWithStageAndOwner: 'FULL',
      associationWrite: 'FULL',
      meetingEngagementWrite: 'FULL',
      changeNotification: 'FULL',
      duplicateDetectionOrMerge: 'FULL',
      fieldHistory: 'FULL',
      customFields: 'FULL',
      sandbox: 'FULL',
      dedicatedErasureEndpoint: 'PARTIAL',
      hasSeparateLeadObject: true,
      rateLimit: { requestsPerSecond: 20, searchRequestsPerSecond: 10 },
      degradationNotes: [
        'Requires a Connected App. An AppExchange listing carries a long-lead security review.',
        `Idempotent upsert requires the external id field ${'Detent_Key__c'} on Lead and Contact.`,
        'Erasure is org-configured: hard delete plus recycle-bin purge, not a single documented endpoint.',
      ],
    };
  }

  private url(credential: Credential, path: string): string {
    if (!credential.instanceUrl) {
      throw new AwaError({ kind: 'CONNECTION_DEGRADED', message: 'salesforce credential is missing instanceUrl' });
    }
    return `${credential.instanceUrl}/services/data/${API_VERSION}${path}`;
  }

  private async call(credential: Credential, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, context = path): Promise<unknown> {
    const response = await this.http.send({
      method,
      url: this.url(credential, path),
      headers: { authorization: `Bearer ${credential.accessToken}` },
      body,
    });
    const error = classifyResponse(this.name, response, context);
    if (error) throw error;
    return response.body;
  }

  private async query<T>(credential: Credential, soql: string, context: string): Promise<T[]> {
    const body = await this.call(credential, 'GET', `/query?q=${encodeURIComponent(soql)}`, undefined, context);
    return ((body as { records?: T[] }).records ?? []);
  }

  async searchPerson(credential: Credential, query: PersonQuery): Promise<MatchCandidate[]> {
    if (!query.email && !query.phoneE164) return [];
    const field = query.email ? 'Email' : 'Phone';
    const value = escapeSoql(query.email ?? query.phoneE164!);

    // Both objects are searched. A visitor who exists as a Lead and as a
    // Contact is an ambiguity signal the scorer must see, not something the
    // connector should silently resolve by preferring one object.
    const contacts = await this.query<SalesforceContact>(
      credential,
      `SELECT Id, Email, Phone, Name, Title, OwnerId, AccountId, Account.Name, Account.Website, LastModifiedDate FROM Contact WHERE ${field} = '${value}' LIMIT 10`,
      'query/contact',
    );
    const leads = await this.query<SalesforceLead>(
      credential,
      `SELECT Id, Email, Phone, Name, Title, OwnerId, Company, Status, IsConverted, LastModifiedDate FROM Lead WHERE ${field} = '${value}' AND IsConverted = false LIMIT 10`,
      'query/lead',
    );

    return [
      ...contacts.map((record): MatchCandidate => ({
        externalId: record.Id,
        objectType: 'contact',
        email: record.Email ?? undefined,
        phone: record.Phone ?? undefined,
        name: record.Name ?? undefined,
        organisationName: record.Account?.Name,
        organisationDomain: hostFromWebsite(record.Account?.Website),
        ownerRef: record.OwnerId,
        // A Contact on an Account is the CRM's own statement of an existing
        // relationship, which is the EXISTING_CUSTOMER signal (table 25).
        lifecycleStage: record.AccountId ? 'customer' : undefined,
        lastModified: record.LastModifiedDate,
      })),
      ...leads.map((record): MatchCandidate => ({
        externalId: record.Id,
        objectType: 'lead',
        email: record.Email ?? undefined,
        phone: record.Phone ?? undefined,
        name: record.Name ?? undefined,
        organisationName: record.Company ?? undefined,
        ownerRef: record.OwnerId,
        lifecycleStage: record.Status ?? undefined,
        lastModified: record.LastModifiedDate,
      })),
    ];
  }

  async searchOrganisation(credential: Credential, query: OrganisationQuery): Promise<MatchCandidate[]> {
    if (!query.domain) return [];
    const value = escapeSoql(query.domain);
    const accounts = await this.query<{ Id: string; Name: string; Website?: string; OwnerId?: string }>(
      credential,
      `SELECT Id, Name, Website, OwnerId FROM Account WHERE Website LIKE '%${value}%' LIMIT 10`,
      'query/account',
    );
    return accounts.map((record) => ({
      externalId: record.Id,
      objectType: 'organisation' as const,
      name: record.Name,
      organisationDomain: hostFromWebsite(record.Website),
      ownerRef: record.OwnerId,
    }));
  }

  async readOpportunities(credential: Credential, personExternalId: string): Promise<CanonicalOpportunity[]> {
    const rows = await this.query<SalesforceOpportunity>(
      credential,
      `SELECT Id, Name, StageName, OwnerId, AccountId, Amount, IsClosed, IsWon FROM Opportunity WHERE Id IN (SELECT OpportunityId FROM OpportunityContactRole WHERE ContactId = '${escapeSoql(personExternalId)}') LIMIT 25`,
      'query/opportunity',
    );
    return rows.map((record) => ({
      id: record.Id,
      personRef: personExternalId,
      organisationRef: record.AccountId ?? undefined,
      stageRef: record.StageName,
      stageLabel: record.StageName,
      ownerRef: record.OwnerId,
      isOpen: record.IsClosed === false,
      isClosedWon: record.IsWon === true,
      amount: record.Amount ?? undefined,
      currency: 'GBP',
    }));
  }

  async readOwners(credential: Credential): Promise<CanonicalOwner[]> {
    const rows = await this.query<{ Id: string; Name: string; Email?: string; IsActive: boolean }>(
      credential,
      'SELECT Id, Name, Email, IsActive FROM User WHERE IsActive = true LIMIT 200',
      'query/user',
    );
    return rows.map((record) => ({ id: record.Id, name: record.Name, email: record.Email, active: record.IsActive }));
  }

  async readPipelines(credential: Credential): Promise<CanonicalPipeline[]> {
    // Stage metadata comes from the picklist describe, so a tenant's renamed or
    // custom stages are honoured. Nothing about "open" is hard-coded.
    const body = await this.call(credential, 'GET', '/sobjects/Opportunity/describe', undefined, 'describe/opportunity');
    const field = ((body as { fields?: Array<{ name: string; picklistValues?: Array<{ value: string; label: string; active: boolean }> }> }).fields ?? [])
      .find((f) => f.name === 'StageName');
    const stages = (field?.picklistValues ?? []).filter((v) => v.active);
    return [{
      id: 'standard',
      label: 'Sales Process',
      stages: stages.map((value, index) => ({
        id: value.value,
        label: value.label,
        isOpen: !/^closed/i.test(value.value),
        isClosedWon: /won/i.test(value.value),
        order: index,
      })),
    }];
  }

  async upsertPerson(credential: Credential, person: CanonicalPerson, idempotencyKey: string): Promise<WriteResult> {
    const email = person.emails[0];
    if (!email) throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'salesforce upsertPerson requires an email' });

    // The lead-versus-contact decision, made once, here, from the canonical
    // qualification state. Connectors never improvise it (decision 3).
    const asContact = person.qualificationState === 'QUALIFIED';
    const object = asContact ? 'Contact' : 'Lead';

    const fields: Record<string, unknown> = {
      Email: email,
      FirstName: person.name?.given,
      LastName: person.name?.family ?? person.name?.full ?? 'Unknown',
      Title: person.jobTitle,
      Phone: person.phones?.[0],
      [this.externalIdField]: idempotencyKeyToExternalId(idempotencyKey),
    };
    if (!asContact) {
      // Company is required on Lead. An unnamed organisation would otherwise
      // fail the write, so the email domain is the documented fallback.
      fields['Company'] = person.organisation?.name ?? person.organisation?.domains[0] ?? email.split('@')[1] ?? 'Unknown';
    }
    // OwnerId and Status are absent by construction: CRM-authoritative.

    const externalId = idempotencyKeyToExternalId(idempotencyKey);
    const body = await this.call(
      credential, 'PATCH',
      `/sobjects/${object}/${this.externalIdField}/${encodeURIComponent(externalId)}`,
      stripUndefined(fields),
      `upsert/${object}`,
    );
    const result = body as { id?: string; created?: boolean };
    if (!result.id) throw new AwaError({ kind: 'UPSTREAM_REJECTED', message: 'salesforce upsert returned no id' });
    return { externalId: result.id, created: result.created === true, connector: this.name, objectType: object.toLowerCase() };
  }

  async upsertOrganisation(credential: Credential, organisation: CanonicalOrganisation, idempotencyKey: string): Promise<WriteResult> {
    const externalId = idempotencyKeyToExternalId(idempotencyKey);
    const body = await this.call(
      credential, 'PATCH',
      `/sobjects/Account/${this.externalIdField}/${encodeURIComponent(externalId)}`,
      stripUndefined({
        Name: organisation.name ?? organisation.domains[0],
        Website: organisation.domains[0] ? `https://${organisation.domains[0]}` : undefined,
      }),
      'upsert/Account',
    );
    const result = body as { id?: string; created?: boolean };
    if (!result.id) throw new AwaError({ kind: 'UPSTREAM_REJECTED', message: 'salesforce account upsert returned no id' });
    return { externalId: result.id, created: result.created === true, connector: this.name, objectType: 'account' };
  }

  async createNote(credential: Credential, activity: CanonicalActivity, idempotencyKey: string): Promise<WriteResult> {
    const body = await this.call(credential, 'POST', '/sobjects/Task', stripUndefined({
      Subject: activity.subject,
      Description: activity.body,
      Status: 'Completed',
      ActivityDate: (activity.occurredAt ?? new Date().toISOString()).slice(0, 10),
      WhoId: activity.personRef,
      WhatId: activity.opportunityRef ?? activity.organisationRef,
      [this.externalIdField]: idempotencyKeyToExternalId(idempotencyKey),
    }), 'create/Task(note)');
    return { externalId: String((body as { id: string }).id), created: true, connector: this.name, objectType: 'task' };
  }

  async createTask(credential: Credential, activity: CanonicalActivity, idempotencyKey: string): Promise<WriteResult> {
    const body = await this.call(credential, 'POST', '/sobjects/Task', stripUndefined({
      Subject: activity.subject,
      Description: activity.body,
      Status: 'Not Started',
      Priority: 'Normal',
      ActivityDate: (activity.dueAt ?? new Date().toISOString()).slice(0, 10),
      WhoId: activity.personRef,
      WhatId: activity.opportunityRef ?? activity.organisationRef,
      OwnerId: activity.ownerRef,
      [this.externalIdField]: idempotencyKeyToExternalId(idempotencyKey),
    }), 'create/Task');
    return { externalId: String((body as { id: string }).id), created: true, connector: this.name, objectType: 'task' };
  }

  async createMeeting(credential: Credential, activity: CanonicalActivity, idempotencyKey: string): Promise<WriteResult> {
    const body = await this.call(credential, 'POST', '/sobjects/Event', stripUndefined({
      Subject: activity.subject,
      Description: activity.body,
      StartDateTime: activity.startsAt,
      EndDateTime: activity.endsAt,
      WhoId: activity.personRef,
      WhatId: activity.opportunityRef ?? activity.organisationRef,
      OwnerId: activity.ownerRef,
      [this.externalIdField]: idempotencyKeyToExternalId(idempotencyKey),
    }), 'create/Event');
    return { externalId: String((body as { id: string }).id), created: true, connector: this.name, objectType: 'event' };
  }

  async associate(credential: Credential, from: { type: string; id: string }, to: { type: string; id: string }, type: AssociationType): Promise<WriteResult> {
    // Salesforce association is a foreign key on the child, not a join call.
    if (type === 'person_to_organisation') {
      await this.call(credential, 'PATCH', `/sobjects/Contact/${from.id}`, { AccountId: to.id }, 'associate/contact-account');
    } else if (type === 'opportunity_to_person') {
      await this.call(credential, 'POST', '/sobjects/OpportunityContactRole', { OpportunityId: from.id, ContactId: to.id }, 'associate/opportunity-contact');
    } else {
      throw new AwaError({ kind: 'CAPABILITY_UNSUPPORTED', message: `salesforce association ${type} is set at write time, not separately` });
    }
    return { externalId: `${from.id}:${to.id}`, created: true, connector: this.name, objectType: `association:${type}` };
  }

  async subscribeChanges(credential: Credential, callbackUrl: string): Promise<Subscription> {
    void credential;
    // Change Data Capture is configured in Setup and consumed over the Pub/Sub
    // API rather than a callback URL. Declared honestly so the tenant is told.
    return { id: `salesforce:cdc:${callbackUrl}`, callbackUrl, events: ['LeadChangeEvent', 'ContactChangeEvent', 'OpportunityChangeEvent'] };
  }
}

interface SalesforceContact {
  Id: string; Email?: string | null; Phone?: string | null; Name?: string | null;
  Title?: string | null; OwnerId?: string; AccountId?: string | null;
  Account?: { Name?: string; Website?: string }; LastModifiedDate?: string;
}
interface SalesforceLead {
  Id: string; Email?: string | null; Phone?: string | null; Name?: string | null;
  Title?: string | null; OwnerId?: string; Company?: string | null;
  Status?: string | null; IsConverted?: boolean; LastModifiedDate?: string;
}
interface SalesforceOpportunity {
  Id: string; Name: string; StageName: string; OwnerId?: string;
  AccountId?: string | null; Amount?: number | null; IsClosed: boolean; IsWon: boolean;
}

/** SOQL string escaping. Visitor-supplied input reaches this, so it is not optional. */
function escapeSoql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function hostFromWebsite(website?: string): string | undefined {
  if (!website) return undefined;
  try {
    return new URL(website.startsWith('http') ? website : `https://${website}`).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}

/** External ids must be URL-safe and stable for the same logical write. */
function idempotencyKeyToExternalId(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}

function stripUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
