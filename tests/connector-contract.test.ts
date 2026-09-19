import { describe, expect, it } from 'vitest';
import {
  DynamicsConnector, HubSpotConnector, PipedriveConnector, SalesforceConnector, ZohoConnector,
  classifyResponse, backoffMs, parseRetryAfter, TokenBucket,
  type CrmConnector, type HttpClient, type HttpRequest, type HttpResponse,
} from '@detent/awa-connectors';
import { FixedClock } from '@detent/awa-core';

/**
 * The per-connector contract suite.
 *
 * Every Tier 1 connector runs the same assertions against recorded vendor
 * response shapes. In CI this suite also runs against live sandboxes; here it
 * runs offline, which is what makes it a gate on every commit rather than a
 * gate on five sandboxes being simultaneously available.
 *
 * The load-bearing assertion is the last one in each group: no write ever
 * carries an owner, lifecycle stage, pipeline or stage field.
 */
class RecordingHttpClient implements HttpClient {
  readonly requests: HttpRequest[] = [];
  constructor(private readonly responder: (request: HttpRequest) => HttpResponse) {}
  async send(request: HttpRequest): Promise<HttpResponse> {
    this.requests.push(request);
    return this.responder(request);
  }
}

const OWNER_FIELDS = [
  'ownerid', 'owner_id', 'hubspot_owner_id', 'OwnerId', 'lifecyclestage',
  'lifecycle_stage', 'Lead_Status', 'dealstage', 'stagename', 'pipeline', 'stage_id', 'statuscode',
];

/** A write body must never set an owner or lifecycle field on a person object. */
function assertNoAuthoritativeFields(request: HttpRequest): void {
  const body = JSON.stringify(request.body ?? {}).toLowerCase();
  for (const field of OWNER_FIELDS) {
    // ownerid is legitimate on a task, where the value comes from a CRM read.
    if (/task|activit|annotation|appointment|event|note/i.test(request.url)) continue;
    expect(body).not.toContain(`"${field.toLowerCase()}"`);
  }
}

interface ConnectorCase {
  readonly name: string;
  build(http: HttpClient): CrmConnector;
  readonly credential: Parameters<CrmConnector['searchPerson']>[0];
  respond(request: HttpRequest): HttpResponse;
}

const ok = (body: unknown): HttpResponse => ({ status: 200, headers: { 'content-type': 'application/json' }, body });

const CASES: ConnectorCase[] = [
  {
    name: 'hubspot',
    build: (http) => new HubSpotConnector(http),
    credential: { kind: 'oauth2', accessToken: 'tok' },
    respond: (request) => {
      if (request.url.includes('contacts/search')) {
        return ok({ results: [{ id: '551', properties: { email: 'alex@acme.co.uk', firstname: 'Alex', lastname: 'Warner', hubspot_owner_id: '9', lifecyclestage: 'lead' } }] });
      }
      if (request.url.includes('batch/upsert')) return ok({ results: [{ id: '551', new: false }] });
      if (request.url.includes('/owners')) return ok({ results: [{ id: '9', firstName: 'Priya', lastName: 'Raman', email: 'p@acme.co.uk' }] });
      if (request.url.includes('pipelines/deals')) {
        return ok({ results: [{ id: 'default', label: 'Sales', stages: [{ id: 'discovery', label: 'Discovery', displayOrder: 0, metadata: {} }] }] });
      }
      return ok({ id: '1' });
    },
  },
  {
    name: 'salesforce',
    build: (http) => new SalesforceConnector(http),
    credential: { kind: 'oauth2', accessToken: 'tok', instanceUrl: 'https://acme.my.salesforce.com' },
    respond: (request) => {
      if (request.url.includes('/query')) {
        if (request.url.includes('FROM+Contact') || request.url.includes('FROM%20Contact')) {
          return ok({ records: [{ Id: '003x', Email: 'alex@acme.co.uk', Name: 'Alex Warner', OwnerId: '005x', AccountId: '001x', Account: { Name: 'Acme', Website: 'https://acme.co.uk' } }] });
        }
        return ok({ records: [] });
      }
      if (request.method === 'PATCH') return ok({ id: '003x', created: false });
      return ok({ id: '00Tx' });
    },
  },
  {
    name: 'pipedrive',
    build: (http) => new PipedriveConnector(http),
    credential: { kind: 'oauth2', accessToken: 'tok' },
    respond: (request) => {
      if (request.url.includes('persons/search')) {
        return ok({ data: { items: [{ item: { id: 77, name: 'Alex Warner', primary_email: 'alex@acme.co.uk', owner_id: 5 } }] } });
      }
      if (request.url.includes('/persons/')) return ok({ data: { id: 77 } });
      if (request.url.includes('/persons')) return ok({ data: { id: 78 } });
      return ok({ data: { id: 1 } });
    },
  },
  {
    name: 'zoho',
    build: (http) => new ZohoConnector(http),
    credential: { kind: 'oauth2', accessToken: 'tok', region: 'eu' },
    respond: (request) => {
      if (request.url.includes('/search')) {
        if (request.url.includes('/Contacts/')) {
          return ok({ data: [{ id: '4001', Email: 'alex@acme.co.uk', Full_Name: 'Alex Warner', Owner: { id: '77' } }] });
        }
        return { status: 204, headers: {}, body: '' };
      }
      if (request.url.includes('upsert')) return ok({ data: [{ code: 'SUCCESS', details: { id: '4001' }, action: 'update' }] });
      return ok({ data: [{ details: { id: '9001' } }] });
    },
  },
  {
    name: 'dynamics',
    build: (http) => new DynamicsConnector(http),
    credential: { kind: 'oauth2', accessToken: 'tok', instanceUrl: 'https://acme.crm11.dynamics.com' },
    respond: (request) => {
      if (request.url.includes('/contacts?')) {
        return ok({ value: [{ contactid: 'c-1', emailaddress1: 'alex@acme.co.uk', fullname: 'Alex Warner', _ownerid_value: 'u-1', _parentcustomerid_value: 'a-1' }] });
      }
      if (request.url.includes('/leads?')) return ok({ value: [] });
      if (request.method === 'PATCH') return ok({ contactid: 'c-1', accountid: 'a-1', leadid: 'l-1' });
      return ok({ activityid: 'act-1', annotationid: 'ann-1' });
    },
  },
];

