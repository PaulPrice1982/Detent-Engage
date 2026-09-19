-- Everything the platform was still holding in memory, plus one correction to
-- the isolation model that stopped the application working at all under a
-- normal database role.
--
-- No BEGIN or COMMIT: the migration runner owns the transaction. See 0001.

-- --------------------------------------------------------------------------
-- The tenant registry is platform data, not tenant data
-- --------------------------------------------------------------------------
--
-- `tenant` carried the same policy as every table under it:
--   tenant_id = current_setting('app.tenant_id', true)
--
-- Which cannot be satisfied by the one operation the table exists for. Listing
-- the tenants at start-up means reading rows for tenants you have not yet
-- identified, so under FORCE ROW LEVEL SECURITY the list came back empty and
-- the platform restored nothing. Setting app.tenant_id to some wildcard would
-- have meant a policy with a hole in it, which is worse than no policy because
-- it reads like one.
--
-- The isolation that matters is on the tables holding a customer's data:
-- conversations, messages, knowledge, consent, audit, receipts and usage. All
-- of those keep FORCE ROW LEVEL SECURITY. The registry of which tenants exist
-- is the platform's own record, read by the platform as the platform, and it
-- is protected by the fact that nothing but the platform ever connects.
DROP POLICY IF EXISTS tenant_isolation ON tenant;
ALTER TABLE tenant NO FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant DISABLE ROW LEVEL SECURITY;

-- --------------------------------------------------------------------------
-- Metering: the counters the schema did not have a column for
-- --------------------------------------------------------------------------
--
-- Usage was held in memory, so what a customer is billed for did not survive a
-- restart and did not agree between two instances of the same deployment. The
-- table existed; three of the counters did not.

ALTER TABLE usage_period ADD COLUMN IF NOT EXISTS qualified_outcomes  bigint NOT NULL DEFAULT 0;
ALTER TABLE usage_period ADD COLUMN IF NOT EXISTS enrichment_records  bigint NOT NULL DEFAULT 0;
ALTER TABLE usage_period ADD COLUMN IF NOT EXISTS company_resolutions bigint NOT NULL DEFAULT 0;

-- --------------------------------------------------------------------------
-- Outcomes
-- --------------------------------------------------------------------------
--
-- What the customer is billed for. Held in memory, it did not survive a
-- restart and did not agree between two instances of the same deployment,
-- which for a product priced per outcome is a billing dispute waiting to be
-- had rather than an inconvenience.

CREATE TABLE IF NOT EXISTS outcome (
  id             text        PRIMARY KEY,
  tenant_id      text        NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  correlation_id text        NOT NULL,
  state          text        NOT NULL,
  billable       boolean     NOT NULL DEFAULT false,
  recorded_at    timestamptz NOT NULL DEFAULT now(),
  document       jsonb       NOT NULL
);

CREATE INDEX IF NOT EXISTS outcome_by_correlation ON outcome (tenant_id, correlation_id);
CREATE INDEX IF NOT EXISTS outcome_by_tenant ON outcome (tenant_id, recorded_at DESC);

-- --------------------------------------------------------------------------
-- Payments
-- --------------------------------------------------------------------------
--
-- Account-scoped rather than tenant-scoped, like everything else in 0002, so
-- no row level security here: an account is not a tenant and there is no
-- tenant_id to bind.
--
-- The table itself came in 0002. What it lacked was somewhere to record the
-- idempotency key, without which a retried charge is a second charge, and an
-- updated_at, without which a status change is invisible. Added rather than
-- recreated, because the rows in it are payments.
--
-- The platform never holds a card number. `document` carries the provider's
-- token reference and nothing that could reconstruct an instrument.

ALTER TABLE payment ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE payment ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- A partial unique index rather than a column constraint, because a payment
-- made without an idempotency key is legitimate and several of them must not
-- collide on NULL.
CREATE UNIQUE INDEX IF NOT EXISTS payment_idempotency_idx
  ON payment (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Webhook deliveries already handled. A provider retries, and a retry that is
-- processed twice charges or credits twice.
CREATE TABLE IF NOT EXISTS payment_event (
  event_id     text        PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Suppression
-- --------------------------------------------------------------------------
--
-- Who must not be contacted again. Held in memory, an opt-out lasted until the
-- next deploy, which is the one failure in this system with a fine attached.
--
-- The address itself is never stored: `digest` is a salted SHA-256, so the
-- list can answer "is this address suppressed" without holding the addresses
-- of people who asked to be left alone.

CREATE TABLE IF NOT EXISTS suppression (
  digest       text        PRIMARY KEY,
  reason       text        NOT NULL,
  channel      text        NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  document     jsonb       NOT NULL
);

-- --------------------------------------------------------------------------
-- Isolation for the new tenant-scoped table, and the grants
-- --------------------------------------------------------------------------

ALTER TABLE outcome ENABLE ROW LEVEL SECURITY;
ALTER TABLE outcome FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON outcome;
CREATE POLICY tenant_isolation ON outcome
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'awa_app') THEN
    GRANT SELECT, INSERT, UPDATE ON outcome TO awa_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON payment, payment_event, suppression TO awa_app;
  END IF;
END
$$;
