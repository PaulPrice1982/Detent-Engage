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

const BASE = 'https://api.pipedrive.com/api/v2';
const V1 = 'https://api.pipedrive.com/v1';

/**
 * Pipedrive connector (Tier 1).
 *
 * Pipedrive has no native upsert, so idempotency is search-then-write inside a
 * per-session mutex with a stored write receipt (section 16.5). The capability
 * declaration says PARTIAL for that reason rather than claiming parity: a
 * tenant on Pipedrive is told at connection time that duplicate prevention
 * relies on the platform's own receipt, not on the CRM's guarantees.
 *
 * Emails and phones are arrays of labelled values in Pipedrive, which is why
 * the canonical model holds arrays too rather than a single string per channel.
 */
export class PipedriveConnector implements CrmConnector {
  readonly name = 'pipedrive';

  /**
   * Pipedrive custom fields are addressed by a generated 40-character hash key,
   * so the tenant provisions a "Detent write key" field at onboarding and the
   * key is supplied here — the same pattern as the Salesforce External ID field
   * and the Dynamics alternate key. Without it a write leaves no trace that
   * reconciliation can read back, which is exactly the case Pipedrive's missing
   * native upsert makes most likely.
   */
  constructor(
    private readonly http: HttpClient,
    private readonly writeKeyFieldKey = 'detent_write_key',
  ) {}

  capabilities(): CapabilityDeclaration {
    return {
      connector: this.name, tier: 1,
      personSearchByEmail: 'FULL',
      idempotentUpsert: 'PARTIAL',
      organisationResolutionByDomain: 'PARTIAL',
      opportunityReadWithStageAndOwner: 'FULL',
      associationWrite: 'PARTIAL',
      meetingEngagementWrite: 'PARTIAL',
      changeNotification: 'FULL',
      duplicateDetectionOrMerge: 'NONE',
      fieldHistory: 'NONE',
      customFields: 'FULL',
      sandbox: 'PARTIAL',
      dedicatedErasureEndpoint: 'NONE',
      hasSeparateLeadObject: false,
      rateLimit: { requestsPerSecond: 10, searchRequestsPerSecond: 5 },
      degradationNotes: [
        'No native upsert. Duplicate prevention relies on the platform write receipt and a per-session mutex.',
        'Requires a "Detent write key" custom field on Person and Organization, provisioned at onboarding.',
        'No duplicate-detection or merge API: suspected duplicates raise an owner task rather than being merged.',
        'No field history, so "who changed the owner" cannot be answered from the CRM.',
        'No dedicated erasure endpoint: deletion is ordinary delete, and the tenant must confirm its own retention behaviour.',
      ],
    };
  }

  private async call(credential: Credential, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, context = url): Promise<unknown> {
    const response = await this.http.send({
      method, url,
      headers: { authorization: `Bearer ${credential.accessToken}` },
      body,
    });
    const error = classifyResponse(this.name, response, context);
    if (error) throw error;
    return (response.body as { data?: unknown }).data ?? response.body;
  }

  async searchPerson(credential: Credential, query: PersonQuery): Promise<MatchCandidate[]> {
    const term = query.email ?? query.phoneE164;
    if (!term) return [];
    const field = query.email ? 'email' : 'phone';
    const data = await this.call(
      credential, 'GET',
      `${BASE}/persons/search?term=${encodeURIComponent(term)}&fields=${field}&exact_match=true&limit=10`,
      undefined, 'persons/search',
    );
    const items = (data as { items?: Array<{ item?: PipedrivePerson }> }).items ?? [];
    return items.flatMap(({ item }) => item ? [{
      externalId: String(item.id),
      objectType: 'person' as const,
      email: item.emails?.[0] ?? item.primary_email ?? undefined,
      phone: item.phones?.[0] ?? undefined,
      name: item.name,
      organisationName: item.organization?.name,
      ownerRef: item.owner_id ? String(item.owner_id) : undefined,
    }] : []);
  }

