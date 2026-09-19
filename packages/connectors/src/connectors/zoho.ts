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
import { classifyResponse, type HttpClient } from '../http.js';

/**
 * Zoho CRM connector (Tier 1).
 *
 * Two Zoho specifics: the API host is data-centre bound, so the token is only
 * valid against the region it was issued in, and the upsert endpoint is a real
 * server-side upsert keyed on duplicate-check fields. Getting the region wrong
 * produces a confusing 401 that looks like a revoked grant, so the credential
 * carries the region and the connector refuses rather than guessing.
 */
const REGION_HOSTS: Record<string, string> = {
  eu: 'https://www.zohoapis.eu',
  com: 'https://www.zohoapis.com',
  in: 'https://www.zohoapis.in',
  'com.au': 'https://www.zohoapis.com.au',
  jp: 'https://www.zohoapis.jp',
  ca: 'https://www.zohoapiscloud.ca',
};

export class ZohoConnector implements CrmConnector {
  readonly name = 'zoho';

  constructor(private readonly http: HttpClient) {}

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
      duplicateDetectionOrMerge: 'PARTIAL',
      fieldHistory: 'PARTIAL',
      customFields: 'FULL',
      sandbox: 'PARTIAL',
      dedicatedErasureEndpoint: 'PARTIAL',
      hasSeparateLeadObject: true,
      rateLimit: { requestsPerSecond: 10, searchRequestsPerSecond: 5 },
      degradationNotes: [
        'Endpoints are data-centre specific and the OAuth token is region-bound. The region is stored with the credential.',
        'Sandbox availability depends on edition; a paid test organisation is provisioned where none is available.',
      ],
    };
  }

  private base(credential: Credential): string {
    const host = REGION_HOSTS[credential.region ?? 'eu'];
    if (!host) {
      throw new AwaError({
        kind: 'CONNECTION_DEGRADED',
        message: `zoho credential has unknown region '${credential.region}'; reconnect required`,
      });
    }
    return `${host}/crm/v7`;
  }

  private async call(credential: Credential, method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, context = path): Promise<unknown> {
    const response = await this.http.send({
      method,
      url: `${this.base(credential)}${path}`,
      headers: { authorization: `Zoho-oauthtoken ${credential.accessToken}` },
      body,
    });
    const error = classifyResponse(this.name, response, context);
    if (error) throw error;
    return response.body;
  }

  async searchPerson(credential: Credential, query: PersonQuery): Promise<MatchCandidate[]> {
    if (!query.email && !query.phoneE164) return [];
    const criteria = query.email ? `(Email:equals:${query.email})` : `(Phone:equals:${query.phoneE164})`;
    const candidates: MatchCandidate[] = [];

    // Both modules are searched, for the same reason as Salesforce: a person
    // present as both a Lead and a Contact is an ambiguity signal.
    for (const [module, objectType] of [['Contacts', 'contact'], ['Leads', 'lead']] as const) {
      try {
        const body = await this.call(credential, 'GET', `/${module}/search?criteria=${encodeURIComponent(criteria)}`, undefined, `${module}/search`);
        const rows = (body as { data?: ZohoRecord[] }).data ?? [];
        candidates.push(...rows.map((row) => ({
          externalId: String(row.id),
          objectType,
          email: row.Email ?? undefined,
          phone: row.Phone ?? undefined,
          name: row.Full_Name ?? ([row.First_Name, row.Last_Name].filter(Boolean).join(' ') || undefined),
          organisationName: row.Account_Name?.name ?? row.Company ?? undefined,
          ownerRef: row.Owner?.id ? String(row.Owner.id) : undefined,
          lifecycleStage: row.Lead_Status ?? (objectType === 'contact' ? 'customer' : undefined),
          lastModified: row.Modified_Time,
        })));
      } catch (cause) {
        // Zoho returns 204 with no body for an empty search, which the HTTP
        // layer surfaces as NOT_FOUND. That is an empty result, not a failure.
        if (cause instanceof AwaError && cause.kind === 'NOT_FOUND') continue;
        throw cause;
      }
    }
    return candidates;
  }

  async searchOrganisation(credential: Credential, query: OrganisationQuery): Promise<MatchCandidate[]> {
    if (!query.domain && !query.name) return [];
    const criteria = query.domain ? `(Website:contains:${query.domain})` : `(Account_Name:equals:${query.name})`;
    try {
      const body = await this.call(credential, 'GET', `/Accounts/search?criteria=${encodeURIComponent(criteria)}`, undefined, 'Accounts/search');
      return ((body as { data?: ZohoRecord[] }).data ?? []).map((row) => ({
        externalId: String(row.id),
        objectType: 'organisation' as const,
        name: row.Account_Name?.name ?? row.Company ?? undefined,
        organisationDomain: query.domain,
        ownerRef: row.Owner?.id ? String(row.Owner.id) : undefined,
      }));
    } catch (cause) {
      if (cause instanceof AwaError && cause.kind === 'NOT_FOUND') return [];
      throw cause;
    }
  }

  async readOpportunities(credential: Credential, personExternalId: string): Promise<CanonicalOpportunity[]> {
    try {
      const body = await this.call(credential, 'GET', `/Contacts/${encodeURIComponent(personExternalId)}/Deals`, undefined, 'Contacts/Deals');
      return ((body as { data?: ZohoDeal[] }).data ?? []).map((deal) => ({
        id: String(deal.id),
        personRef: personExternalId,
        stageRef: deal.Stage,
        stageLabel: deal.Stage,
        ownerRef: deal.Owner?.id ? String(deal.Owner.id) : undefined,
        isOpen: !/closed/i.test(deal.Stage ?? ''),
        isClosedWon: /won/i.test(deal.Stage ?? ''),
        amount: deal.Amount ?? undefined,
        currency: deal.Currency ?? 'GBP',
      }));
    } catch (cause) {
      if (cause instanceof AwaError && cause.kind === 'NOT_FOUND') return [];
      throw cause;
    }
  }

  async readOwners(credential: Credential): Promise<CanonicalOwner[]> {
    const body = await this.call(credential, 'GET', '/users?type=ActiveUsers', undefined, 'users');
    return ((body as { users?: Array<{ id: string; full_name: string; email?: string; status?: string }> }).users ?? [])
      .map((user) => ({ id: user.id, name: user.full_name, email: user.email, active: user.status !== 'inactive' }));
  }

  async readPipelines(credential: Credential): Promise<CanonicalPipeline[]> {
    const body = await this.call(credential, 'GET', '/settings/fields?module=Deals', undefined, 'settings/fields');
    const stageField = ((body as { fields?: Array<{ api_name: string; pick_list_values?: Array<{ display_value: string; actual_value: string }> }> }).fields ?? [])
      .find((field) => field.api_name === 'Stage');
    const values = stageField?.pick_list_values ?? [];
    return [{
      id: 'standard',
      label: 'Deals',
      stages: values.map((value, index) => ({
        id: value.actual_value,
        label: value.display_value,
        isOpen: !/closed/i.test(value.actual_value),
        isClosedWon: /won/i.test(value.actual_value),
        order: index,
      })),
    }];
  }

  async upsertPerson(credential: Credential, person: CanonicalPerson, idempotencyKey: string): Promise<WriteResult> {
    const email = person.emails[0];
    if (!email) throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'zoho upsertPerson requires an email' });

    // Lead versus Contact, decided from the canonical qualification state.
    const module = person.qualificationState === 'QUALIFIED' ? 'Contacts' : 'Leads';
    const record: Record<string, unknown> = {
      Email: email,
      First_Name: person.name?.given,
      Last_Name: person.name?.family ?? person.name?.full ?? 'Unknown',
      Title: person.jobTitle,
      Phone: person.phones?.[0],
      Detent_Key: idempotencyKey,
    };
    if (module === 'Leads') {
      record['Company'] = person.organisation?.name ?? email.split('@')[1] ?? 'Unknown';
    }

    const body = await this.call(credential, 'POST', `/${module}/upsert`, {
      data: [stripUndefined(record)],
      duplicate_check_fields: ['Email'],
    }, `${module}/upsert`);

    const result = ((body as { data?: Array<{ code?: string; details?: { id?: string }; action?: string }> }).data ?? [])[0];
    if (!result?.details?.id) throw new AwaError({ kind: 'UPSTREAM_REJECTED', message: 'zoho upsert returned no id', details: { body } });
    return {
      externalId: result.details.id,
      created: result.action === 'insert',
      connector: this.name,
      objectType: module.toLowerCase(),
    };
  }

  async upsertOrganisation(credential: Credential, organisation: CanonicalOrganisation, idempotencyKey: string): Promise<WriteResult> {
    const name = organisation.name ?? organisation.domains[0];
    if (!name) throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'zoho upsertOrganisation requires a name or domain' });
    const body = await this.call(credential, 'POST', '/Accounts/upsert', {
      data: [stripUndefined({
        Account_Name: name,
        Website: organisation.domains[0] ? `https://${organisation.domains[0]}` : undefined,
        Detent_Key: idempotencyKey,
      })],
      duplicate_check_fields: ['Account_Name'],
    }, 'Accounts/upsert');
    const result = ((body as { data?: Array<{ details?: { id?: string }; action?: string }> }).data ?? [])[0];
    if (!result?.details?.id) throw new AwaError({ kind: 'UPSTREAM_REJECTED', message: 'zoho account upsert returned no id' });
    return { externalId: result.details.id, created: result.action === 'insert', connector: this.name, objectType: 'account' };
  }

  async createNote(credential: Credential, activity: CanonicalActivity, _idempotencyKey: string): Promise<WriteResult> {
    const body = await this.call(credential, 'POST', '/Notes', {
      data: [stripUndefined({
        Note_Title: activity.subject,
        Note_Content: activity.body,
        Parent_Id: activity.personRef,
        se_module: 'Contacts',
      })],
    }, 'Notes');
    return { externalId: extractId(body), created: true, connector: this.name, objectType: 'note' };
  }

  async createTask(credential: Credential, activity: CanonicalActivity, _idempotencyKey: string): Promise<WriteResult> {
    const body = await this.call(credential, 'POST', '/Tasks', {
      data: [stripUndefined({
        Subject: activity.subject,
        Description: activity.body,
        Status: 'Not Started',
        Due_Date: activity.dueAt?.slice(0, 10),
        Who_Id: activity.personRef,
        Owner: activity.ownerRef ? { id: activity.ownerRef } : undefined,
      })],
    }, 'Tasks');
    return { externalId: extractId(body), created: true, connector: this.name, objectType: 'task' };
  }

  async createMeeting(credential: Credential, activity: CanonicalActivity, _idempotencyKey: string): Promise<WriteResult> {
    const body = await this.call(credential, 'POST', '/Events', {
      data: [stripUndefined({
        Event_Title: activity.subject,
        Description: activity.body,
        Start_DateTime: activity.startsAt,
        End_DateTime: activity.endsAt,
        Who_Id: activity.personRef,
        Owner: activity.ownerRef ? { id: activity.ownerRef } : undefined,
      })],
    }, 'Events');
    return { externalId: extractId(body), created: true, connector: this.name, objectType: 'event' };
  }

  async associate(credential: Credential, from: { type: string; id: string }, to: { type: string; id: string }, type: AssociationType): Promise<WriteResult> {
    if (type !== 'person_to_organisation') {
      throw new AwaError({ kind: 'CAPABILITY_UNSUPPORTED', message: `zoho sets ${type} at write time` });
    }
    await this.call(credential, 'PUT', '/Contacts', { data: [{ id: from.id, Account_Name: { id: to.id } }] }, 'Contacts/associate');
    return { externalId: `${from.id}:${to.id}`, created: true, connector: this.name, objectType: `association:${type}` };
  }

  async subscribeChanges(credential: Credential, callbackUrl: string): Promise<Subscription> {
    const body = await this.call(credential, 'POST', '/actions/watch', {
      watch: [{ channel_id: Date.now().toString(), events: ['Contacts.all', 'Leads.all'], notify_url: callbackUrl }],
    }, 'actions/watch');
    void body;
    return { id: `zoho:${callbackUrl}`, callbackUrl, events: ['Contacts.all', 'Leads.all'] };
  }
}

interface ZohoRecord {
  id: string; Email?: string; Phone?: string; Full_Name?: string;
  First_Name?: string; Last_Name?: string; Company?: string;
  Account_Name?: { name?: string; id?: string }; Owner?: { id?: string };
  Lead_Status?: string; Modified_Time?: string;
}
interface ZohoDeal { id: string; Stage?: string; Amount?: number; Currency?: string; Owner?: { id?: string } }

function extractId(body: unknown): string {
  const id = ((body as { data?: Array<{ details?: { id?: string } }> }).data ?? [])[0]?.details?.id;
  if (!id) throw new AwaError({ kind: 'UPSTREAM_REJECTED', message: 'zoho write returned no id' });
  return id;
}

function stripUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