describe.each(CASES)('connector contract: $name', (testCase) => {
  it('declares its capabilities honestly, including its gaps', () => {
    const connector = testCase.build(new RecordingHttpClient(testCase.respond));
    const capabilities = connector.capabilities();
    expect(capabilities.connector).toBe(testCase.name);
    expect(capabilities.tier).toBe(1);
    expect(capabilities.rateLimit.searchRequestsPerSecond).toBeGreaterThan(0);
    // A connector that declares FULL for everything is a connector that has not
    // been looked at. Each Tier 1 connector must declare at least one honest
    // limitation or a degradation note.
    const levels = Object.values(capabilities).filter((v) => v === 'PARTIAL' || v === 'NONE');
    expect(levels.length + capabilities.degradationNotes.length).toBeGreaterThan(0);
  });

  it('searches a person by normalised email and returns candidates', async () => {
    const connector = testCase.build(new RecordingHttpClient(testCase.respond));
    const candidates = await connector.searchPerson(testCase.credential, { email: 'alex@acme.co.uk' });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]!.externalId).toBeTruthy();
  });

  it('returns an empty result rather than throwing when given no identifier', async () => {
    const connector = testCase.build(new RecordingHttpClient(testCase.respond));
    await expect(connector.searchPerson(testCase.credential, {})).resolves.toEqual([]);
  });

  it('never writes an owner, lifecycle stage, pipeline or stage on a person write', async () => {
    const http = new RecordingHttpClient(testCase.respond);
    const connector = testCase.build(http);
    await connector.upsertPerson(
      testCase.credential,
      { emails: ['alex@acme.co.uk'], name: { given: 'Alex', family: 'Warner' }, jobTitle: 'RevOps Lead', qualificationState: 'QUALIFIED' },
      'sess_1:upsert_person:1',
    );
    expect(http.requests.length).toBeGreaterThan(0);
    for (const request of http.requests) assertNoAuthoritativeFields(request);
  });

  it('carries the idempotency key into the write', async () => {
    const http = new RecordingHttpClient(testCase.respond);
    const connector = testCase.build(http);
    await connector.upsertPerson(
      testCase.credential,
      { emails: ['alex@acme.co.uk'], qualificationState: 'CAPTURED' },
      'sess_1:upsert_person:7',
    );
    const serialised = http.requests.map((r) => `${r.url} ${JSON.stringify(r.body ?? {})}`).join(' ');
    expect(serialised).toMatch(/sess_1.upsert_person.7/);
  });

  it('rejects a person write with no email rather than writing a partial record', async () => {
    const connector = testCase.build(new RecordingHttpClient(testCase.respond));
    await expect(
      connector.upsertPerson(testCase.credential, { emails: [], qualificationState: 'CAPTURED' }, 'k'),
    ).rejects.toMatchObject({ kind: 'SCHEMA_INVALID' });
  });
});

