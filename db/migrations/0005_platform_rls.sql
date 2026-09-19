-- Row-level security for the platform tables.
--
-- 0001 says: "Adding a table without adding it here is the mistake this list
-- exists to make visible." The platform migration then added five
-- tenant-scoped tables (auth_user, account, subscription, invoice,
-- support_request) and gave none of them a policy, so the registry of who may
-- sign in, what they are billed and what they have asked for support with sat
-- behind application filtering alone. That is the exact class of fault the
-- database-enforced isolation exists to make impossible.
--
-- These tables are not bound to a tenant the way a conversation is. Sign-in
-- looks a user up by email address before any tenant is known, and billing
-- operates on an account that may span tenants, so a flat
-- `tenant_id = current_setting(...)` policy would lock the platform out of its
-- own records the moment it were applied.
--
-- The policy below therefore says: when a tenant is bound, that tenant's rows
-- and no others; when nothing is bound, the platform's own unscoped access is
-- unaffected. That is strictly stronger than what is there today, because
-- every code path that already binds a tenant becomes incapable of reading
-- across tenants even with a forgotten WHERE clause, and no existing path
-- changes behaviour.
--
-- It is not the end state. The end state is that these stores bind a tenant
-- like every other store and the escape clause is removed. That is a change to
-- the sign-in and billing data paths and belongs in its own work package with
-- its own tests; it is tracked in docs/AUDIT-RESPONSE.md as open, and
-- tests/real-rls-isolation.test.ts asserts the exemption list so that a sixth
-- table cannot be added quietly.

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'auth_user', 'account', 'subscription', 'invoice', 'support_request'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    -- FORCE, because on a managed PostgreSQL the application connects as the
    -- table owner and ENABLE alone exempts the owner. A policy that exempts
    -- the only role that ever connects is decoration.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (
           coalesce(current_setting(''app.tenant_id'', true), '''') = ''''
           OR tenant_id = current_setting(''app.tenant_id'', true)
         )
         WITH CHECK (
           coalesce(current_setting(''app.tenant_id'', true), '''') = ''''
           OR tenant_id = current_setting(''app.tenant_id'', true)
         )',
      target
    );
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'awa_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO awa_app', target);
    END IF;
  END LOOP;
END
$$;
