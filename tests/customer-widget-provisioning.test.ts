import { describe, expect, it } from 'vitest';
import { CustomerWidgetProvisioner, buildDevSites } from '@detent/awa-server';
import { buildHarness, bearer } from './fixtures/tenant.js';

describe('customer widget provisioning', () => {
  it('gives two signups distinct tenant-bound snippets and isolates their API sessions', async () => {
    const h = await buildHarness({ tenantId: 't_demo' });
    const customerWidgets = new CustomerWidgetProvisioner(h.platform.tenants, h.keys);
    const sites = await buildDevSites({
      audit: h.platform.audit, clock: h.clock, sessionSecret: 'x'.repeat(48),
      secureCookies: false, customerWidgets,
    });
    const signup = async (email: string) => {
      // Same company name, including the boot tenant's name, cannot select its identity.
      const result = await sites.appRouter.handle({
        method: 'POST', path: '/app/signup', query: {}, headers: {},
        rawBody: new URLSearchParams({
          email, password: 'correct horse battery staple', name: 'Customer', organisation: 'Demo',
        }).toString(),
      });
      expect(result?.status).toBe(303);
      const cookie = result?.cookies?.map(one => one.split(';')[0]).join('; ') ?? '';
      const user = await sites.users.byEmail('app', email);
      if (!user?.tenantId) throw new Error('missing tenant');
      const install = () => sites.appRouter.handle({
        method: 'GET', path: '/app/install', query: { tenantId: 't_demo' }, headers: { cookie },
      });
      const page = await install();
      expect(page?.status).toBe(200);
      const key = page?.html?.match(/awa_pub_[A-Za-z0-9_-]+/)?.[0] ?? '';
      expect(key).not.toBe('');
      expect((await install())?.html).toContain(key);
      expect(page?.html).not.toContain(h.widgetKey);
      expect(h.keys.authenticate(key).tenantId).toBe(user.tenantId);
      expect(h.keys.authenticate(key).audience).toBe('widget');
      const config = h.platform.tenants.get(user.tenantId);
      expect(config.state).toBe('REGISTERED');
      expect(config.dryRun).toBe(true);
      expect(config.origins).toEqual([]);
      return { tenantId: user.tenantId, key };
    };
    const alice = await signup('alice@example.test');
    const bob = await signup('bob@example.test');
    expect(alice.key).not.toBe(bob.key);
    expect(alice.tenantId).not.toBe(bob.tenantId);
    expect(alice.tenantId).not.toBe('t_demo');
    const open = (key: string, origin: string) => h.api.handle({
      method: 'POST', path: '/v1/sessions', headers: { ...bearer(key), origin }, body: {},
    });
    expect((await open(alice.key, 'https://alice.example')).status).toBe(403);
    // Origin registration is an existing operator-controlled onboarding action.
    await h.platform.tenants.update(alice.tenantId, { origins: ['https://alice.example'] }, 'platform_admin');
    await h.platform.tenants.update(bob.tenantId, { origins: ['https://bob.example'] }, 'platform_admin');
    expect((await open(alice.key, 'https://bob.example')).status).toBe(403);
    const opened = await open(alice.key, 'https://alice.example');
    expect(opened.status).toBe(201);
    const sessionId = (opened.body as { session_id: string }).session_id;
    expect(h.platform.sessions.get(sessionId)?.tenantId).toBe(alice.tenantId);
    const crossTenant = await h.api.handle({
      method: 'GET', path: `/v1/sessions/${sessionId}`,
      headers: { ...bearer(bob.key), origin: 'https://bob.example' },
    });
    expect(crossTenant.status).toBe(403);
  });

  it('refuses boot-tenant adoption, account reassignment and silently replacing revoked keys', async () => {
    const h = await buildHarness();
    const widgets = new CustomerWidgetProvisioner(h.platform.tenants, h.keys);
    expect(() => widgets.provision({ accountId: 'a', tenantId: h.config.tenantId, name: 'Wrong owner' })).toThrow();
    const account = { accountId: 'a', tenantId: 't_new', name: 'Customer' };
    const key = widgets.provision(account);
    expect(widgets.provision(account)).toBe(key);
    expect(() => widgets.provision({ ...account, accountId: 'b' })).toThrow();
    h.keys.revoke(h.keys.authenticate(key).keyId);
    expect(() => widgets.provision(account)).toThrow();
  });
});
