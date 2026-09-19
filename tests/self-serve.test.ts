import { describe, expect, it } from 'vitest';
import { SelfServeService, type OAuthConnector } from '@detent/awa-server';
import { FixedClock } from '@detent/awa-core';
import { buildHarness, bearer } from './fixtures/tenant.js';

/**
 * CI gate: the self-serve surfaces (audit BIZ-7).
 *
 * Pass threshold: a trial is a real tenant on the real lifecycle, it skips no
 * gate, and the OAuth handshake cannot be replayed or redirected to another
 * tenant.
 */
const hubspot = (exchanged: { accessToken: string; refreshToken?: string }): OAuthConnector => ({
  name: 'hubspot',
  authorizeUrl: 'https://app.hubspot.com/oauth/authorize',
  clientId: 'client-123',
  scopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
  async exchange() { return exchanged; },
});

describe('self-serve trial', () => {
  it('provisions a tenant that can be shown and cannot write to anything', async () => {
    const harness = await buildHarness();
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const selfServe = new SelfServeService(harness.platform, harness.keys, { clock, trialDays: 14 });

    const trial = await selfServe.startTrial({
      companyName: 'Northwind Ltd',
      rootUrl: 'https://www.northwind.example',
      contactEmail: 'ops@northwind.example',
    });

    const config = harness.platform.tenants.get(trial.tenantId);
    // No DPA, no CRM, dry run on. Every gate is where it was.
    expect(config.state).toBe('REGISTERED');
    expect(config.dpaSignedAt).toBeUndefined();
    expect(config.dryRun).toBe(true);
    expect(config.origins).toEqual(['https://www.northwind.example']);
    expect(trial.nothingServesUntilApproved).toBe(true);
    expect(trial.expiresAt).toBe('2026-09-18T09:00:00.000Z');
  });

  it('issues a trial key that expires with the trial', async () => {
    let now = new Date('2026-09-04T09:00:00.000Z');
    const harness = await buildHarness();
    const { ApiKeyService } = await import('@detent/awa-server');
    const keys = new ApiKeyService(() => now);
    const selfServe = new SelfServeService(harness.platform, keys, {
      clock: new FixedClock(now), trialDays: 1,
    });

    const trial = await selfServe.startTrial({
      companyName: 'Northwind Ltd',
      rootUrl: 'https://www.northwind.example',
      contactEmail: 'ops@northwind.example',
    });

    expect(() => keys.authenticate(trial.adminKey)).not.toThrow();
    now = new Date('2026-09-06T09:00:00.000Z');
    expect(() => keys.authenticate(trial.adminKey)).toThrowError(/expired/);
  });

  it('refuses a non-https root URL and an incomplete request', async () => {
    const harness = await buildHarness();
    const selfServe = new SelfServeService(harness.platform, harness.keys);
    await expect(selfServe.startTrial({
      companyName: 'X', rootUrl: 'http://insecure.example', contactEmail: 'a@b.com',
    })).rejects.toThrowError(/https/);
    await expect(selfServe.startTrial({
      companyName: '', rootUrl: 'https://a.example', contactEmail: 'a@b.com',
    })).rejects.toThrowError(/required/);
  });

  it('is off unless the deployment enables it', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({
      method: 'POST', path: '/v1/trials', headers: {},
      body: { companyName: 'X', rootUrl: 'https://a.example', contactEmail: 'a@b.com' },
    });
    // The spine ships with trials off (audit BIZ-1).
    expect(response.status).toBe(501);
  });
});

