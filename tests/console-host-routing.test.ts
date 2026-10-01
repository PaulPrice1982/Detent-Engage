import { describe, expect, it } from 'vitest';
import { FixedClock } from '@detent/awa-core';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { buildDevSites } from '../packages/server/src/dev-sites.js';
import { createSiteMount } from '../packages/server/src/site-mount.js';
import type { SiteRequest } from '../packages/server/src/site-router.js';

const password = 'correct horse battery staple';
const hosts = { consoleHost: 'staff.example.test', marketingHost: 'www.example.test', appHost: 'www.example.test',
  platformHosts: ['preview.example.test'], allowPathPrefixes: false };
const request = (host: string, path: string, cookie?: string, form?: Record<string, string>): SiteRequest => ({
  method: form ? 'POST' : 'GET', path, query: {},
  headers: { host, cookie, 'content-type': 'application/x-www-form-urlencoded' },
  rawBody: form ? new URLSearchParams(form).toString() : undefined,
});
async function setup() {
  const clock = new FixedClock(new Date('2026-03-01T09:00:00Z'));
  const sites = await buildDevSites({ clock, audit: new AuditLog(new InMemoryAuditStore(), clock),
    operatorEmail: 'operator@example.test', operatorPassword: password,
    sessionSecret: 'a-stable-session-secret-of-at-least-32-chars', secureCookies: false });
  return { sites, mount: createSiteMount({ sites, hosts }) };
}

describe('dedicated console host through the site mount', () => {
  it('serves sign-in, completes login and follows navigation without the elsewhere 404', async () => {
    const { mount } = await setup();
    const host = 'STAFF.EXAMPLE.TEST:443';
    const root = await mount.handle(request(host, '/'));
    expect(root?.redirect).toBe('/console/signin');
    expect((await mount.handle(request(host, root!.redirect!)))?.status).toBe(200);
    const login = await mount.handle(request(host, '/console/signin', undefined, { email: 'operator@example.test', password }));
    expect(login?.status).toBe(303);
    expect(login?.redirect).toBe('/console');
    const cookie = login!.cookies!.map(value => value.split(';')[0]).join('; ');
    for (const path of ['/console', '/console/new', '/console/approvals', '/console/website', '/website']) {
      expect((await mount.handle(request(host, path, cookie)))?.status).toBe(200);
    }
    expect((await mount.handle(request(host, '/console/new')))?.redirect).toBe('/console/signin');
    // Reaching the form must not bypass CSRF protection.
    expect((await mount.handle(request(host, '/console/new', cookie, { name: 'Rejected' })))?.status).toBe(403);
    const logout = await mount.handle(request(host, '/console/signout', cookie));
    expect(logout?.redirect).toBe('/console/signin');
    expect((await mount.handle(request(host, '/console', cookie)))?.redirect).toBe('/console/signin');
  });

  it('keeps the console unavailable on customer and unapproved platform hosts', async () => {
    const { mount } = await setup();
    for (const host of ['www.example.test', 'preview.example.test', 'unknown.example.test']) {
      for (const path of ['/console', '/console/signin', '/console/website']) {
        const response = await mount.handle(request(host, path));
        expect(response?.status).toBe(404);
        expect(response?.html).not.toContain('staff.example.test');
      }
    }
    expect((await mount.handle(request('www.example.test', '/app/signin')))?.status).toBe(200);
  });

  it('preserves development prefixes and the explicit platform-host opt-in', async () => {
    const { sites } = await setup();
    const development = createSiteMount({ sites, hosts: { allowPathPrefixes: true } });
    expect((await development.handle(request('localhost:8787', '/console/signin')))?.status).toBe(200);
    const optedIn = createSiteMount({ sites, hosts: { ...hosts, consoleOnPlatformHost: true } });
    expect((await optedIn.handle(request('preview.example.test', '/console/signin')))?.status).toBe(200);
    expect((await optedIn.handle(request('www.example.test', '/console/signin')))?.status).toBe(404);
  });
});
