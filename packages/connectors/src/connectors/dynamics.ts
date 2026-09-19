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
 * Microsoft Dynamics 365 Sales connector (Tier 1), over the Dataverse OData v4
 * Web API.
 *
 * Idempotency uses upsert via an alternate key: `PATCH /leads(detent_key='...')`
 * creates or updates in one call. The `If-None-Match: *` / `If-Match: *`
 * headers control create-versus-update semantics, and omitting them is what
 * turns an intended upsert into an accidental create.
 */
export class DynamicsConnector implements CrmConnector {
  readonly name = 'dynamics';

  constructor(
    private readonly http: HttpClient,
    private readonly alternateKeyField = 'detent_key',
  ) {}

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
      fieldHistory: 'FULL',
      customFields: 'FULL',
      sandbox: 'FULL',
      dedicatedErasureEndpoint: 'PARTIAL',
      hasSeparateLeadObject: true,
      rateLimit: { requestsPerSecond: 20, searchRequestsPerSecond: 10 },
      degradationNotes: [
        `Idempotent upsert requires the alternate key ${'detent_key'} registered on lead and contact.`,
        'Requires an application user with a least-privilege security role in Entra ID.',
      ],
    };
  }

  private base(credential: Credential): string {
    if (!credential.instanceUrl) {
      throw new AwaError({ kind: 'CONNECTION_DEGRADED', message: 'dynamics credential is missing the environment URL' });
    }
    return `${credential.instanceUrl}/api/data/v9.2`;
  }

  private async call(
    credential: Credential,
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    context = path,
  ): Promise<unknown> {
    const response = await this.http.send({
      method,
      url: `${this.base(credential)}${path}`,
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        'OData-MaxVersion': '4.0',
        'OData-Version': '4.0',
        prefer: 'return=representation',
        ...extraHeaders,
      },
      body,
    });
    const error = classifyResponse(this.name, response, context);
    if (error) throw error;
    return response.body;
  }

  async searchPerson(credential: Credential, query: PersonQuery): Promise<MatchCandidate[]> {
    if (!query.email && !query.phoneE164) return [];
    const field = query.email ? 'emailaddress1' : 'telephone1';
    const value = escapeOData(query.email ?? query.phoneE164!);
    const candidates: MatchCandidate[] = [];

    const contacts = await this.call(
      credential, 'GET',
      `/contacts?$select=contactid,emailaddress1,telephone1,fullname,jobtitle,_ownerid_value,_parentcustomerid_value,modifiedon&$filter=${field} eq '${value}'&$top=10`,
      undefined, {}, 'contacts',
    );
    candidates.push(...((contacts as { value?: DynamicsContact[] }).value ?? []).map((row) => ({
      externalId: row.contactid,
      objectType: 'contact' as const,
      email: row.emailaddress1 ?? undefined,
      phone: row.telephone1 ?? undefined,
      name: row.fullname ?? undefined,
      ownerRef: row._ownerid_value ?? undefined,
      lifecycleStage: row._parentcustomerid_value ? 'customer' : undefined,
      lastModified: row.modifiedon,
    })));

    const leads = await this.call(
      credential, 'GET',
      `/leads?$select=leadid,emailaddress1,telephone1,fullname,companyname,statuscode,_ownerid_value,modifiedon&$filter=${field} eq '${value}' and statecode eq 0&$top=10`,
      undefined, {}, 'leads',
    );
    candidates.push(...((leads as { value?: DynamicsLead[] }).value ?? []).map((row) => ({
      externalId: row.leadid,
      objectType: 'lead' as const,
      email: row.emailaddress1 ?? undefined,
      phone: row.telephone1 ?? undefined,
      name: row.fullname ?? undefined,
      organisationName: row.companyname ?? undefined,
      ownerRef: row._ownerid_value ?? undefined,
      lastModified: row.modifiedon,
    })));

    return candidates;
  }

  async searchOrganisation(credential: Credential, query: OrganisationQuery): Promise<MatchCandidate[]> {
    if (!query.domain && !query.name) return [];
    const filter = query.domain
      ? `contains(websiteurl,'${escapeOData(query.domain)}')`
      : `name eq '${escapeOData(query.name!)}'`;
    const body = await this.call(
      credential, 'GET',
      `/accounts?$select=accountid,name,websiteurl,_ownerid_value&$filter=${filter}&$top=10`,
      undefined, {}, 'accounts',
    );
    return ((body as { value?: Array<{ accountid: string; name?: string; websiteurl?: string; _ownerid_value?: string }> }).value ?? [])
      .map((row) => ({
        externalId: row.accountid,
        objectType: 'organisation' as const,
        name: row.name,
        organisationDomain: query.domain,
        ownerRef: row._ownerid_value,
      }));
  }

  async readOpportunities(credential: Credential, personExternalId: string): Promise<CanonicalOpportunity[]> {
    const body = await this.call(
      credential, 'GET',
      `/opportunities?$select=opportunityid,name,stepname,statecode,statuscode,estimatedvalue,_ownerid_value,_parentaccountid_value&$filter=_parentcontactid_value eq ${personExternalId}&$top=25`,
      undefined, {}, 'opportunities',
    );
    return ((body as { value?: DynamicsOpportunity[] }).value ?? []).map((row) => ({
      id: row.opportunityid,
      personRef: personExternalId,
      organisationRef: row._parentaccountid_value ?? undefined,
      stageRef: row.stepname ?? undefined,
      stageLabel: row.stepname ?? undefined,
      ownerRef: row._ownerid_value ?? undefined,
      // statecode 0 = Open, 1 = Won, 2 = Lost.
      isOpen: row.statecode === 0,
      isClosedWon: row.statecode === 1,
      amount: row.estimatedvalue ?? undefined,
      currency: 'GBP',
    }));
  }

  async readOwners(credential: Credential): Promise<CanonicalOwner[]> {
    const body = await this.call(
      credential, 'GET',
      '/systemusers?$select=systemuserid,fullname,internalemailaddress,isdisabled&$filter=isdisabled eq false&$top=200',
      undefined, {}, 'systemusers',
    );
    return ((body as { value?: Array<{ systemuserid: string; fullname?: string; internalemailaddress?: string }> }).value ?? [])
      .map((row) => ({ id: row.systemuserid, name: row.fullname ?? row.systemuserid, email: row.internalemailaddress, active: true }));
  }

  async readPipelines(credential: Credential): Promise<CanonicalPipeline[]> {
    // Dynamics models stages as Business Process Flow steps. Reading the
    // process definition per tenant is deferred; the salesstage option set is
    // the portable read and is declared as such to the tenant.
    const body = await this.call(
      credential, 'GET',
      "/GlobalOptionSetDefinitions(Name='opportunity_salesstage')",
      undefined, {}, 'optionset/salesstage',
    );
    const options = ((body as { Options?: Array<{ Value: number; Label?: { UserLocalizedLabel?: { Label?: string } } }> }).Options ?? []);
    return [{
      id: 'salesstage',
      label: 'Business Process Flow',
      stages: options.map((option, index) => {
        const label = option.Label?.UserLocalizedLabel?.Label ?? String(option.Value);
        return {
          id: String(option.Value),
          label,
          isOpen: !/closed|won|lost/i.test(label),
          isClosedWon: /won/i.test(label),
          order: index,
        };
      }),
    }];
  }

  async upsertPerson(credential: Credential, person: CanonicalPerson, idempotencyKey: string): Promise<WriteResult> {
    const email = person.emails[0];
    if (!email) throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'dynamics upsertPerson requires an email' });

    const asContact = person.qualificationState === 'QUALIFIED';
    const entitySet = asContact ? 'contacts' : 'leads';
    const record: Record<string, unknown> = {
      emailaddress1: email,
      firstname: person.name?.given,
      lastname: person.name?.family ?? person.name?.full ?? 'Unknown',
      jobtitle: person.jobTitle,
      telephone1: person.phones?.[0],
    };
    if (!asContact) {
      record['subject'] = 'Website enquiry';
      record['companyname'] = person.organisation?.name ?? email.split('@')[1];
    }

    const key = sanitiseKey(idempotencyKey);
    const body = await this.call(
      credential, 'PATCH',
      `/${entitySet}(${this.alternateKeyField}='${key}')`,
      stripUndefined(record),
      {},
      `upsert/${entitySet}`,
    );
    const id = (body as Record<string, string>)[asContact ? 'contactid' : 'leadid'];
    if (!id) throw new AwaError({ kind: 'UPSTREAM_REJECTED', message: 'dynamics upsert returned no id' });
    return { externalId: id, created: true, connector: this.name, objectType: asContact ? 'contact' : 'lead' };
  }

  async upsertOrganisation(credential: Credential, organisation: CanonicalOrganisation, idempotencyKey: string): Promise<WriteResult> {
    const key = sanitiseKey(idempotencyKey);
    const body = await this.call(
      credential, 'PATCH',
      `/accounts(${this.alternateKeyField}='${key}')`,
      stripUndefined({
        name: organisation.name ?? organisation.domains[0],
        websiteurl: organisation.domains[0] ? `https://${organisation.domains[0]}` : undefined,
      }),
      {},
      'upsert/accounts',
    );
    const id = (body as { accountid?: string }).accountid;
    if (!id) throw new AwaError({ kind: 'UPSTREAM_REJECTED', message: 'dynamics account upsert returned no id' });
    return { externalId: id, created: true, connector: this.name, objectType: 'account' };
  }

  async createNote(credential: Credential, activity: CanonicalActivity, _idempotencyKey: string): Promise<WriteResult> {
    const body = await this.call(credential, 'POST', '/annotations', stripUndefined({
      subject: activity.subject,
      notetext: activity.body,
      ...(activity.personRef ? { 'objectid_contact@odata.bind': `/contacts(${activity.personRef})` } : {}),
    }), {}, 'annotations');
    return { externalId: String((body as { annotationid: string }).annotationid), created: true, connector: this.name, objectType: 'annotation' };
  }

  async createTask(credential: Credential, activity: CanonicalActivity, _idempotencyKey: string): Promise<WriteResult> {
    const body = await this.call(credential, 'POST', '/tasks', stripUndefined({
      subject: activity.subject,
      description: activity.body,
      scheduledend: activity.dueAt,
      ...(activity.personRef ? { 'regardingobjectid_contact@odata.bind': `/contacts(${activity.personRef})` } : {}),
      ...(activity.ownerRef ? { 'ownerid@odata.bind': `/systemusers(${activity.ownerRef})` } : {}),
    }), {}, 'tasks');
    return { externalId: String((body as { activityid: string }).activityid), created: true, connector: this.name, objectType: 'task' };
  }

  async createMeeting(credential: Credential, activity: CanonicalActivity, _idempotencyKey: string): Promise<WriteResult> {
    const body = await this.call(credential, 'POST', '/appointments', stripUndefined({
      subject: activity.subject,
      description: activity.body,
      scheduledstart: activity.startsAt,
      scheduledend: activity.endsAt,
      ...(activity.personRef ? { 'regardingobjectid_contact@odata.bind': `/contacts(${activity.personRef})` } : {}),
      ...(activity.ownerRef ? { 'ownerid@odata.bind': `/systemusers(${activity.ownerRef})` } : {}),
    }), {}, 'appointments');
    return { externalId: String((body as { activityid: string }).activityid), created: true, connector: this.name, objectType: 'appointment' };
  }

  async associate(credential: Credential, from: { type: string; id: string }, to: { type: string; id: string }, type: AssociationType): Promise<WriteResult> {
    if (type !== 'person_to_organisation') {
      throw new AwaError({ kind: 'CAPABILITY_UNSUPPORTED', message: `dynamics sets ${type} at write time` });
    }
    await this.call(credential, 'PATCH', `/contacts(${from.id})`, { 'parentcustomerid_account@odata.bind': `/accounts(${to.id})` }, {}, 'contacts/associate');
    return { externalId: `${from.id}:${to.id}`, created: true, connector: this.name, objectType: `association:${type}` };
  }

  async subscribeChanges(credential: Credential, callbackUrl: string): Promise<Subscription> {
    void credential;
    // Dataverse change notification runs through a registered service endpoint
    // and Azure Service Bus or a webhook step, registered out of band.
    return { id: `dynamics:${callbackUrl}`, callbackUrl, events: ['contact.Update', 'lead.Update', 'opportunity.Update'] };
  }
}

interface DynamicsContact {
  contactid: string; emailaddress1?: string; telephone1?: string; fullname?: string;
  _ownerid_value?: string; _parentcustomerid_value?: string; modifiedon?: string;
}
interface DynamicsLead {
  leadid: string; emailaddress1?: string; telephone1?: string; fullname?: string;
  companyname?: string; _ownerid_value?: string; modifiedon?: string;
}
interface DynamicsOpportunity {
  opportunityid: string; stepname?: string; statecode?: number;
  estimatedvalue?: number; _ownerid_value?: string; _parentaccountid_value?: string;
}

/** OData string literals escape a single quote by doubling it. */
function escapeOData(value: string): string {
  return value.replace(/'/g, "''");
}

function sanitiseKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, '_');
}

function stripUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