describe('OAuth connect', () => {
  it('refuses to start before a DPA record exists', async () => {
    const harness = await buildHarness();
    const selfServe = new SelfServeService(harness.platform, harness.keys, {
      connectors: [hubspot({ accessToken: 'tok' })],
    });
    const trial = await selfServe.startTrial({
      companyName: 'Northwind', rootUrl: 'https://www.northwind.example', contactEmail: 'a@b.com',
    });

    expect(() => selfServe.begin(trial.tenantId, 'hubspot', 'https://app.detentgtm.io/v1/oauth/callback'))
      .toThrowError(/DPA/);
  });

  it('completes the handshake and seals the credential', async () => {
    const harness = await buildHarness();
    const selfServe = new SelfServeService(harness.platform, harness.keys, {
      connectors: [hubspot({ accessToken: 'live-token', refreshToken: 'live-refresh' })],
    });

    // The fixture tenant already has a DPA and a CRM; use a fresh one.
    const tenantId = 't_connect';
    harness.platform.tenants.create({ tenantId, name: 'Connect Ltd', connector: 'sandbox' });
    await harness.platform.tenants.recordDpa(tenantId, 'DPA-CONNECT');

    const started = selfServe.begin(tenantId, 'hubspot', 'https://app.detentgtm.io/v1/oauth/callback');
    expect(started.authorizeUrl).toContain('client_id=client-123');
    expect(started.authorizeUrl).toContain(`state=${started.state}`);

    const completed = await selfServe.complete(started.state, 'auth-code');
    expect(completed).toEqual({ tenantId, connector: 'hubspot' });
    expect(harness.platform.tenants.get(tenantId).state).toBe('CRM_CONNECTED');

    const connection = await harness.platform.connections.get(tenantId);
    expect(connection?.credential.accessToken).toBe('live-token');
  });

  it('consumes the state, so a replayed callback binds nothing', async () => {
    const harness = await buildHarness();
    const selfServe = new SelfServeService(harness.platform, harness.keys, {
      connectors: [hubspot({ accessToken: 'tok' })],
    });
    const tenantId = 't_replay';
    harness.platform.tenants.create({ tenantId, name: 'Replay Ltd', connector: 'sandbox' });
    await harness.platform.tenants.recordDpa(tenantId, 'DPA-REPLAY');

    const started = selfServe.begin(tenantId, 'hubspot', 'https://app.detentgtm.io/v1/oauth/callback');
    await selfServe.complete(started.state, 'code-1');
    await expect(selfServe.complete(started.state, 'code-2')).rejects.toThrowError(/already-used/);
  });

  it('refuses an unknown state outright', async () => {
    const harness = await buildHarness();
    const selfServe = new SelfServeService(harness.platform, harness.keys, {
      connectors: [hubspot({ accessToken: 'tok' })],
    });
    await expect(selfServe.complete('corr_not_ours', 'code')).rejects.toThrowError(/unknown or already-used/);
  });

  it('expires a stale authorisation', async () => {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const harness = await buildHarness();
    const selfServe = new SelfServeService(harness.platform, harness.keys, {
      clock, connectors: [hubspot({ accessToken: 'tok' })],
    });
    const tenantId = 't_stale';
    harness.platform.tenants.create({ tenantId, name: 'Stale Ltd', connector: 'sandbox' });
    await harness.platform.tenants.recordDpa(tenantId, 'DPA-STALE');

    const started = selfServe.begin(tenantId, 'hubspot', 'https://app.detentgtm.io/v1/oauth/callback');
    clock.advance(11 * 60 * 1000);
    await expect(selfServe.complete(started.state, 'code')).rejects.toThrowError(/expired/);
  });
});

describe('the partner surface is reachable at last', () => {
  it('registers and lists partners over the API when the flag is on', async () => {
    const harness = await buildHarness();
    (harness.platform as unknown as { features: { groupsAndPartners: boolean } })
      .features.groupsAndPartners = true;

    const created = await harness.api.handle({
      method: 'POST',
      path: `/v1/admin/tenants/${harness.config.tenantId}/partners`,
      headers: bearer(harness.adminKey),
      body: { id: 'p_ie', name: 'Acme Ireland', territories: ['IE'], capacity: 5, tier: 1 },
    });
    expect(created.status).toBe(201);

    const listed = await harness.api.handle({
      method: 'GET',
      path: `/v1/admin/tenants/${harness.config.tenantId}/partners`,
      headers: bearer(harness.adminKey),
    });
    expect((listed.body as { partners: unknown[] }).partners).toHaveLength(1);
  });
});
