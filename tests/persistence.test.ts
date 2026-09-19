import { describe, expect, it } from 'vitest';
import {
  Database, PostgresAccountStore, PostgresInvoiceStore, PostgresLedgerStore,
  PostgresPageStore, PostgresResetTokenStore, PostgresSessionStore,
  PostgresUserStore, migrate,
} from '@detent/awa-persistence';
import {
  PostgresResellerStore, PostgresSupportRequestStore, PostgresTerritoryStore,
} from '@detent/awa-persistence';
import { money, type Invoice } from '@detent/awa-billing';
import type { Reseller } from '@detent/awa-reseller';
import type { AuthUser, ResetToken, Session } from '@detent/awa-auth';
import type { Page } from '@detent/awa-cms';
import { resolve } from 'node:path';

/**
 * The persistence layer, against a real Postgres.
 *
 * These are skipped when `TEST_DATABASE_URL` is unset, so the suite still runs
 * on a machine without a database. They are not optional in spirit: an adapter
 * verified only against a fake proves that the fake agrees with itself.
 *
 * Run them with, for example:
 *   TEST_DATABASE_URL=postgresql://localhost/detent_test node tools/test.mjs
 */

const url = process.env['TEST_DATABASE_URL'];

if (!url) {
  describe('the persistence layer', () => {
    it('is skipped without TEST_DATABASE_URL', () => {
      // Recorded rather than silent: a skipped suite that says nothing reads
      // exactly like a passing one.
      expect(url).toBeUndefined();
    });
  });
} else {
  const database = new Database({ connectionString: url });
  const migrations = resolve(process.cwd(), 'db/migrations');

  /**
   * A unique suffix per run.
   *
   * The database outlives the test run, so a fixture with a fixed identifier
   * passes once and then collides with itself for ever. Tests that only pass
   * on an empty database are tests that will fail on the machine of whoever
   * runs them second.
   */
  const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const uniq = (prefix: string) => `${prefix}_${run}_${Math.random().toString(36).slice(2, 8)}`;

  const user = (over: Partial<AuthUser> = {}): AuthUser => ({
    userId: uniq('usr'),
    realm: 'app', email: `${uniq('x')}@test.example`,
    name: 'Test Person', passwordHash: 'scrypt$fake', roles: ['owner'],
    tenantId: 't_test', createdAt: new Date().toISOString(),
    failedAttempts: 0, ...over,
  } as AuthUser);

  describe('migrations', () => {
    it('leave the schema in place, and applying them again does nothing', async () => {
      // Not "the first call applies something": the database outlives the test
      // run, so on the second run there is nothing left to apply. The property
      // that matters is that after migrating, the schema is there and a further
      // migrate is a no-op, which is what lets them run at every boot.
      await migrate(database, migrations);
      const tables = await database.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [['auth_user', 'account', 'invoice', 'cms_page', 'reseller', 'schema_migration']],
      );
      expect(tables).toHaveLength(6);

      const again = await migrate(database, migrations);
      expect(again).toEqual([]);
    });
  });

  describe('users survive a restart', () => {
    it('round-trips a user by id and by email', async () => {
      const store = new PostgresUserStore(database);
      const created = user();
      await store.put(created);

      expect((await store.findById(created.userId))?.email).toBe(created.email);
      expect((await store.findByEmail('app', created.email))?.userId).toBe(created.userId);
      // Email lookup is case-insensitive, because people type their address
      // however they please and it is the same address.
      expect((await store.findByEmail('app', created.email.toUpperCase()))?.userId)
        .toBe(created.userId);
      // And realm-scoped: a console user is not found by an app lookup.
      expect(await store.findByEmail('console', created.email)).toBeUndefined();
    });

    it('lets the same address exist once per realm', async () => {
      // A person may hold a customer account and a reseller portal login. They
      // are not the same identity and must not collide.
      const store = new PostgresUserStore(database);
      const email = `dual${run}@test.example`;
      await store.put(user({ email, realm: 'app' }));
      await store.put(user({ email, realm: 'reseller', tenantId: undefined, resellerId: 'rsl_1' }));
      expect((await store.findByEmail('app', email))?.realm).toBe('app');
      expect((await store.findByEmail('reseller', email))?.resellerId).toBe('rsl_1');
    });

    it('updates in place rather than creating a second row', async () => {
      const store = new PostgresUserStore(database);
      const created = user({ name: 'Before' });
      await store.put(created);
      await store.put({ ...created, name: 'After' });
      expect((await store.findById(created.userId))?.name).toBe('After');
      const all = await store.listByTenant(created.tenantId!);
      expect(all.filter((one) => one.userId === created.userId)).toHaveLength(1);
    });
  });

  describe('sessions', () => {
    const session = (over: Partial<Session> = {}): Session => ({
      sessionId: uniq('ses'), userId: uniq('usr'), realm: 'app',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      lastSeenAt: new Date().toISOString(), ...over,
    });

    it('round-trips, and deletes every session for a user at once', async () => {
      const store = new PostgresSessionStore(database);
      const shared = uniq('usr');
      const a = session({ userId: shared });
      const b = session({ userId: shared });
      await store.put(a);
      await store.put(b);
      expect((await store.get(a.sessionId))?.userId).toBe(shared);

      // Signing out everywhere has to mean everywhere, or a stolen session
      // outlives the password change made because it was stolen.
      await store.deleteForUser(shared);
      expect(await store.get(a.sessionId)).toBeUndefined();
      expect(await store.get(b.sessionId)).toBeUndefined();
    });

    it('sweeps only what has actually expired', async () => {
      const store = new PostgresSessionStore(database);
      const sweeper = uniq('usr');
      const live = session({ userId: sweeper });
      const dead = session({
        userId: sweeper,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      });
      await store.put(live);
      await store.put(dead);
      await store.sweepExpired(new Date().toISOString());
      expect(await store.get(dead.sessionId)).toBeUndefined();
      expect(await store.get(live.sessionId)).toBeDefined();
    });
  });

  describe('password reset tokens', () => {
    const token = (over: Partial<ResetToken> = {}): ResetToken => ({
      tokenHash: uniq('hash'), userId: uniq('usr'), realm: 'app',
      email: `reset${run}@test.example`,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900_000).toISOString(), ...over,
    });

    it('keeps a superseded token so the rate limiter still counts it', async () => {
      // Deleting it would let somebody reset the limit by triggering the very
      // invalidation the limit exists to restrain.
      const store = new PostgresResetTokenStore(database);
      const email = `rate${run}@test.example`;
      const rateUser = uniq('usr');
      const first = token({ email, userId: rateUser });
      await store.put(first);
      await store.invalidateForUser(rateUser);

      const found = await store.find(first.tokenHash);
      expect(found).toBeDefined();
      expect(found?.supersededAt).toBeDefined();
      expect(await store.countSince(email, '2000-01-01T00:00:00.000Z')).toBe(1);
    });
  });

  describe('accounts and money', () => {
    it('round-trips an account and its subscription', async () => {
      const store = new PostgresAccountStore(database);
      const accountId = uniq('acc');
      const tenantId = uniq('t');
      await store.put({
        accountId, tenantId, name: 'Durable Ltd', status: 'active',
        billingEmail: 'billing@test.example', countryCode: 'GB',
        createdAt: new Date().toISOString(), createdBy: 'test',
      } as never);
      expect((await store.findByTenant(tenantId))?.accountId).toBe(accountId);
      expect((await store.get(accountId))?.name).toBe('Durable Ltd');
    });

    it('never hands out the same invoice number twice, even concurrently', async () => {
      // The failure this pins is a read-then-write sequence: two invoices
      // issued at the same moment both read the same last number and both use
      // it. A gapless sequence is a legal requirement, and duplicates surface
      // under exactly the load that makes them hardest to unpick.
      const store = new PostgresInvoiceStore(database);
      const entity = uniq('E');
      const numbers = await Promise.all(
        Array.from({ length: 25 }, () => store.nextNumber(entity, 2026)),
      );
      expect(new Set(numbers).size).toBe(25);
      expect([...numbers].sort((a, b) => a - b)).toEqual(
        Array.from({ length: 25 }, (unused, index) => index + 1),
      );
    });

    it('stores invoice totals as queryable amounts, not only as json', async () => {
      const store = new PostgresInvoiceStore(database);
      const invoiceId = uniq('inv');
      const accountId = uniq('acc');
      const invoice = {
        invoiceId, accountId, tenantId: 't_inv', status: 'paid', currency: 'GBP',
        period: '2026-02', lines: [], creditsApplied: money(0),
        subtotal: money(100_000), tax: money(20_000), total: money(120_000),
        amountDue: money(0), amountPaid: money(120_000),
        createdAt: '2026-02-01T00:00:00.000Z', issuedAt: '2026-02-01T00:00:00.000Z',
        paidAt: '2026-02-10T00:00:00.000Z',
      } as Invoice;
      await store.put(invoice);

      const back = await store.get(invoiceId);
      expect(back?.subtotal.amount).toBe(100_000);
      expect(back?.total.amount).toBe(120_000);

      // "What did we invoice" must be a query rather than a scan that unpacks
      // json in the application.
      const rows = await database.query<{ total: string }>(
        'SELECT sum(subtotal_minor)::text AS total FROM invoice WHERE account_id = $1',
        [accountId],
      );
      expect(Number(rows[0]?.total)).toBe(100_000);
    });

    it('refuses to spend the same credit twice on a repeated request', async () => {
      const store = new PostgresLedgerStore(database);
      const accountId = uniq('acc');
      const entry = {
        entryId: uniq('led'), accountId, sequence: 1, idempotencyKey: `req-${run}`,
        amount: money(-500), at: new Date().toISOString(),
      };
      await store.appendEntry(entry as never);
      expect((await store.findByIdempotencyKey(accountId, `req-${run}`))?.entryId)
        .toBe(entry.entryId);

      // The database refuses the duplicate rather than the application
      // remembering to check.
      await expect(store.appendEntry({ ...entry, entryId: uniq('led'), sequence: 2 } as never))
        .rejects.toThrow();
      expect(await store.lastSequence(accountId)).toBe(1);
    });

    it('reads the ledger in sequence order, not insertion order', async () => {
      const store = new PostgresLedgerStore(database);
      const accountId = uniq('acc');
      for (const sequence of [3, 1, 2]) {
        await store.appendEntry({
          entryId: uniq('led'), accountId, sequence,
          amount: money(-100), at: new Date().toISOString(),
        } as never);
      }
      const entries = await store.entries(accountId);
      expect(entries.map((one) => one.sequence)).toEqual([1, 2, 3]);
      expect(await store.lastSequence(accountId)).toBe(3);
    });
  });

  describe('the website', () => {
    it('round-trips a page and orders unordered pages last', async () => {
      const store = new PostgresPageStore(database);
      const page = (slug: string, navOrder?: number): Page => ({
        pageId: uniq('pg'),
        slug, title: slug, description: '', state: 'published',
        sections: [], navOrder, createdAt: new Date().toISOString(),
        createdBy: 'test', updatedAt: new Date().toISOString(), updatedBy: 'test',
      } as Page);

      const ordered = page(`a-${run}`, 1);
      const unordered = page(`z-${run}`);
      await store.put(ordered);
      await store.put(unordered);

      expect((await store.findBySlug(ordered.slug))?.pageId).toBe(ordered.pageId);
      const listed = await store.list();
      const positions = listed.map((one) => one.pageId);
      // An unordered page belongs after the ordered ones, not first, which is
      // what NULLS LAST is for and what a plain ORDER BY would get wrong.
      expect(positions.indexOf(ordered.pageId)).toBeLessThan(positions.indexOf(unordered.pageId));

      await store.delete(ordered.pageId);
      expect(await store.get(ordered.pageId)).toBeUndefined();
    });
  });

  describe('the channel', () => {
    const reseller = (over: Partial<Reseller> = {}): Reseller => ({
      resellerId: uniq('rsl'), name: 'Northgate Systems',
      contactEmail: `${uniq('ops')}@test.example`, status: 'active',
      marginBasisPoints: 2000, banded: true, agreementStart: '2026-01-01',
      createdAt: new Date().toISOString(), createdBy: 'test', ...over,
    });

    it('round-trips a reseller and finds them by contact address', async () => {
      const store = new PostgresResellerStore(database);
      const one = reseller();
      await store.put(one);
      expect((await store.get(one.resellerId))?.name).toBe('Northgate Systems');
      expect((await store.byContactEmail(one.contactEmail))?.resellerId).toBe(one.resellerId);
    });

    it('keeps closed links, because past commission is worked out from them', async () => {
      const store = new PostgresResellerStore(database);
      const first = reseller();
      const second = reseller();
      await store.put(first);
      await store.put(second);
      const accountId = uniq('acc');

      await store.replaceLinksForAccount(accountId, [
        {
          accountId, resellerId: first.resellerId, since: '2026-01-01T00:00:00.000Z',
          until: '2026-03-01T00:00:00.000Z', linkedBy: 'ops',
        },
        {
          accountId, resellerId: second.resellerId, since: '2026-03-01T00:00:00.000Z',
          marginBasisPoints: 2500, linkedBy: 'ops',
        },
      ]);

      const links = await store.linksForAccount(accountId);
      expect(links).toHaveLength(2);
      expect(links[0]?.until).toBe('2026-03-01T00:00:00.000Z');
      expect(links[1]?.until).toBeUndefined();
      // An unset override must read as absent, not as a rate of zero, null
      // from the column would silently pay nothing.
      expect(links[0]?.marginBasisPoints).toBeUndefined();
      expect(links[1]?.marginBasisPoints).toBe(2500);
      // The old reseller keeps their history, so past statements still resolve.
      expect(await store.linksForReseller(first.resellerId)).toHaveLength(1);
    });

    it('refuses two open links on one customer, in the database', async () => {
      // Two would mean two resellers earning on the same revenue. The database
      // refuses it, so no code path can create that state.
      const store = new PostgresResellerStore(database);
      const a = reseller();
      const b = reseller();
      await store.put(a);
      await store.put(b);
      const accountId = uniq('acc');
      await expect(store.replaceLinksForAccount(accountId, [
        { accountId, resellerId: a.resellerId, since: '2026-01-01T00:00:00.000Z', linkedBy: 'ops' },
        { accountId, resellerId: b.resellerId, since: '2026-02-01T00:00:00.000Z', linkedBy: 'ops' },
      ])).rejects.toThrow();
      // And the failed replacement left nothing behind.
      expect(await store.linksForAccount(accountId)).toHaveLength(0);
    });

    it('gives a postcode area exactly one holder', async () => {
      const resellerStore = new PostgresResellerStore(database);
      const holder = reseller();
      const other = reseller();
      await resellerStore.put(holder);
      await resellerStore.put(other);

      const store = new PostgresTerritoryStore(database);
      const area = `Z${Math.floor(Math.random() * 9)}`.slice(0, 2);
      await store.delete(area);
      await store.put({
        area, resellerId: holder.resellerId,
        grantedAt: new Date().toISOString(), grantedBy: 'ops',
      });
      expect((await store.get(area))?.resellerId).toBe(holder.resellerId);

      // Writing it for somebody else does not take it from the holder.
      await store.put({
        area, resellerId: other.resellerId,
        grantedAt: new Date().toISOString(), grantedBy: 'ops',
      });
      expect((await store.get(area))?.resellerId).toBe(holder.resellerId);

      await store.delete(area);
      expect(await store.get(area)).toBeUndefined();
    });

    it('shows an account only its own support requests', async () => {
      const store = new PostgresSupportRequestStore(database);
      const mine = uniq('acc');
      const theirs = uniq('acc');
      await store.put({
        requestId: uniq('req'), accountId: mine, tenantId: 't_1', raisedBy: 'a@b.c',
        subject: 'Ours', detail: 'Our problem.', state: 'open',
        createdAt: new Date().toISOString(),
      });
      await store.put({
        requestId: uniq('req'), accountId: theirs, tenantId: 't_2', raisedBy: 'x@y.z',
        subject: 'Theirs', detail: 'Their problem.', state: 'open',
        createdAt: new Date().toISOString(),
      });
      const found = await store.forAccount(mine);
      expect(found).toHaveLength(1);
      expect(found[0]?.subject).toBe('Ours');
    });
  });

  describe('tenant binding', () => {
    it('discards the tenant at the end of the transaction', async () => {
      // The bug this pins is the reason SET LOCAL exists. A plain SET outlives
      // its transaction and travels back into the pool, so the next request on
      // that connection inherits the previous request's tenant: one customer
      // reading another's data, only under load.
      const bound = await database.transaction(async (client) => {
        const rows = await client.query<{ tenant: string }>(
          "SELECT current_setting('app.tenant_id', true) AS tenant");
        return rows.rows[0]?.tenant;
      }, 't_alpha');
      expect(bound).toBe('t_alpha');

      const after = await database.transaction(async (client) => {
        const rows = await client.query<{ tenant: string | null }>(
          "SELECT current_setting('app.tenant_id', true) AS tenant");
        return rows.rows[0]?.tenant;
      });
      // Empty or null, never 't_alpha'.
      expect(after ?? '').not.toBe('t_alpha');
    });

    it('rolls back everything in a failed transaction', async () => {
      const accountId = uniq('acc');
      await expect(database.transaction(async (client) => {
        await client.query(
          'INSERT INTO account (account_id, tenant_id, name, status, document) '
          + "VALUES ($1, $2, 'Rolled back', 'active', '{}'::jsonb)",
          [accountId, `t_${accountId}`],
        );
        throw new Error('something went wrong halfway');
      })).rejects.toThrow(/halfway/);

      const store = new PostgresAccountStore(database);
      expect(await store.get(accountId)).toBeUndefined();
    });
  });
}
