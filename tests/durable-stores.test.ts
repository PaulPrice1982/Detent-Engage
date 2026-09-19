/**
 * The stores that were memory only, against a real PostgreSQL.
 *
 * Skipped when TEST_DATABASE_URL is unset, so the suite still runs on a machine
 * without a database. Not optional in spirit: these adapters exist to survive a
 * restart, and an adapter verified only against a fake proves that the fake
 * agrees with itself.
 *
 * **Run them as an ordinary owner role, not as a superuser.** A superuser
 * bypasses row level security entirely, and that is exactly how the fault these
 * tests exist for stayed hidden: every tenant-scoped write was refused on the
 * deployed platform, where the application connects as an ordinary owner, while
 * passing locally as postgres.
 *
 *   createuser appowner; createdb -O appowner detent_test
 *   TEST_DATABASE_URL=postgres://appowner@localhost/detent_test node tools/test.mjs
 */
import { describe, expect, it } from 'vitest';
import {
  Database, PostgresConnectionStore, PostgresConsentStore, PostgresOutcomeStore,
  PostgresPaymentStore, PostgresSuppressionStore, PostgresUsageStore,
  PostgresWriteReceiptStore, migrate,
} from '@detent/awa-persistence';
import { resolve } from 'node:path';

const url = process.env['TEST_DATABASE_URL'];

