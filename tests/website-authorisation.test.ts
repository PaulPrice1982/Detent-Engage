import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { csrfTokenFor } from '@detent/awa-auth';
import { FixedClock } from '@detent/awa-core';
import { buildDevSites } from '@detent/awa-server';

async function fixture(roles: readonly string[]) {
  const clock = new FixedClock(new Date('2026-09-04T09:00:00Z'));
  const secret = 's'.repeat(48);
  const sites = await buildDevSites({
    clock, audit: new AuditLog(new InMemoryAuditStore(), clock),
    sessionSecret: secret, secureCookies: false,
  });
  const user = await sites.users.create({
    realm: 'console', email: 'reviewer@example.test', name: 'Reviewer',
    password: 'correct horse battery staple', roles,
  });
  const signedIn = await sites.consoleRouter.handle({
    method: 'POST', path: '/console/signin', query: {}, headers: {},
    rawBody: new URLSearchParams({ email: user.email, password: 'correct horse battery staple' }).toString(),
  });
  const cookie = signedIn?.cookies?.[0]?.split(';')[0] ?? '';
  expect(cookie).not.toBe('');
  // Use this user's valid CSRF token: an authorization failure must not be a CSRF failure.
  const sessionId = cookie.slice(cookie.indexOf('=') + 1).split('.')[0]!;
  const csrf = csrfTokenFor(sessionId, secret);
  const get = (path: string) => sites.consoleRouter.handle({
    method: 'GET', path: `/console/website${path}`, query: {}, headers: { cookie },
  });
  const post = (path: string, form: Record<string, string> = {}) => sites.consoleRouter.handle({
    method: 'POST', path: `/console/website${path}`, query: {}, headers: { cookie },
    rawBody: new URLSearchParams({ csrf, ...form }).toString(),
  });
  const page = await sites.pages.create({ slug: 'permission-test', title: 'Original', description: 'Original description', createdBy: 'fixture' });
  await sites.pages.addSection(page.pageId, 'prose', 'fixture');
  await sites.pages.addSection(page.pageId, 'prose', 'fixture');
  await sites.pages.publish(page.pageId, 'fixture');
  return { sites, user, pageId: page.pageId, get, post };
}

describe('website console authorization', () => {
  for (const role of ['viewer', 'support', 'billing', 'owner']) {
    it(`keeps ${role} read-only even with valid direct POST requests`, async () => {
      const h = await fixture([role]);
      const before = JSON.stringify(await h.sites.pages.list());
      const publishedBefore = await h.sites.marketing('/permission-test');
      const sections = (await h.sites.pages.get(h.pageId))!.sections;
      const first = sections[0]!.sectionId;
      const second = sections[1]!.sectionId;
      const mutations: [string, Record<string, string>][] = [
        ['/new', { slug: 'unauthorized', title: 'Unauthorized', description: 'Test' }],
        [`/${h.pageId}/details`, { title: 'Tampered' }],
        [`/${h.pageId}/publish`, {}],
        [`/${h.pageId}/archive`, {}],
        [`/${h.pageId}/section`, { kind: 'hero' }],
        [`/${h.pageId}/section/${first}`, { heading: 'Tampered' }],
        [`/${h.pageId}/section/${first}`, { remove: 'yes' }],
        [`/${h.pageId}/section/${second}`, { move: 'up' }],
        [`/${h.pageId}/section/${first}`, { addItem: 'yes' }],
        [`/${h.pageId}/section/${first}`, { removeItem: 'yes' }],
      ];
      for (const [path, form] of mutations) {
        const response = await h.post(path, form);
        expect(response?.status).toBe(403);
        expect(response?.html).toContain(path.endsWith('/publish') || path.endsWith('/archive') ? 'website.publish' : 'website.edit');
        expect(JSON.stringify(await h.sites.pages.list())).toBe(before);
      }
      expect(await h.sites.marketing('/permission-test')).toEqual(publishedBefore);
      const list = await h.get('');
      const detail = await h.get(`/${h.pageId}`);
      expect(list?.status).toBe(200);
      expect(detail?.status).toBe(200);
      expect(list?.html).not.toContain('action="/console/website/new"');
      expect(detail?.html).not.toContain('<form');
      expect((await h.get(`/${h.pageId}/preview`))?.status).toBe(200);
    });
  }

  it('refuses website access when the user has no recognized role', async () => {
    const h = await fixture([]);
    expect((await h.get(''))?.status).toBe(403);
    expect((await h.get(`/${h.pageId}/preview`))?.status).toBe(403);
    expect((await h.post(`/${h.pageId}/publish`))?.status).toBe(403);
  });

  it('allows administrators to edit and publish, and enforces role changes on an existing session', async () => {
    const h = await fixture(['admin']);
    const created = await h.post('/new', { slug: 'admin-created', title: 'Created', description: 'Test' });
    expect(created?.status).toBe(303);
    const id = created!.redirect!.split('/').pop()!;
    expect((await h.post(`/${id}/details`, { title: 'Updated' }))?.status).toBe(200);
    expect((await h.post(`/${id}/section`, { kind: 'prose' }))?.status).toBe(200);
    expect((await h.post(`/${id}/section`, { kind: 'hero' }))?.status).toBe(200);
    const sections = (await h.sites.pages.get(id))!.sections;
    expect((await h.post(`/${id}/section/${sections[0]!.sectionId}`, { heading: 'Approved copy' }))?.status).toBe(200);
    expect((await h.post(`/${id}/section/${sections[1]!.sectionId}`, { move: 'up' }))?.status).toBe(200);
    expect((await h.post(`/${id}/section/${sections[1]!.sectionId}`, { remove: 'yes' }))?.status).toBe(200);
    expect((await h.sites.pages.get(id))!.sections[0]!.heading).toBe('Approved copy');
    expect((await h.post(`/${id}/publish`))?.status).toBe(200);
    expect((await h.sites.marketing('/admin-created')).status).toBe(200);
    expect((await h.post(`/${id}/archive`))?.status).toBe(200);
    expect((await h.sites.marketing('/admin-created')).status).toBe(404);
    await h.sites.users.setRoles(h.user.userId, ['viewer']);
    expect((await h.post(`/${id}/publish`))?.status).toBe(403);
  });
});