  async searchOrganisation(credential: Credential, query: OrganisationQuery): Promise<MatchCandidate[]> {
    const term = query.domain ?? query.name;
    if (!term) return [];
    const data = await this.call(
      credential, 'GET',
      `${BASE}/organizations/search?term=${encodeURIComponent(term)}&limit=10`,
      undefined, 'organizations/search',
    );
    const items = (data as { items?: Array<{ item?: { id: number; name: string; owner_id?: number } }> }).items ?? [];
    return items.flatMap(({ item }) => item ? [{
      externalId: String(item.id),
      objectType: 'organisation' as const,
      name: item.name,
      ownerRef: item.owner_id ? String(item.owner_id) : undefined,
    }] : []);
  }

  async readOpportunities(credential: Credential, personExternalId: string): Promise<CanonicalOpportunity[]> {
    const data = await this.call(credential, 'GET', `${BASE}/deals?person_id=${encodeURIComponent(personExternalId)}&limit=25`, undefined, 'deals');
    const deals = (Array.isArray(data) ? data : []) as PipedriveDeal[];
    return deals.map((deal) => ({
      id: String(deal.id),
      personRef: personExternalId,
      organisationRef: deal.org_id ? String(deal.org_id) : undefined,
      pipelineRef: deal.pipeline_id ? String(deal.pipeline_id) : undefined,
      stageRef: deal.stage_id ? String(deal.stage_id) : undefined,
      ownerRef: deal.owner_id ? String(deal.owner_id) : undefined,
      isOpen: deal.status === 'open',
      isClosedWon: deal.status === 'won',
      amount: deal.value ?? undefined,
      currency: deal.currency ?? 'GBP',
    }));
  }

  async readOwners(credential: Credential): Promise<CanonicalOwner[]> {
    const data = await this.call(credential, 'GET', `${V1}/users`, undefined, 'users');
    const users = (Array.isArray(data) ? data : []) as Array<{ id: number; name: string; email?: string; active_flag?: boolean }>;
    return users.map((user) => ({ id: String(user.id), name: user.name, email: user.email, active: user.active_flag !== false }));
  }

  async readPipelines(credential: Credential): Promise<CanonicalPipeline[]> {
    const pipelines = (await this.call(credential, 'GET', `${BASE}/pipelines`, undefined, 'pipelines')) as Array<{ id: number; name: string }>;
    const stages = (await this.call(credential, 'GET', `${BASE}/stages`, undefined, 'stages')) as Array<{ id: number; name: string; pipeline_id: number; order_nr?: number }>;
    return (Array.isArray(pipelines) ? pipelines : []).map((pipeline) => ({
      id: String(pipeline.id),
      label: pipeline.name,
      stages: (Array.isArray(stages) ? stages : [])
        .filter((stage) => stage.pipeline_id === pipeline.id)
        .map((stage, index) => ({
          id: String(stage.id),
          label: stage.name,
          // Pipedrive stages are all "open"; won and lost are deal statuses,
          // not stages. Encoding that correctly matters for classification.
          isOpen: true,
          isClosedWon: false,
          order: stage.order_nr ?? index,
        })),
    }));
  }