describe('HubSpot duplicate-conflict handling', () => {
  it('converts a 409 CONFLICT into an update on the named existing record', async () => {
    const http = new RecordingHttpClient((request) => {
      if (request.url.includes('batch/upsert')) {
        return { status: 409, headers: { 'content-type': 'application/json' }, body: { message: 'Contact already exists. Existing ID: 551' } };
      }
      return ok({ id: '551' });
    });
    const connector = new HubSpotConnector(http);
    const result = await connector.upsertPerson(
      { kind: 'oauth2', accessToken: 'tok' },
      { emails: ['alex@acme.co.uk'], qualificationState: 'QUALIFIED' },
      'k',
    );
    expect(result.externalId).toBe('551');
    expect(result.created).toBe(false);
    expect(result.convertedFromCreate).toBe(true);
    // The retry was an update, never a second create.
    expect(http.requests.at(-1)!.method).toBe('PATCH');
  });
});

describe('Salesforce lead-versus-contact split', () => {
  it('writes an unqualified visitor to Lead and a qualified one to Contact', async () => {
    const http = new RecordingHttpClient(() => ok({ id: 'x', created: true }));
    const connector = new SalesforceConnector(http);
    const credential = { kind: 'oauth2' as const, accessToken: 'tok', instanceUrl: 'https://acme.my.salesforce.com' };

    await connector.upsertPerson(credential, { emails: ['a@acme.co.uk'], qualificationState: 'CAPTURED' }, 'k1');
    expect(http.requests.at(-1)!.url).toContain('/sobjects/Lead/');

    await connector.upsertPerson(credential, { emails: ['a@acme.co.uk'], qualificationState: 'QUALIFIED' }, 'k2');
    expect(http.requests.at(-1)!.url).toContain('/sobjects/Contact/');
  });

  it('escapes a single quote in a SOQL literal', async () => {
    const http = new RecordingHttpClient(() => ok({ records: [] }));
    const connector = new SalesforceConnector(http);
    await connector.searchPerson(
      { kind: 'oauth2', accessToken: 'tok', instanceUrl: 'https://acme.my.salesforce.com' },
      { email: "o'brien@acme.co.uk" },
    );
    const url = decodeURIComponent(http.requests[0]!.url);
    expect(url).toContain("\\'brien");
  });
});

describe('Zoho region binding', () => {
  it('refuses an unknown region rather than guessing the data centre', async () => {
    const connector = new ZohoConnector(new RecordingHttpClient(() => ok({})));
    await expect(
      connector.searchPerson({ kind: 'oauth2', accessToken: 'tok', region: 'mars' }, { email: 'a@acme.co.uk' }),
    ).rejects.toMatchObject({ kind: 'CONNECTION_DEGRADED' });
  });
});

describe('rate limiting and backoff', () => {
  it('classifies 429 as retryable and reads Retry-After', () => {
    const error = classifyResponse('hubspot', { status: 429, headers: { 'retry-after': '3' }, body: {} }, 'search');
    expect(error?.kind).toBe('RATE_LIMITED');
    expect(error?.retryable).toBe(true);
    expect(error?.retryAfterSeconds).toBe(3);
  });

  it('classifies 401 as a degraded connection, not a retryable failure', () => {
    const error = classifyResponse('hubspot', { status: 401, headers: {}, body: {} }, 'write');
    expect(error?.kind).toBe('CONNECTION_DEGRADED');
    expect(error?.retryable).toBe(false);
  });

  it('parses both numeric and HTTP-date Retry-After', () => {
    const now = Date.parse('2026-09-04T09:00:00Z');
    expect(parseRetryAfter('5', now)).toBe(5000);
    expect(parseRetryAfter('Fri, 04 Sep 2026 09:00:10 GMT', now)).toBe(10_000);
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
  });

  it('applies jitter so retries across tenants do not synchronise', () => {
    const values = new Set(Array.from({ length: 50 }, () => backoffMs(3)));
    expect(values.size).toBeGreaterThan(5);
    expect(Math.max(...values)).toBeLessThanOrEqual(1000);
  });

  it('refills the token bucket over time', () => {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00Z'));
    const bucket = new TokenBucket(4, 4, clock);
    for (let i = 0; i < 4; i++) expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    clock.advance(1000);
    expect(bucket.tryTake()).toBe(true);
  });
});
