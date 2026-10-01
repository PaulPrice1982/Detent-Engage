-- Platform control-plane snapshot. The payload is authenticated ciphertext,
-- containing tenant configuration, key digests, encrypted recoverable widget
-- keys, and visitor sessions with their original expiry timestamps.
-- Audit includes a *platform* chain without a customer tenant row, just as
-- audit_entry does. Its signed checkpoints must support the same scope.
ALTER TABLE audit_checkpoint DROP CONSTRAINT IF EXISTS audit_checkpoint_tenant_id_fkey;

CREATE TABLE IF NOT EXISTS runtime_snapshot (
  id text PRIMARY KEY,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS parked_write (
  tenant_id text NOT NULL REFERENCES tenant(tenant_id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (tenant_id, idempotency_key)
);
ALTER TABLE parked_write ENABLE ROW LEVEL SECURITY;
ALTER TABLE parked_write FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON parked_write;
CREATE POLICY tenant_isolation ON parked_write
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

CREATE TABLE IF NOT EXISTS operator_approval (
  action_id text PRIMARY KEY,
  payload jsonb NOT NULL
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'awa_app') THEN
    GRANT SELECT, INSERT, UPDATE ON runtime_snapshot, operator_approval TO awa_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON parked_write TO awa_app;
  END IF;
END $$;
