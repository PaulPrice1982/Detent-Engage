import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { FixedClock } from '@detent/awa-core';
import { buildDevSites } from '@detent/awa-server';

describe('customer knowledge mutation ownership', () => {
  it('rejects foreign and missing IDs without side effects, while allowing the owner', async () => {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00Z'));
    const audit = new AuditLog(new InMemoryAuditStore(), clock);
    const sites = await buildDevSites({ audit, clock, sessionSecret: 'x'.repeat(48), secureCookies: false });
    const customer = async (tenantId: string) => {
      const email = `${tenantId}@example.test`;
      const password = 'correct horse battery staple';
      await sites.users.create({ realm: 'app', email, name: 'Reviewer', password, roles: ['owner'], tenantId });
      const login = await sites.appRouter.handle({
        method: 'POST', path: '/app/signin', query: {}, headers: {},
        rawBody: new URLSearchParams({ email, password }).toString(),
      });
      const cookie = login.cookies?.map(one => one.split(';')[0]).join('; ') ?? '';
      expect(cookie).not.toBe('');
      const page = () => sites.appRouter.handle({ method: 'GET', path: '/app/knowledge', query: {}, headers: { cookie } });
      const csrf = (await page()).html?.match(/name="csrf" value="([^"]+)"/)?.[1] ?? '';
      expect(csrf).not.toBe('');
      const post = (action: string, form: Record<string, string>) => sites.appRouter.handle({
        method: 'POST', path: `/app/knowledge/${action}`, query: {}, headers: { cookie },
        rawBody: new URLSearchParams({ ...form, csrf }).toString(),
      });
      return { cookie, csrf, page, post };
    };
    const alice = await customer('alice');
    const bob = await customer('bob');
    const boundary = 'knowledge-review-boundary';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${alice.csrf}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="private-guide.txt"\r\nContent-Type: text/plain\r\n\r\nOur support team works from the London office and helps customers with their product questions.\r\n--${boundary}--\r\n`;
    const uploaded = await sites.appRouter.handle({
      method: 'POST', path: '/app/knowledge/upload', query: {},
      headers: { cookie: alice.cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      rawBodyBuffer: Buffer.from(body),
    });
    expect(uploaded.status).toBe(200);
    const draftId = uploaded.html?.match(/name="draftId" value="([^"]+)"/)?.[1] ?? '';
    const documentId = uploaded.html?.match(/name="documentId" value="([^"]+)"/)?.[1] ?? '';
    expect(draftId).not.toBe('');
    expect(documentId).not.toBe('');
    const before = (await alice.page()).html;
    const auditBefore = (await audit.export('alice')).entries.length;
    for (const action of ['approve', 'reject', 'remove']) {
      // Submitted tenant IDs cannot override the tenant established by the session.
      const foreign = await bob.post(action, { tenantId: 'alice', draftId, documentId, reason: 'Reject it', editedBody: 'Tampered content.' });
      const missing = await bob.post(action, { draftId: 'missing', documentId: 'missing', reason: 'Reject it' });
      expect(foreign.status).toBe(400);
      expect(missing.status).toBe(foreign.status);
      const message = action === 'remove' ? 'No such document.' : 'No such knowledge item.';
      expect(foreign.html).toContain(message);
      expect(missing.html).toContain(message);
      expect((await alice.page()).html).toBe(before);
      expect((await audit.export('alice')).entries.length).toBe(auditBefore);
    }
    expect((await alice.post('approve', { draftId })).status).toBe(200);
    expect((await alice.page()).html).toContain('alice@example.test');
    expect((await alice.post('reject', { draftId, reason: 'Needs revision' })).status).toBe(200);
    expect((await alice.post('remove', { documentId })).status).toBe(200);
    expect((await audit.export('alice')).entries.some(entry => entry.type === 'knowledge_approved')).toBe(true);
    expect((await audit.export('alice')).entries.some(entry => entry.type === 'knowledge_rejected')).toBe(true);
  });
});