if (!url) {
  describe('the durable platform stores', () => {
    it.skip('needs TEST_DATABASE_URL', () => undefined);
  });
} else {
  const database = new Database({ connectionString: url });
  const TENANT = 't_durable_test';

  async function ready(): Promise<void> {
    await migrate(database, resolve('db/migrations'));
    await database.transaction(async (client) => {
      await client.query(
        `INSERT INTO tenant (tenant_id, name, state, residency, home_jurisdiction, connector, config)
         VALUES ($1,'Durable','REGISTERED','UK','UK','sandbox','{}'::jsonb)
         ON CONFLICT (tenant_id) DO NOTHING`,
        [TENANT],
      );
    }, TENANT);
  }

  describe('the durable platform stores', () => {
    it('keeps the metering the customer is billed from', async () => {
      await ready();
      const store = new PostgresUsageStore(database);
      await store.put({
        tenantId: TENANT, period: '2026-09', conversations: 3, textMessages: 9,
        voiceMinutes: 1.5, crmCalls: 2, llmTokens: 400, qualifiedOutcomes: 1,
        enrichmentRecords: 0, companyResolutions: 0, spendPence: 12.5, concurrentVoice: 0,
      });
      const back = await store.get(TENANT, '2026-09');
      expect(back?.conversations).toBe(3);
      // Pence carry a fraction. Rounding here is money quietly going missing.
      expect(back?.spendPence).toBe(12.5);
      expect(back?.qualifiedOutcomes).toBe(1);
    });

    it('keeps consent evidence with the exact wording that was shown', async () => {
      await ready();
      const store = new PostgresConsentStore(database);
      const wording = 'May I check whether we already know you?';
      await store.put({
        id: 'ce_test_1', tenantId: TENANT, subjectRef: 'subject-1',
        purpose: 'IDENTITY_RESOLUTION', lawfulBasis: 'CONSENT', wordingShown: wording,
        choice: 'GRANTED', timestamp: new Date().toISOString(), source: 'WIDGET_PROMPT',
        jurisdiction: 'UK', correlationId: 'corr-1',
      });
      const latest = await store.latest(TENANT, 'subject-1', 'IDENTITY_RESOLUTION');
      expect(latest?.choice).toBe('GRANTED');
      // Verbatim, never a key into a table of wordings that could change later.
      expect(latest?.wordingShown).toBe(wording);
    });

    it('makes a retried CRM write converge instead of writing twice', async () => {
      await ready();
      const store = new PostgresWriteReceiptStore(database);
      const now = new Date().toISOString();
      const base = {
        id: 'r_test', tenantId: TENANT, correlationId: 'corr-1', idempotencyKey: 'key-1',
        connector: 'sandbox', operation: 'upsert_person' as const, attempts: 1,
        createdAt: now, updatedAt: now,
      };
      await store.put({ ...base, state: 'PENDING' });
      await store.put({ ...base, state: 'CONFIRMED', externalId: 'ext-9', attempts: 2 });
      const found = await store.find(TENANT, 'key-1');
      expect(found?.state).toBe('CONFIRMED');
      expect(found?.externalId).toBe('ext-9');
      expect(await store.listByState(TENANT, 'CONFIRMED')).toHaveLength(1);
    });

    it('never writes a CRM token in a readable form', async () => {
      await ready();
      const key = Buffer.alloc(32, 7).toString('base64');
      const store = new PostgresConnectionStore(database, key);
      const token = 'a-token-that-must-not-appear-in-the-row';
      await store.put({
        tenantId: TENANT, connector: 'salesforce', state: 'CONNECTED',
        credential: { kind: 'oauth2', accessToken: token },
      });
      expect((await store.get(TENANT))?.credential.accessToken).toBe(token);

      const rows = await database.queryAs<{ credential_cipher: Buffer }>(
        TENANT, 'SELECT credential_cipher FROM crm_connection WHERE tenant_id = $1', [TENANT],
      );
      expect(rows[0]!.credential_cipher.toString('utf8')).not.toContain(token);
    });

    it('reads as not connected when the key no longer decrypts it', async () => {
      await ready();
      const written = new PostgresConnectionStore(database, Buffer.alloc(32, 7).toString('base64'));
      await written.put({
        tenantId: TENANT, connector: 'salesforce', state: 'CONNECTED',
        credential: { kind: 'oauth2', accessToken: 'written-under-the-old-key' },
      });

      // A rotated key. This must cost a reconnection, not every conversation:
      // the turn pipeline reads the connection before it answers anything, so a
      // throw here took the assistant down for every visitor.
      const rotated: string[] = [];
      const reading = new PostgresConnectionStore(
        database, Buffer.alloc(32, 9).toString('base64'),
        { onUndecryptable: (tenantId) => rotated.push(tenantId) },
      );
      expect(await reading.get(TENANT)).toBeUndefined();
      expect(rotated).toEqual([TENANT]);
    });

    it('refuses a credential key that is not the right shape', () => {
      // The message changed deliberately: "must be 32 bytes, this one decodes
      // to 15" described a symptom and hid the cause, and sent somebody looking
      // for a truncated key twice. What is checked and named is the shape.
      // tests/optional-secrets.test.ts holds every case.
      expect(() => new PostgresConnectionStore(database, 'dG9vLXNob3J0'))
        .toThrow(/44 characters/);
    });

    it('keeps outcomes, which are what the customer is charged for', async () => {
      await ready();
      const store = new PostgresOutcomeStore(database);
      await store.put({
        id: 'o_test', tenantId: TENANT, conversationId: 'cv-1', correlationId: 'corr-1',
        outcome: 'book_meeting', state: 'CONFIRMED', billable: true,
        recordedAt: new Date().toISOString(),
      });
      expect((await store.get(TENANT, 'o_test'))?.billable).toBe(true);
      expect(await store.byCorrelation(TENANT, 'corr-1')).toHaveLength(1);
    });

    it('will not process the same webhook delivery twice', async () => {
      await ready();
      const store = new PostgresPaymentStore(database);
      // A fresh id each run. The table is a permanent record of what has been
      // handled, so a fixed id passes once and fails for ever after against the
      // same database, which is a test failing on its own history.
      const event = `evt_test_${Date.now()}`;
      expect(await store.hasProcessedEvent(event)).toBe(false);
      await store.markEventProcessed(event);
      // A provider retries. Processing a retry charges or credits twice.
      expect(await store.hasProcessedEvent(event)).toBe(true);
      await store.markEventProcessed(event);
      expect(await store.hasProcessedEvent(event)).toBe(true);
    });

    it('makes an opt-out outlive a deploy', async () => {
      await ready();
      const store = new PostgresSuppressionStore(database);
      await store.add({
        digest: 'digest-test-1', reason: 'unsubscribed', channel: 'email',
        recordedAt: new Date().toISOString(),
      } as never);
      expect(await store.has('digest-test-1')).toBe(true);
      expect(await store.has('digest-never-added')).toBe(false);
    });
  });
}
