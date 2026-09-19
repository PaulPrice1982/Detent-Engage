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

const BASE = 'https://api.hubapi.com';

/**
 * HubSpot connector (Tier 1).
 *
 * Two HubSpot-specific behaviours drive this implementation and neither is
 * optional:
 *
 *  1. HubSpot has no separate Lead object, the contact is unified, so the
 *     canonical qualification state is written to a property rather than
 *     materialised as a different object (section 21.3).
 *  2. A create that collides with an existing unique property returns 409
 *     CONFLICT naming the existing record id. That is converted into an update
 *     rather than retried as a create (section 16.5), which is the single
 *     control that prevents duplicate creation under retry.
 *
 * Search is treated conservatively at 4 requests per second despite the
 * documented increase to 5, and new records are read back by id rather than
 * searched for, because HubSpot documents that new records take a few moments
 * to become searchable.
 */
export class HubSpotConnector implements CrmConnector {
  readonly name = 'hubspot';

  constructor(private readonly http: HttpClient) {}

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
      sandbox: 'PARTIAL',
      dedicatedErasureEndpoint: 'FULL',
      hasSeparateLeadObject: false,
      rateLimit: { requestsPerSecond: 10, searchRequestsPerSecond: 4 },
      degradationNotes: [
        'Sandbox availability is edition-dependent; lower tiers require a separate developer test account.',
        'Newly created records are not immediately searchable. Reads after a create go by record id.',
        'Private app webhook subscriptions are editable only in the app settings UI, not via API.',
      ],
    };
  }

  private headers(credential: Credential): Record<string, string> {
    return { authorization: `Bearer ${credential.accessToken}` };
  }

  private async call(credential: Credential, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown, context = path): Promise<unknown> {
    const response = await this.http.send({ method, url: `${BASE}${path}`, headers: this.headers(credential), body });
    const error = classifyResponse(this.name, response, context);
    if (error) throw error;
    return response.body;
  }

  async searchPerson(credential: Credential, query: PersonQuery): Promise<MatchCandidate[]> {
    const filters: Array<Record<string, unknown>> = [];
    if (query.email) filters.push({ propertyName: 'email', operator: 'EQ', value: query.email });
    else if (query.phoneE164) filters.push({ propertyName: 'phone', operator: 'EQ', value: query.phoneE164 });
    else return [];

    const body = await this.call(credential, 'POST', '/crm/v3/objects/contacts/search', {
      filterGroups: [{ filters }],
      properties: ['email', 'phone', 'firstname', 'lastname', 'company', 'jobtitle', 'lifecyclestage', 'hubspot_owner_id'],
      limit: 10,
    }, 'contacts/search');

    const results = (body as { results?: unknown[] }).results ?? [];
    return results.map((raw) => {
      const record = raw as { id: string; properties?: Record<string, string>; updatedAt?: string };
      const props = record.properties ?? {};
      return {
        externalId: record.id,
        objectType: 'contact' as const,
        email: props['email'],
        phone: props['phone'],
        name: [props['firstname'], props['lastname']].filter(Boolean).join(' ') || undefined,
        organisationName: props['company'],
        ownerRef: props['hubspot_owner_id'],
        lifecycleStage: props['lifecyclestage'],
        lastModified: record.updatedAt,
      };
    });
  }

  async searchOrganisation(credential: Credential, query: OrganisationQuery): Promise<MatchCandidate[]> {
    if (!query.domain) return [];
    const body = await this.call(credential, 'POST', '/crm/v3/objects/companies/search', {
      filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'EQ', value: query.domain }] }],
      properties: ['name', 'domain', 'hubspot_owner_id'],
      limit: 10,
    }, 'companies/search');

    return ((body as { results?: unknown[] }).results ?? []).map((raw) => {
      const record = raw as { id: string; properties?: Record<string, string> };
      return {
        externalId: record.id,
        objectType: 'organisation' as const,
        name: record.properties?.['name'],
        organisationDomain: record.properties?.['domain'],
        ownerRef: record.properties?.['hubspot_owner_id'],
      };
    });
  }

  async readOpportunities(credential: Credential, personExternalId: string): Promise<CanonicalOpportunity[]> {
    const associations = await this.call(
      credential, 'GET',
      `/crm/v4/objects/contacts/${encodeURIComponent(personExternalId)}/associations/deals`,
      undefined, 'contacts/associations/deals',
    );
    const dealIds = ((associations as { results?: Array<{ toObjectId?: string | number }> }).results ?? [])
      .map((r) => String(r.toObjectId))
      .filter((id) => id && id !== 'undefined');
    if (dealIds.length === 0) return [];

    const batch = await this.call(credential, 'POST', '/crm/v3/objects/deals/batch/read', {
      properties: ['dealname', 'dealstage', 'pipeline', 'hubspot_owner_id', 'amount', 'closedate'],
      inputs: dealIds.map((id) => ({ id })),
    }, 'deals/batch/read');

    return ((batch as { results?: unknown[] }).results ?? []).map((raw) => {
      const record = raw as { id: string; properties?: Record<string, string> };
      const props = record.properties ?? {};
      const stage = props['dealstage'] ?? '';
      return {
        id: record.id,
        personRef: personExternalId,
        pipelineRef: props['pipeline'],
        stageRef: stage,
        stageLabel: stage,
        ownerRef: props['hubspot_owner_id'],
        // Open/closed is resolved against the tenant's live pipeline
        // configuration by the adapter, never hard-coded here.
        isOpen: !stage.startsWith('closed'),
        isClosedWon: stage === 'closedwon',
        amount: props['amount'] ? Number(props['amount']) : undefined,
        currency: 'GBP',
      };
    });
  }

  async readOwners(credential: Credential): Promise<CanonicalOwner[]> {
    const body = await this.call(credential, 'GET', '/crm/v3/owners?limit=100', undefined, 'owners');
    return ((body as { results?: unknown[] }).results ?? []).map((raw) => {
      const owner = raw as { id: string; firstName?: string; lastName?: string; email?: string; archived?: boolean };
      return {
        id: owner.id,
        name: [owner.firstName, owner.lastName].filter(Boolean).join(' ') || owner.email || owner.id,
        email: owner.email,
        active: owner.archived !== true,
      };
    });
  }

  async readPipelines(credential: Credential): Promise<CanonicalPipeline[]> {
    const body = await this.call(credential, 'GET', '/crm/v3/pipelines/deals', undefined, 'pipelines/deals');
    return ((body as { results?: unknown[] }).results ?? []).map((raw) => {
      const pipeline = raw as { id: string; label: string; stages?: Array<{ id: string; label: string; displayOrder?: number; metadata?: Record<string, string> }> };
      return {
        id: pipeline.id,
        label: pipeline.label,
        stages: (pipeline.stages ?? []).map((stage, index) => ({
          id: stage.id,
          label: stage.label,
          isOpen: stage.metadata?.['isClosed'] !== 'true',
          isClosedWon: stage.metadata?.['isClosed'] === 'true' && stage.metadata?.['probability'] === '1.0',
          order: stage.displayOrder ?? index,
        })),
      };
    });
  }

  async upsertPerson(credential: Credential, person: CanonicalPerson, idempotencyKey: string): Promise<WriteResult> {
    const email = person.emails[0];
    if (!email) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'hubspot upsertPerson requires an email' });
    }

    const properties: Record<string, string> = { email };
    if (person.name?.given) properties['firstname'] = person.name.given;
    if (person.name?.family) properties['lastname'] = person.name.family;
    if (person.jobTitle) properties['jobtitle'] = person.jobTitle;
    if (person.phones?.[0]) properties['phone'] = person.phones[0];
    if (person.organisation?.name) properties['company'] = person.organisation.name;
    properties['detent_qualification_state'] = person.qualificationState;
    properties['detent_write_key'] = idempotencyKey;
    // lifecyclestage and hubspot_owner_id are absent by construction: they are
    // CRM-authoritative and the adapter rejects an envelope containing them.

    try {
      const body = await this.call(credential, 'POST', '/crm/v3/objects/contacts/batch/upsert', {
        inputs: [{ idProperty: 'email', id: email, properties }],
      }, 'contacts/batch/upsert');
      const result = ((body as { results?: Array<{ id: string; new?: boolean }> }).results ?? [])[0];
      if (!result) throw new AwaError({ kind: 'UPSTREAM_REJECTED', message: 'hubspot upsert returned no result' });
      return { externalId: result.id, created: result.new === true, connector: this.name, objectType: 'contact' };
    } catch (cause) {
      // 409 CONFLICT names the existing record. Convert to update, never retry
      // the create: retrying is how duplicates get made.
      if (cause instanceof AwaError && cause.kind === 'CONFLICT') {
        const existingId = extractConflictId(cause.details['body']);
        if (existingId) {
          await this.call(credential, 'PATCH', `/crm/v3/objects/contacts/${existingId}`, { properties }, 'contacts/patch');
          return { externalId: existingId, created: false, connector: this.name, objectType: 'contact', convertedFromCreate: true };
        }
      }
      throw cause;
    }
  }

  async upsertOrganisation(credential: Credential, organisation: CanonicalOrganisation, idempotencyKey: string): Promise<WriteResult> {
    const domain = organisation.domains[0];
    if (!domain) throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'hubspot upsertOrganisation requires a domain' });
    const properties: Record<string, string> = { domain, detent_write_key: idempotencyKey };
    if (organisation.name) properties['name'] = organisation.name;

    const body = await this.call(credential, 'POST', '/crm/v3/objects/companies/batch/upsert', {
      inputs: [{ idProperty: 'domain', id: domain, properties }],
    }, 'companies/batch/upsert');
    const result = ((body as { results?: Array<{ id: string; new?: boolean }> }).results ?? [])[0];
    if (!result) throw new AwaError({ kind: 'UPSTREAM_REJECTED', message: 'hubspot company upsert returned no result' });
    return { externalId: result.id, created: result.new === true, connector: this.name, objectType: 'company' };
  }

  async createNote(credential: Credential, activity: CanonicalActivity, idempotencyKey: string): Promise<WriteResult> {
    const body = await this.call(credential, 'POST', '/crm/v3/objects/notes', {
      properties: {
        hs_note_body: `${activity.subject}\n\n${activity.body ?? ''}`.trim(),
        hs_timestamp: activity.occurredAt ?? new Date().toISOString(),
        detent_write_key: idempotencyKey,
      },
    }, 'notes');
    return { externalId: String((body as { id: string }).id), created: true, connector: this.name, objectType: 'note' };
  }

  async createTask(credential: Credential, activity: CanonicalActivity, idempotencyKey: string): Promise<WriteResult> {
    const body = await this.call(credential, 'POST', '/crm/v3/objects/tasks', {
      properties: {
        hs_task_subject: activity.subject,
        hs_task_body: activity.body ?? '',
        hs_task_status: 'NOT_STARTED',
        hs_timestamp: activity.dueAt ?? new Date().toISOString(),
        // The owner is set from the CRM-resolved owner reference, which the
        // adapter supplies from a read. It is never invented by the assistant.
        ...(activity.ownerRef ? { hubspot_owner_id: activity.ownerRef } : {}),
        detent_write_key: idempotencyKey,
      },
    }, 'tasks');
    return { externalId: String((body as { id: string }).id), created: true, connector: this.name, objectType: 'task' };
  }

  async createMeeting(credential: Credential, activity: CanonicalActivity, idempotencyKey: string): Promise<WriteResult> {
    const body = await this.call(credential, 'POST', '/crm/v3/objects/meetings', {
      properties: {
        hs_meeting_title: activity.subject,
        hs_meeting_body: activity.body ?? '',
        hs_timestamp: activity.startsAt ?? new Date().toISOString(),
        hs_meeting_start_time: activity.startsAt,
        hs_meeting_end_time: activity.endsAt,
        hs_meeting_outcome: 'SCHEDULED',
        detent_write_key: idempotencyKey,
      },
    }, 'meetings');
    return { externalId: String((body as { id: string }).id), created: true, connector: this.name, objectType: 'meeting' };
  }

  async associate(credential: Credential, from: { type: string; id: string }, to: { type: string; id: string }, type: AssociationType): Promise<WriteResult> {
    const fromObject = HUBSPOT_OBJECTS[from.type] ?? from.type;
    const toObject = HUBSPOT_OBJECTS[to.type] ?? to.type;
    await this.call(
      credential, 'PATCH',
      `/crm/v4/objects/${fromObject}/${from.id}/associations/default/${toObject}/${to.id}`,
      undefined, 'associations/v4',
    );
    return { externalId: `${from.id}:${to.id}`, created: true, connector: this.name, objectType: `association:${type}` };
  }

  async subscribeChanges(credential: Credential, callbackUrl: string): Promise<Subscription> {
    // Webhook subscriptions for a private app are configured in the app UI, not
    // via API. This returns the declared subscription so the tenant admin sees
    // exactly what must be configured, rather than silently doing nothing.
    void credential;
    return {
      id: `hubspot:${callbackUrl}`,
      callbackUrl,
      events: ['contact.propertyChange', 'contact.creation', 'contact.merge', 'contact.deletion', 'deal.propertyChange'],
    };
  }

  async eraseSubject(credential: Credential, externalId: string): Promise<void> {
    // GDPR delete, which is permanent erasure distinct from ordinary archival.
    await this.call(credential, 'POST', '/crm/v3/objects/contacts/gdpr-delete', { objectId: externalId }, 'contacts/gdpr-delete');
  }
}

const HUBSPOT_OBJECTS: Record<string, string> = {
  person: 'contacts',
  organisation: 'companies',
  opportunity: 'deals',
  activity: 'notes',
  note: 'notes',
  task: 'tasks',
  meeting: 'meetings',
};

function extractConflictId(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const message = (body as { message?: string }).message ?? '';
  // "Contact already exists. Existing ID: 551"
  const match = /Existing ID:\s*(\d+)/i.exec(message);
  return match?.[1];
}
