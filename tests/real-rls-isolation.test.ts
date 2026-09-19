/**
 * Tenant isolation against a real PostgreSQL, under a role that cannot bypass it.
 *
 * The companion probe in `db-isolation-probe.test.ts` runs against a fake and
 * says so: it proves the adapters always bind a tenant, which is the part that
 * lives in this repository. It cannot prove the database enforces anything,
 * because the fake is the thing being asked.
 *
 * This file asks the database. It matters because the fault it guards against
 * hid behind a superuser: a superuser bypasses row level security entirely, so
 * a suite run as `postgres` passes whether or not a single policy exists. The
 * deployed platform connects as an ordinary owner, and FORCE ROW LEVEL
 * SECURITY is precisely what constrains an owner.
 *
 *   createuser appowner --no-createrole --no-superuser
 *   createdb -O appowner detent_test
 *   TEST_DATABASE_URL=postgres://appowner@localhost/detent_test pnpm test:vitest
 *
 * Skipped without TEST_DATABASE_URL so the suite still runs on a machine with
 * no database. Not optional in spirit: this is the assertion a buyer's auditor
 * is actually asking for.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { Database, migrate } from '@detent/awa-persistence';
import { resolve } from 'node:path';

const url = process.env['TEST_DATABASE_URL'];

if (!url) {
  describe('tenant isolation on a real database', () => {
    it.skip('needs TEST_DATABASE_URL', () => undefined);
  });
} else {
  const database = new Database({ connectionString: url });
  const A = 't_rls_a';
  const B = 't_rls_b';

  const seedTenant = async (id: string): Promise<void> => {
    await database.queryAs(
      id,
      `INSERT INTO tenant (tenant_id, name, state, residency, home_jurisdiction, connector, config)
       VALUES ($1,$2,'REGISTERED','UK','UK','sandbox',$3)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [id, id, JSON.stringify({ tenantId: id })],
    );
  };

  beforeAll(async () => {
    await migrate(database, resolve('db/migrations'));
    await seedTenant(A);
    await seedTenant(B);
    await database.queryAs(
      A,
      `INSERT INTO knowledge_chunk
         (id, tenant_id, corpus_version, state, source_kind, source_ref,
          title, body, approved_by, approved_at, created_at)
       VALUES ('kc_rls_a',$1,1,'PUBLISHED','faq','ref','Refunds','Five days.',
               'someone', now(), now())
       ON CONFLICT (id) DO NOTHING`,
      [A],
    );
  });

  describe('tenant isolation on a real database', () => {
    it('does not let one tenant read another tenant rows', async () => {
      // The whole product promise in one assertion.
      expect(await database.queryAs(B, 'SELECT id FROM knowledge_chunk', [])).toHaveLength(0);
      expect(await database.queryAs(A, 'SELECT id FROM knowledge_chunk', [])).toHaveLength(1);
    });

    it('returns nothing at all to a query that names no tenant', async () => {
      // The correct failure mode for a forgotten binding is silence, not a
      // full table. A developer sees an empty result immediately; a leak is
      // only ever found by the customer it leaked to.
      expect(await database.query('SELECT id FROM knowledge_chunk', [])).toHaveLength(0);
    });

    it('refuses a write that would plant a row under another tenant', async () => {
      await expect(database.queryAs(
        B,
        `INSERT INTO knowledge_chunk
           (id, tenant_id, corpus_version, state, source_kind, source_ref,
            title, body, approved_by, approved_at, created_at)
         VALUES ('kc_rls_x',$1,1,'PUBLISHED','faq','r','T','b','someone', now(), now())`,
        [A],
      )).rejects.toThrow(/row-level security/i);
    });

    it('leaves no tenant bound on a connection returned to the pool', async () => {
      // SET LOCAL, never a plain SET. A plain SET outlives its transaction and
      // travels back into the pool, so the next request served by that
      // connection inherits the previous request's tenant.
      const rows = await database.query<{ v: string | null }>(
        "SELECT current_setting('app.tenant_id', true) AS v", [],
      );
      // Postgres resets the setting to '' rather than NULL once it has been
      // set in a session. Either way it is not a tenant id and the policy
      // matches nothing, which the unbound read above already demonstrates.
      expect(rows[0]?.v ?? '').toBe('');
    });

    /**
     * The control that was missing.
     *
     * 0001 says adding a table without adding it to the isolation list is the
     * mistake the list exists to make visible, and then the platform migration
     * added five tenant-scoped tables with no policy at all and nothing
     * noticed. Nothing noticed because nothing asked. This asks.
     *
     * The exemption is deliberately a literal list rather than a rule: a new
     * table joins it only by somebody editing this file and saying why.
     */
    it('carries FORCE ROW LEVEL SECURITY on every tenant-scoped table', async () => {
      // `tenant` is the registry of which tenants exist, read by the platform
      // as the platform. 0004 turns its policy off deliberately and says so;
      // it holds no customer data, only the list of customers.
      const exempt = ['tenant'];

      const rows = await database.query<{ relname: string; forced: boolean }>(
        `SELECT c.relname, c.relforcerowsecurity AS forced
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public'
            AND c.relkind = 'r'
            AND EXISTS (
              SELECT 1 FROM information_schema.columns col
               WHERE col.table_schema = 'public'
                 AND col.table_name = c.relname
                 AND col.column_name = 'tenant_id')
          ORDER BY 1`,
        [],
      );
      const unprotected = rows
        .filter((row) => !row.forced && !exempt.includes(row.relname))
        .map((row) => row.relname);
      expect(
        unprotected,
        `tenant-scoped tables with no FORCE ROW LEVEL SECURITY: ${unprotected.join(', ')}`,
      ).toEqual([]);
    });

    /**
     * The platform tables are covered by a weaker policy than the rest, and
     * this pins exactly how much weaker.
     *
     * Sign-in looks a user up by email before any tenant is known, so those
     * stores query unbound and a flat policy would lock the platform out of
     * its own records. The policy therefore permits unbound access and
     * confines bound access. This asserts the half that is a guarantee: once a
     * tenant is bound, a forgotten WHERE clause cannot cross tenants.
     */
    it('confines the platform tables once a tenant is bound', async () => {
      await database.query(
        `INSERT INTO auth_user (user_id, realm, email, tenant_id, document)
         VALUES ('u_rls_a','console','a@example.test',$1,'{}'::jsonb),
                ('u_rls_b','console','b@example.test',$2,'{}'::jsonb)
         ON CONFLICT (user_id) DO NOTHING`,
        [A, B],
      );

      // Bound to A: A's user only, B's invisible.
      const boundToA = await database.queryAs<{ user_id: string }>(
        A, 'SELECT user_id FROM auth_user WHERE user_id IN ($1,$2)',
        ['u_rls_a', 'u_rls_b'],
      );
      expect(boundToA.map((row) => row.user_id)).toEqual(['u_rls_a']);

      // Unbound: the platform's own access, deliberately unrestricted. Stated
      // as a test so that closing it later is a visible change here too.
      const unbound = await database.query<{ user_id: string }>(
        'SELECT user_id FROM auth_user WHERE user_id IN ($1,$2) ORDER BY user_id',
        ['u_rls_a', 'u_rls_b'],
      );
      expect(unbound).toHaveLength(2);
    });
  });
}
