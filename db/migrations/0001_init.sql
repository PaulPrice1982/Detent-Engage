-- Detent Agentic Website Assistant — initial schema.
--
-- Tenant isolation is enforced at the database under a restricted role, not by
-- application-level filtering (decision 5, section 24.2). The application
-- connects as `awa_app`, which has no BYPASSRLS, so a forgotten WHERE clause in
-- application code cannot return another tenant's rows: the database refuses.
--
-- Every session sets `app.tenant_id` inside the transaction. A statement run
-- without it sees nothing at all, which is the correct failure mode.
--
-- This file does not manage its own transaction. The runner wraps each
-- migration together with the row recording it as applied, so the two either
-- both land or neither does. A COMMIT here ended the runner's transaction
-- early: the schema committed, the ledger row did not, and every later start
-- re-ran a migration whose tables already existed and stopped on
-- 'relation "tenant" already exists'. Every statement below is also safe to
-- run again, so a database that already carries the schema is adopted rather
-- than refused.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- --------------------------------------------------------------------------
-- Roles
-- --------------------------------------------------------------------------

-- RDS, Cloud SQL and Neon hand the application an ordinary owner role that
-- cannot CREATE ROLE. The isolation this schema relies on is the policy, FORCE
-- ROW LEVEL SECURITY and SET LOCAL app.tenant_id, none of which need awa_app,
-- so a hosted PostgreSQL that refuses the role must not take the whole schema
-- down with it. The grants below are skipped in the same way.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'awa_app') THEN
    -- NOBYPASSRLS is the point of this role. It is stated explicitly so that a
    -- future ALTER ROLE granting BYPASSRLS is visible as a deliberate act.
    CREATE ROLE awa_app NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'awa_migrator') THEN
    CREATE ROLE awa_migrator NOLOGIN;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'Not permitted to create roles here; continuing without awa_app. '
    'Row level security still applies: grant an existing NOBYPASSRLS role instead.';
END
$$;

-- --------------------------------------------------------------------------
-- Tenancy
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant (
  tenant_id                 text PRIMARY KEY,
  name                      text        NOT NULL,
  state                     text        NOT NULL
    CHECK (state IN ('REGISTERED','DPA_SIGNED','CRM_CONNECTED','MAPPED','TEST_MODE','LIVE','DEGRADED','SUSPENDED','OFFBOARDING')),
  residency                 text        NOT NULL CHECK (residency IN ('UK','EU')),
  home_jurisdiction         text        NOT NULL,
  connector                 text        NOT NULL,
  config_version            integer     NOT NULL DEFAULT 1,
  config                    jsonb       NOT NULL,
  dpa_signed_at             timestamptz,
  field_mapping_accepted_at timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  -- The lifecycle gates from section 23.4, enforced by the database rather
  -- than only by the application. A tenant cannot reach a CRM-connected state
  -- without a DPA record, or go live without an accepted field mapping.
  CONSTRAINT dpa_before_crm CHECK (
    state IN ('REGISTERED','DPA_SIGNED') OR dpa_signed_at IS NOT NULL
  ),
  CONSTRAINT mapping_before_live CHECK (
    state NOT IN ('LIVE','DEGRADED') OR field_mapping_accepted_at IS NOT NULL
  )
);

