import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Keyring, LocalKeyProvider, FixedClock } from '@detent/awa-core';
import { ScriptedModelProvider } from '@detent/awa-agent';
import { InMemoryDocumentStore, InMemoryDraftStore, DocumentService, PlainTextExtractor, KnowledgeAgent, DetentKnowledgeService } from '@detent/awa-ingestion';
import { Database, migrate, PostgresConsentStore, PostgresWriteReceiptStore } from '@detent/awa-persistence';
import { Platform, ApiKeyService } from '@detent/awa-server';
import { CustomerWidgetProvisioner } from '../packages/server/src/customer-widgets.js';
import { DurableRuntime } from '../packages/server/src/runtime-state.js';
import { PostgresRuntimeArchive, durablePlatformStores } from '../packages/server/src/runtime-postgres.js';

describe('encrypted runtime archive', () => {
  it('stores authenticated ciphertext and refuses a different root key', async () => {
    let payload: unknown;
    const db = {
      async query() { return payload ? [{ payload }] : []; },
      async transaction(fn: (client: unknown) => Promise<void>) {
        await fn({ query: async (sql: string, values: unknown[]) => {
          if (sql.includes('runtime_snapshot')) payload = JSON.parse(values[1] as string);
          return { rows: [] };
        } });
      },
    } as unknown as Database;
    const keyring = new Keyring(new LocalKeyProvider(LocalKeyProvider.generateRootKey()));
    const archive = new PostgresRuntimeArchive(db, keyring);
    const snapshot = { version: 1 as const, tenants: [], keys: [], sessions: [], killSwitch: 'OFF' as const,
      widgets: [['t_test', { accountId: 'a_test', key: 'secret-widget-value', keyId: 'key_test' }]] as ReturnType<CustomerWidgetProvisioner['snapshot']> };
    await archive.save(snapshot);
    expect(JSON.stringify(payload)).not.toContain('secret-widget-value');
    expect(await archive.load()).toEqual(snapshot);
    const wrong = new PostgresRuntimeArchive(db, new Keyring(new LocalKeyProvider(LocalKeyProvider.generateRootKey())));
    await expect(wrong.load()).rejects.toThrow();
  });
});

