import { describe, expect, it } from 'vitest';
import { FixedClock } from '@detent/awa-core';
import { ScriptedModelProvider } from '@detent/awa-agent';
import { Platform, ApiKeyService, buildDevSites } from '@detent/awa-server';
import { DetentKnowledgeService, InMemoryDocumentStore, InMemoryDraftStore } from '@detent/awa-ingestion';
import type { KnowledgeChunk } from '@detent/awa-knowledge';
import { CustomerWidgetProvisioner } from '../packages/server/src/customer-widgets.js';
import { DurableRuntime, type RuntimeSnapshot } from '../packages/server/src/runtime-state.js';

function storage() {
  let snapshot: RuntimeSnapshot | undefined;
  const chunks = new Map<string, KnowledgeChunk>();
  return {
    runtime: { async load() { return structuredClone(snapshot); }, async save(value: RuntimeSnapshot) { snapshot = structuredClone(value); } },
    corpus: { async save(chunk: KnowledgeChunk) { chunks.set(chunk.id, structuredClone(chunk)); },
      async loadFor(tenant: string) { return structuredClone([...chunks.values()].filter(c => c.tenantId === tenant)); } },
  };
}

async function boot(saved: ReturnType<typeof storage>) {
  const clock = new FixedClock(new Date('2026-10-01T09:00:00Z'));
  const platform = new Platform({ model: new ScriptedModelProvider(), clock, knowledgeArchive: saved.corpus });
  const keys = new ApiKeyService();
  const widgets = new CustomerWidgetProvisioner(platform.tenants, keys);
  const knowledge = { corpus: platform.corpus, documents: new InMemoryDocumentStore(), drafts: new InMemoryDraftStore() };
  const runtime = new DurableRuntime(saved.runtime, platform, keys, widgets, knowledge);
  await runtime.restore();
  const sites = await buildDevSites({ audit: platform.audit, clock, sessionSecret: 's'.repeat(48), secureCookies: false, customerKnowledge: knowledge });
  const customer = async (tenantId: string) => {
    if (!platform.tenants.list().some(t => t.tenantId === tenantId)) widgets.provision({ tenantId, accountId: `a_${tenantId}`, name: tenantId });
    const email = `${tenantId}@example.test`;
    const password = 'correct horse battery staple';
    await sites.users.create({ realm: 'app', email, name: tenantId, password, roles: ['owner'], tenantId });
    const handle = (request: Parameters<typeof sites.appRouter.handle>[0]) => runtime.run(() => sites.appRouter.handle(request));
    const login = await handle({ method: 'POST', path: '/app/signin', query: {}, headers: {}, rawBody: new URLSearchParams({ email, password }).toString() });
    const cookie = login.cookies?.map(c => c.split(';')[0]).join('; ') ?? '';
    const page = await handle({ method: 'GET', path: '/app/knowledge', query: {}, headers: { cookie } });
    const csrf = page.html!.match(/name="csrf" value="([^"]+)"/)![1]!;
    return {
      post: (action: string, form: Record<string, string>) => handle({ method: 'POST', path: `/app/knowledge/${action}`, query: {}, headers: { cookie }, rawBody: new URLSearchParams({ ...form, csrf }).toString() }),
      upload: (text: string) => handle({ method: 'POST', path: '/app/knowledge/upload', query: {}, headers: { cookie, 'content-type': 'multipart/form-data; boundary=knowledge-test' },
        rawBodyBuffer: Buffer.from(`--knowledge-test\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${csrf}\r\n--knowledge-test\r\nContent-Disposition: form-data; name="file"; filename="guide.txt"\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--knowledge-test--\r\n`) }),
    };
  };
  return { platform, knowledge, runtime, customer };
}

describe('customer knowledge reaches serving retrieval', () => {
  it('publishes approved uploads and manual knowledge, isolates tenants, and restores and withdraws them', async () => {
    const saved = storage();
    const first = await boot(saved);
    const alice = await first.customer('alice');
    const bob = await first.customer('bob');
    const upload = await alice.upload('Amber support specialises in orchard equipment and provides help with cultivation.');
    expect(upload.status).toBe(200);
    const draftId = upload.html!.match(/name="draftId" value="([^"]+)"/)![1]!;
    const documentId = upload.html!.match(/name="documentId" value="([^"]+)"/)![1]!;
    expect(first.platform.retrieval.retrieve('alice', 'Amber orchard')).toEqual([]);
    expect((await bob.post('approve', { draftId })).status).toBe(400);
    expect((await alice.post('approve', { draftId })).status).toBe(200);
    expect(first.platform.retrieval.retrieve('alice', 'Amber orchard')[0]!.chunk.text).toContain('Amber support');
    expect(first.platform.retrieval.retrieve('bob', 'Amber orchard')).toEqual([]);
    expect((await bob.post('manual', { kind: 'article', title: 'Cobalt logistics', body: 'Cobalt logistics arranges deliveries of marine equipment.' })).status).toBe(200);
    expect(first.platform.retrieval.retrieve('bob', 'Cobalt logistics')[0]!.chunk.text).toContain('Cobalt logistics');
    const second = await boot(saved);
    expect((await second.knowledge.documents.get(documentId))!.state).toBe('processed');
    expect((await second.knowledge.drafts.get(draftId))!.state).toBe('approved');
    expect(second.platform.retrieval.retrieve('alice', 'Amber orchard')[0]!.chunk.text).toContain('Amber support');
    expect(second.platform.retrieval.retrieve('bob', 'Cobalt logistics')[0]!.chunk.text).toContain('Cobalt logistics');
    const restoredAlice = await second.customer('alice');
    expect((await restoredAlice.post('remove', { documentId })).status).toBe(200);
    expect(second.platform.retrieval.retrieve('alice', 'Amber orchard')).toEqual([]);
    expect((await restoredAlice.post('approve', { draftId })).status).toBe(400);
    const third = await boot(saved);
    expect(third.platform.retrieval.retrieve('alice', 'Amber orchard')).toEqual([]);
    expect((await third.knowledge.documents.get(documentId))!.state).toBe('removed');
  });

  it('does not make knowledge servable or report approval when publication persistence fails', async () => {
    const saved = storage();
    const first = await boot(saved);
    saved.corpus.save = async chunk => { if (chunk.state === 'PUBLISHED') throw new Error('storage unavailable'); };
    const service = new DetentKnowledgeService(first.knowledge.drafts, first.platform.corpus, first.platform.audit);
    await expect(service.addManual({ tenantId: 'alice', kind: 'article', title: 'Amber', body: 'Amber support handles orchard equipment.', authoredBy: 'alice' })).rejects.toThrow('storage unavailable');
    expect(first.platform.retrieval.retrieve('alice', 'Amber')).toEqual([]);
    expect(await service.published('alice')).toEqual([]);
    await expect(first.runtime.flush()).rejects.toThrow('storage unavailable');
    expect(first.runtime.ready).toBe(false);
  });
});