-- Per-tenant CRM credentials. The ciphertext is produced by envelope
-- encryption under a per-tenant KMS key; this table never holds plaintext, and
-- the key id is stored so a rotation can be audited and replayed.
CREATE TABLE IF NOT EXISTS crm_connection (
  tenant_id        text        PRIMARY KEY REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  connector        text        NOT NULL,
  state            text        NOT NULL CHECK (state IN ('CONNECTED','DEGRADED','DISCONNECTED')),
  kms_key_id       text        NOT NULL,
  credential_cipher bytea      NOT NULL,
  region           text,
  instance_url     text,
  last_error       text,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- Consent evidence
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS consent_event (
  id             text        PRIMARY KEY,
  tenant_id      text        NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  subject_ref    text        NOT NULL,
  purpose        text        NOT NULL CHECK (purpose IN ('IDENTITY_RESOLUTION','MARKETING','RECORDING','TRANSCRIPTION')),
  lawful_basis   text        NOT NULL,
  -- The exact text shown to the person, stored verbatim. Not a key into a
  -- table of wordings: the wording table would change and the evidence would
  -- quietly become a different claim.
  wording_shown  text        NOT NULL,
  choice         text        NOT NULL CHECK (choice IN ('GRANTED','REFUSED','WITHDRAWN')),
  source         text        NOT NULL,
  jurisdiction   text        NOT NULL,
  correlation_id text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS consent_event_lookup ON consent_event (tenant_id, subject_ref, purpose, created_at DESC);

-- Consent evidence is append-only. An UPDATE or DELETE is refused outright: a
-- withdrawal is a new event, not an edit to an old one.
CREATE OR REPLACE FUNCTION awa_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only; % is not permitted', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS consent_event_append_only ON consent_event;
CREATE TRIGGER consent_event_append_only
  BEFORE UPDATE OR DELETE ON consent_event
  FOR EACH ROW EXECUTE FUNCTION awa_append_only();

-- --------------------------------------------------------------------------
-- Conversations
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversation (
  id              text        PRIMARY KEY,
  tenant_id       text        NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  subject_ref     text        NOT NULL,
  correlation_id  text        NOT NULL,
  channel         text        NOT NULL DEFAULT 'web',
  modality        text        NOT NULL CHECK (modality IN ('text','voice')),
  state           text        NOT NULL,
  jurisdiction    text        NOT NULL,
  classification  text,
  outcome         text,
  -- The version pins that make a conversation replayable months later.
  prompt_version  text        NOT NULL,
  policy_version  text        NOT NULL,
  model_version   text        NOT NULL,
  config_version  integer     NOT NULL,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);

CREATE INDEX IF NOT EXISTS conversation_by_tenant ON conversation (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS conversation_by_correlation ON conversation (tenant_id, correlation_id);

CREATE TABLE IF NOT EXISTS conversation_message (
  id             bigserial   PRIMARY KEY,
  tenant_id      text        NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  conversation_id text       NOT NULL REFERENCES conversation(id) ON DELETE CASCADE,
  role           text        NOT NULL CHECK (role IN ('visitor','assistant')),
  body           text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_message_by_conversation ON conversation_message (tenant_id, conversation_id, id);

-- --------------------------------------------------------------------------
-- Write receipts and reconciliation
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS write_receipt (
  id              text        PRIMARY KEY,
  tenant_id       text        NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  correlation_id  text        NOT NULL,
  idempotency_key text        NOT NULL,
  connector       text        NOT NULL,
  operation       text        NOT NULL,
  state           text        NOT NULL CHECK (state IN ('PENDING','CONFIRMED','FAILED','RECONCILING')),
  external_id     text,
  attempts        integer     NOT NULL DEFAULT 1,
  last_error      text,
  envelope        jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- The uniqueness that makes retries safe. Without it, "idempotent" is a
  -- property of the happy path only.
  CONSTRAINT write_receipt_idempotent UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS write_receipt_reconciliation ON write_receipt (tenant_id, state)
  WHERE state IN ('PENDING','RECONCILING');

-- --------------------------------------------------------------------------
-- Audit
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_entry (
  id             text        PRIMARY KEY,
  tenant_id      text        NOT NULL,
  sequence       bigint      NOT NULL,
  type           text        NOT NULL,
  correlation_id text        NOT NULL,
  session_id     text,
  actor          text        NOT NULL,
  subject_ref    text,
  consent_event_id text,
  payload        jsonb,
  versions       jsonb,
  previous_hash  char(64)    NOT NULL,
  hash           char(64)    NOT NULL,
  recorded_at    timestamptz NOT NULL DEFAULT now(),

  -- One chain per tenant, contiguous. A gap in the sequence is a detected
  -- deletion, not an ambiguity to be argued about later.
  CONSTRAINT audit_chain_position UNIQUE (tenant_id, sequence),
  CONSTRAINT audit_chain_link UNIQUE (tenant_id, hash)
);

CREATE INDEX IF NOT EXISTS audit_by_correlation ON audit_entry (tenant_id, correlation_id, sequence);
CREATE INDEX IF NOT EXISTS audit_by_type ON audit_entry (tenant_id, type, recorded_at DESC);

DROP TRIGGER IF EXISTS audit_entry_append_only ON audit_entry;
CREATE TRIGGER audit_entry_append_only
  BEFORE UPDATE OR DELETE ON audit_entry
  FOR EACH ROW EXECUTE FUNCTION awa_append_only();

-- --------------------------------------------------------------------------
-- Knowledge
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS knowledge_chunk (
  id             text        PRIMARY KEY,
  tenant_id      text        NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  corpus_version integer     NOT NULL,
  state          text        NOT NULL CHECK (state IN ('DRAFT','PUBLISHED','RETIRED')),
  source_kind    text        NOT NULL,
  source_ref     text        NOT NULL,
  title          text        NOT NULL,
  body           text        NOT NULL,
  approved_by    text,
  approved_at    timestamptz,
  supersedes     text REFERENCES knowledge_chunk(id),
  created_at     timestamptz NOT NULL DEFAULT now(),

  -- Nothing is servable without a named approver. The review step is a
  -- constraint, not a workflow convention.
  CONSTRAINT published_requires_approver CHECK (
    state <> 'PUBLISHED' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS knowledge_published ON knowledge_chunk (tenant_id, state) WHERE state = 'PUBLISHED';

-- --------------------------------------------------------------------------
-- Metering
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS usage_period (
  tenant_id        text        NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  period           char(7)     NOT NULL,
  conversations    bigint      NOT NULL DEFAULT 0,
  text_messages    bigint      NOT NULL DEFAULT 0,
  voice_minutes    numeric(14,3) NOT NULL DEFAULT 0,
  crm_calls        bigint      NOT NULL DEFAULT 0,
  llm_tokens       bigint      NOT NULL DEFAULT 0,
  spend_pence      numeric(14,3) NOT NULL DEFAULT 0,
  concurrent_voice integer     NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, period),
  CONSTRAINT spend_non_negative CHECK (spend_pence >= 0),
  CONSTRAINT concurrency_non_negative CHECK (concurrent_voice >= 0)
);

-- --------------------------------------------------------------------------
-- Row-level security
-- --------------------------------------------------------------------------

-- Every tenant-scoped table. Adding a table without adding it here is the
-- mistake this list exists to make visible, so the isolation probe suite in CI
-- asserts that every table with a tenant_id column appears below.
DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'tenant', 'crm_connection', 'consent_event', 'conversation',
    'conversation_message', 'write_receipt', 'audit_entry',
    'knowledge_chunk', 'usage_period'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target);
    -- CREATE POLICY has no IF NOT EXISTS, so the drop is how this stays
    -- re-runnable. Dropped and recreated rather than left alone, so the
    -- policy in the database is always the one this file states.
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', target);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true))
       WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true))',
      target
    );
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'awa_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO awa_app', target);
    END IF;
  END LOOP;
END
$$;

-- Append-only tables get no UPDATE or DELETE grant either. Two independent
-- controls, because a trigger can be dropped by a migration and a missing
-- grant cannot be worked around from application code.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'awa_app') THEN
    REVOKE UPDATE ON consent_event, audit_entry FROM awa_app;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO awa_app;
  END IF;
END
$$;

