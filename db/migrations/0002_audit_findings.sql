-- Schema changes required by the independent code audit of 18 September 2026.
--
-- Four findings land in the schema:
--
--   SEC-3  the Postgres adapters now exist, so the tables they write have to
--          match the interfaces: usage counters gained the three meters added
--          for the v1.1 extension, and crm_connection gained the fields the
--          sealed credential record carries;
--   SEC-4  credentials are sealed with a per-tenant data key under a KMS root
--          key. `credential_cipher` already existed; `credential_kind` and
--          `expires_at` are stored in the clear beside it so an operator can
--          see which CRM a tenant is on, and when its token expires, without
--          holding a key;
--   SEC-8  API keys are stored here rather than in a process map, with a
--          public prefix instead of the tenant id in the key material, an
--          expiry, a last-used timestamp and a rotation link;
--   PERF-2 signed chain checkpoints, so routine verification is O(entries
--          since the last checkpoint) rather than a hash of the whole history.
--
-- Applied as `awa_migrator`. `awa_app` has no DDL rights.

BEGIN;

-- --------------------------------------------------------------------------
-- SEC-3 / PERF-3: usage counters
-- --------------------------------------------------------------------------

ALTER TABLE usage_period
  ADD COLUMN IF NOT EXISTS qualified_outcomes  bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS enrichment_records  bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS company_resolutions bigint NOT NULL DEFAULT 0;

-- The atomic increment path is `INSERT ... ON CONFLICT DO UPDATE SET x = x + $n
-- RETURNING`, which needs the conflict target to exist. It does — the primary
-- key is (tenant_id, period) — and this comment is here so a future migration
-- does not quietly drop it and reintroduce the lost-update race.

-- --------------------------------------------------------------------------
-- SEC-4: credential metadata beside the ciphertext
-- --------------------------------------------------------------------------

ALTER TABLE crm_connection
  ADD COLUMN IF NOT EXISTS credential_kind text NOT NULL DEFAULT 'oauth2'
    CHECK (credential_kind IN ('oauth2','api_key','private_app')),
  ADD COLUMN IF NOT EXISTS expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS rotated_at timestamptz;

-- The ciphertext is written as the JSON envelope the keyring produces, so the
-- wrapped data key travels with the value it wraps. A row moved between
-- tenants does not decrypt: the tenant id is authenticated as additional data.
COMMENT ON COLUMN crm_connection.credential_cipher IS
  'Sealed credential envelope: {v, provider, keyId, wrappedKey, iv, ciphertext, tag}. Never a plaintext token.';

-- --------------------------------------------------------------------------
-- PERF-2: signed audit-chain checkpoints
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_checkpoint (
  tenant_id   text        NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  sequence    bigint      NOT NULL,
  hash        char(64)    NOT NULL,
  verified_at timestamptz NOT NULL,
  -- HMAC under a key the application holds and the database does not. Without
  -- it a checkpoint is only a claim that some process had verified the chain,
  -- and an attacker who can write checkpoints can skip verification of
  -- everything before one.
  signature   char(64)    NOT NULL,
  PRIMARY KEY (tenant_id, sequence)
);

-- --------------------------------------------------------------------------
-- SEC-8: API key lifecycle
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS api_key (
  id            text        PRIMARY KEY,
  tenant_id     text        NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  audience      text        NOT NULL CHECK (audience IN ('widget','tenant_admin','platform_admin')),
  -- Short random public identifier carried in the key. Not a secret, and not
  -- the tenant id: the previous format published an internal identifier in the
  -- HTML of every page on a tenant's website for no benefit.
  prefix        text        NOT NULL UNIQUE,
  digest        char(64)    NOT NULL UNIQUE,
  label         text,
  -- Browser origins this key may be presented from. Empty falls back to the
  -- tenant's registered origins; a tenant with neither cannot serve traffic.
  origins       text[]      NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz,
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  rotated_to_id text        REFERENCES api_key(id)
);

CREATE INDEX IF NOT EXISTS api_key_by_tenant ON api_key (tenant_id, created_at DESC);

-- --------------------------------------------------------------------------
-- SEC-5: registered origins on the tenant
-- --------------------------------------------------------------------------

ALTER TABLE tenant
  ADD COLUMN IF NOT EXISTS origins text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS origins_verified_at timestamptz;

-- --------------------------------------------------------------------------
-- Row-level security for the new tables
-- --------------------------------------------------------------------------
--
-- Adding a tenant-scoped table without adding it here is the mistake the list
-- in 0001 exists to make visible. These two are tenant-scoped, so they get the
-- same treatment: FORCE, a policy keyed on the transaction-local binding, and
-- no BYPASSRLS on the application role.

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['audit_checkpoint', 'api_key']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true))
       WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
      target
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO awa_app', target);
  END LOOP;
END
$$;

-- A checkpoint is evidence about the chain, so it is append-only for the same
-- reason the chain is: a checkpoint that can be rewritten is a checkpoint that
-- can be made to endorse a tampered history.
REVOKE UPDATE ON audit_checkpoint FROM awa_app;

COMMIT;