  async upsertPerson(credential: Credential, person: CanonicalPerson, idempotencyKey: string): Promise<WriteResult> {
    const email = person.emails[0];
    if (!email) throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'pipedrive upsertPerson requires an email' });

    // Search-then-write. The caller holds the per-session mutex and the write
    // receipt, so a concurrent duplicate cannot be created by our own retry.
    const existing = await this.searchPerson(credential, { email });
    const payload = {
      name: person.name?.full ?? ([person.name?.given, person.name?.family].filter(Boolean).join(' ') || email),
      emails: [{ value: email, primary: true, label: 'work' }],
      ...(person.phones?.[0] ? { phones: [{ value: person.phones[0], primary: true, label: 'work' }] } : {}),
      // The write key is the only durable link between a platform write receipt
      // and the Pipedrive record it produced.
      [this.writeKeyFieldKey]: idempotencyKey,
    };

    const match = existing[0];
    if (match) {
      await this.call(credential, 'PATCH', `${BASE}/persons/${match.externalId}`, payload, 'persons/patch');
      return { externalId: match.externalId, created: false, connector: this.name, objectType: 'person' };
    }

    const created = await this.call(credential, 'POST', `${BASE}/persons`, payload, 'persons/post');
    return { externalId: String((created as { id: number }).id), created: true, connector: this.name, objectType: 'person' };
  }

  async upsertOrganisation(credential: Credential, organisation: CanonicalOrganisation, idempotencyKey: string): Promise<WriteResult> {
    const name = organisation.name ?? organisation.domains[0];
    if (!name) throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'pipedrive upsertOrganisation requires a name or domain' });
    const existing = await this.searchOrganisation(credential, { name });
    const match = existing.find((candidate) => candidate.name?.toLowerCase() === name.toLowerCase());
    if (match) return { externalId: match.externalId, created: false, connector: this.name, objectType: 'organization' };
    const created = await this.call(credential, 'POST', `${BASE}/organizations`, { name, [this.writeKeyFieldKey]: idempotencyKey }, 'organizations/post');
    return { externalId: String((created as { id: number }).id), created: true, connector: this.name, objectType: 'organization' };
  }

  async createNote(credential: Credential, activity: CanonicalActivity, _idempotencyKey: string): Promise<WriteResult> {
    const created = await this.call(credential, 'POST', `${V1}/notes`, {
      content: `<b>${escapeHtml(activity.subject)}</b><br/>${escapeHtml(activity.body ?? '')}`,
      person_id: activity.personRef ? Number(activity.personRef) : undefined,
      deal_id: activity.opportunityRef ? Number(activity.opportunityRef) : undefined,
    }, 'notes');
    return { externalId: String((created as { id: number }).id), created: true, connector: this.name, objectType: 'note' };
  }

  async createTask(credential: Credential, activity: CanonicalActivity, _idempotencyKey: string): Promise<WriteResult> {
    return this.createActivity(credential, activity, 'task', activity.dueAt);
  }

  async createMeeting(credential: Credential, activity: CanonicalActivity, _idempotencyKey: string): Promise<WriteResult> {
    return this.createActivity(credential, activity, 'meeting', activity.startsAt);
  }

  private async createActivity(credential: Credential, activity: CanonicalActivity, type: string, at?: string): Promise<WriteResult> {
    const when = at ? new Date(at) : new Date();
    const created = await this.call(credential, 'POST', `${BASE}/activities`, {
      subject: activity.subject,
      type,
      note: activity.body,
      due_date: when.toISOString().slice(0, 10),
      due_time: when.toISOString().slice(11, 16),
      person_id: activity.personRef ? Number(activity.personRef) : undefined,
      deal_id: activity.opportunityRef ? Number(activity.opportunityRef) : undefined,
      owner_id: activity.ownerRef ? Number(activity.ownerRef) : undefined,
    }, `activities/${type}`);
    return { externalId: String((created as { id: number }).id), created: true, connector: this.name, objectType: `activity:${type}` };
  }

  async associate(credential: Credential, from: { type: string; id: string }, to: { type: string; id: string }, type: AssociationType): Promise<WriteResult> {
    if (type !== 'person_to_organisation') {
      throw new AwaError({ kind: 'CAPABILITY_UNSUPPORTED', message: `pipedrive sets ${type} at write time` });
    }
    await this.call(credential, 'PATCH', `${BASE}/persons/${from.id}`, { org_id: Number(to.id) }, 'persons/associate');
    return { externalId: `${from.id}:${to.id}`, created: true, connector: this.name, objectType: `association:${type}` };
  }

  async subscribeChanges(credential: Credential, callbackUrl: string): Promise<Subscription> {
    const created = await this.call(credential, 'POST', `${V1}/webhooks`, {
      subscription_url: callbackUrl,
      event_action: '*',
      event_object: 'person',
      version: '2.0',
    }, 'webhooks');
    return { id: String((created as { id: number }).id), callbackUrl, events: ['person.*'] };
  }
}

interface PipedrivePerson {
  id: number; name: string; primary_email?: string;
  emails?: string[]; phones?: string[];
  owner_id?: number; organization?: { name?: string };
}
interface PipedriveDeal {
  id: number; org_id?: number; pipeline_id?: number; stage_id?: number;
  owner_id?: number; status?: string; value?: number; currency?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}