const url = process.env['TEST_DATABASE_URL'];
describe('runtime restart on Postgres', () => {
  if (!url) {
    it.skip('requires TEST_DATABASE_URL pointing to a migrated test database', () => undefined);
  } else {
    it('recovers serving state and evidence with a fresh connection pool, and excludes a second writer', async () => {
      const namespace = `restart_${randomUUID()}`;
      const tenantId = `t_${randomUUID()}`;
      const root = LocalKeyProvider.generateRootKey();
      const clock = new FixedClock(new Date('2026-09-30T12:00:00Z'));
      const account = { accountId: `a_${randomUUID()}`, tenantId, name: 'Restart test' };
      const boot = (db: Database) => {
        const platform = new Platform({ model: new ScriptedModelProvider(), clock,
          keyProvider: new LocalKeyProvider(root), checkpointKey: 'test-checkpoint-key', ...durablePlatformStores(db, root) });
        const keys = new ApiKeyService();
        const widgets = new CustomerWidgetProvisioner(platform.tenants, keys);
        const archive = new PostgresRuntimeArchive(db, platform.keyring, namespace);
        const knowledge = { documents: new InMemoryDocumentStore(), drafts: new InMemoryDraftStore() };
        return { platform, keys, widgets, knowledge, runtime: new DurableRuntime(archive, platform, keys, widgets, knowledge) };
      };
      let db = new Database({ connectionString: url });
      let release: (() => Promise<void>) | undefined;
      try {
        await migrate(db, resolve('db/migrations'));
        release = await db.acquireRuntimeLease(() => { throw new Error('test lease lost'); });
        const contender = new Database({ connectionString: url });
        try { await expect(contender.acquireRuntimeLease(() => undefined)).rejects.toThrow('Another runtime'); }
        finally { await contender.close(); }
        const first = boot(db);
        let widget = '';
        let documentId = '';
        let draftId = '';
        await first.runtime.run(async () => { widget = first.widgets.provision(account); });
        await first.runtime.run(async () => {
          await first.platform.tenants.recordDpa(tenantId, 'DPA-test');
          await first.platform.metering.record(tenantId, 'llm_token', 100);
          await first.platform.connections.put({ tenantId, connector: 'hubspot', state: 'CONNECTED', credential: { kind: 'oauth2', accessToken: 'test-credential' } });
          const documents = new DocumentService(first.knowledge.documents, [new PlainTextExtractor()], clock);
          const bytes = new TextEncoder().encode('Durable knowledge.');
          const document = await documents.upload({ tenantId, filename: 'guide.txt', bytes, uploadedBy: 'reviewer' });
          documentId = document.documentId;
          const agent = new KnowledgeAgent({ id: 'test', async propose() { return [{ kind: 'article', title: 'Restart', body: 'Durable knowledge.' }]; } }, first.knowledge.drafts, clock);
          const report = await agent.readDocument(await documents.extract(documentId, bytes));
          draftId = report.drafts[0]!.draftId;
          await new DetentKnowledgeService(first.knowledge.drafts, first.platform.corpus, first.platform.audit, clock)
            .approve({ tenantId, draftId, reviewedBy: 'reviewer' });
          await new PostgresConsentStore(db).put({ id: `ce_${randomUUID()}`, tenantId, subjectRef: 'subject', purpose: 'IDENTITY_RESOLUTION', lawfulBasis: 'CONSENT', wordingShown: 'May we look you up?', choice: 'GRANTED', timestamp: clock.iso(), source: 'WIDGET_PROMPT', jurisdiction: 'UK', correlationId: namespace });
          await new PostgresWriteReceiptStore(db).put({ id: `r_${randomUUID()}`, tenantId, correlationId: namespace, idempotencyKey: namespace, connector: 'hubspot', operation: 'upsert_person', attempts: 1, state: 'CONFIRMED', externalId: 'external', createdAt: clock.iso(), updatedAt: clock.iso() });
        });
        const before = await first.platform.audit.lastEntry(tenantId);
        await first.platform.audit.checkpoint(tenantId);
        const usage = await first.platform.metering.usage(tenantId);
        await release(); release = undefined;
        await db.close();
        db = new Database({ connectionString: url });
        release = await db.acquireRuntimeLease(() => { throw new Error('test lease lost'); });
        const second = boot(db);
        await second.runtime.restore();
        expect(second.platform.durable).toBe(true);
        expect(second.widgets.provision(account)).toBe(widget);
        expect(second.keys.authenticate(widget).tenantId).toBe(tenantId);
        expect(second.platform.tenants.get(tenantId).state).toBe('DPA_SIGNED');
        expect((await second.platform.connections.get(tenantId))!.credential.accessToken).toBe('test-credential');
        expect(await second.platform.metering.usage(tenantId)).toEqual(usage);
        expect((await second.platform.audit.lastEntry(tenantId))!.hash).toBe(before!.hash);
        expect((await second.platform.audit.verify(tenantId)).valid).toBe(true);
        expect(second.platform.corpus.published(tenantId)[0]!.text).toBe('Durable knowledge.');
        expect((await second.knowledge.documents.get(documentId))!.text).toBe('Durable knowledge.');
        expect((await second.knowledge.drafts.get(draftId))!.state).toBe('approved');
        expect((await new PostgresConsentStore(db).latest(tenantId, 'subject', 'IDENTITY_RESOLUTION'))!.wordingShown).toBe('May we look you up?');
        expect((await new PostgresWriteReceiptStore(db).find(tenantId, namespace))!.externalId).toBe('external');
      } finally {
        await release?.();
        await db.close();
      }
    });
  }
});
