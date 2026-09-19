-- The commercial and platform tables.
--
-- 0001 covers the conversational plane: tenants, conversations, knowledge,
-- audit, usage. Everything a customer buys with, signs in with, and reads on
-- the website came later and is here.
--
-- Shape of these tables: identity columns for what is looked up, plus the whole
-- record as jsonb. The application already owns these types and validates them
-- on the way in; a column per field would mean a migration every time a field
-- is added, and this product is still finding its shape. Where a figure is
-- reported on rather than merely stored, invoice status, period, totals, it
-- gets a real column as well, because "sum the revenue" should not mean
-- unpacking json.
--
-- Money is stored as bigint minor units. Never float: 0.1 + 0.2 is not 0.3, and
-- an invoice that disagrees with itself by a penny costs more to explain than
-- the penny is worth.

-- No BEGIN or COMMIT: the migration runner owns the transaction. See 0001.

-- --------------------------------------------------------------------------
-- Identity
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS auth_user (
  user_id       text PRIMARY KEY,
  realm         text NOT NULL CHECK (realm IN ('console','app','reseller')),
  -- Stored lowercased. Uniqueness is per realm, deliberately: the same person
  -- may hold a customer account and a reseller portal login, and they are not
  -- the same identity.
  email         text NOT NULL,
  tenant_id     text,
  account_id    text,
  reseller_id   text,
  document      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (realm, email)
);
CREATE INDEX IF NOT EXISTS auth_user_tenant_idx ON auth_user (tenant_id);
CREATE INDEX IF NOT EXISTS auth_user_reseller_idx ON auth_user (reseller_id);

CREATE TABLE IF NOT EXISTS auth_session (
  session_id    text PRIMARY KEY,
  user_id       text NOT NULL,
  realm         text NOT NULL,
  -- Indexed so expiry can be swept without reading every row.
  expires_at    timestamptz NOT NULL,
  document      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_session_user_idx ON auth_session (user_id);
CREATE INDEX IF NOT EXISTS auth_session_expiry_idx ON auth_session (expires_at);

CREATE TABLE IF NOT EXISTS password_reset_token (
  -- The hash is the key. The token itself is never stored: a reset table that
  -- holds usable tokens is a table that grants access to every account in it.
  token_hash    text PRIMARY KEY,
  user_id       text NOT NULL,
  email         text NOT NULL,
  requested_at  timestamptz NOT NULL,
  document      jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS password_reset_user_idx ON password_reset_token (user_id);
-- Drives the rate limiter, which counts requests per address over a window.
CREATE INDEX IF NOT EXISTS password_reset_email_idx ON password_reset_token (email, requested_at);

-- --------------------------------------------------------------------------
-- Commercial
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS account (
  account_id    text PRIMARY KEY,
  tenant_id     text NOT NULL UNIQUE,
  name          text NOT NULL,
  status        text NOT NULL,
  document      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- The commercial terms attached to an account: plan, term, renewal, credits.
CREATE TABLE IF NOT EXISTS account_subscription (
  account_id    text PRIMARY KEY REFERENCES account (account_id) ON DELETE CASCADE,
  plan_code     text NOT NULL,
  document      jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscription (
  subscription_id text PRIMARY KEY,
  tenant_id       text NOT NULL,
  plan_code       text NOT NULL,
  -- The plan *version* a subscription was sold on. A price change never alters
  -- what an existing customer pays, and this column is what makes that true.
  plan_version    integer,
  state           text NOT NULL,
  document        jsonb NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subscription_tenant_idx ON subscription (tenant_id);

CREATE TABLE IF NOT EXISTS plan_version (
  plan_code     text NOT NULL,
  version       integer NOT NULL,
  document      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Immutable once written. A published version is what somebody was sold on,
  -- so it is inserted and never updated; a change is a new version.
  PRIMARY KEY (plan_code, version)
);

CREATE TABLE IF NOT EXISTS invoice (
  invoice_id      text PRIMARY KEY,
  -- Assigned at issue, never before, and gapless per entity per year.
  invoice_number  text UNIQUE,
  account_id      text NOT NULL,
  tenant_id       text NOT NULL,
  status          text NOT NULL,
  currency        text NOT NULL,
  period          text NOT NULL,
  subtotal_minor  bigint NOT NULL,
  tax_minor       bigint NOT NULL,
  total_minor     bigint NOT NULL,
  amount_due_minor bigint NOT NULL,
  issued_at       timestamptz,
  paid_at         timestamptz,
  document        jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoice_account_idx ON invoice (account_id, period);
CREATE INDEX IF NOT EXISTS invoice_status_idx ON invoice (status, period);

-- The number sequence. A row per entity and year, incremented atomically.
CREATE TABLE IF NOT EXISTS invoice_sequence (
  entity        text NOT NULL,
  year          integer NOT NULL,
  last_number   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (entity, year)
);

CREATE TABLE IF NOT EXISTS credit_lot (
  lot_id        text PRIMARY KEY,
  account_id    text NOT NULL,
  document      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS credit_lot_account_idx ON credit_lot (account_id);

CREATE TABLE IF NOT EXISTS credit_ledger_entry (
  entry_id      text PRIMARY KEY,
  account_id    text NOT NULL,
  -- Per-account and gapless: the ledger is read in order, and a gap is either
  -- a lost write or a tampered one. Neither may pass unnoticed.
  sequence      bigint NOT NULL,
  -- A repeated request must not spend the balance twice. Unique per account
  -- rather than globally, so two customers may use the same key.
  idempotency_key text,
  document      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, sequence)
);
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_idempotency_idx
  ON credit_ledger_entry (account_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS payment (
  payment_id    text PRIMARY KEY,
  account_id    text NOT NULL,
  status        text NOT NULL,
  -- A token reference from the payment provider. Never a card number, never a
  -- CVV, never an expiry: holding any of those puts the whole platform in
  -- scope for PCI DSS, and this column is the reason it is not.
  provider_ref  text,
  document      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_account_idx ON payment (account_id);

-- --------------------------------------------------------------------------
-- Channel
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reseller (
  reseller_id   text PRIMARY KEY,
  name          text NOT NULL,
  contact_email text NOT NULL UNIQUE,
  status        text NOT NULL,
  document      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Every link a customer has ever had, open and closed. Commission for a past
-- period is worked out from who held the customer then, so a closed link is
-- kept rather than deleted.
CREATE TABLE IF NOT EXISTS reseller_account_link (
  link_id       bigserial PRIMARY KEY,
  account_id    text NOT NULL,
  reseller_id   text NOT NULL REFERENCES reseller (reseller_id) ON DELETE CASCADE,
  margin_basis_points integer,
  since         timestamptz NOT NULL,
  until         timestamptz,
  linked_by     text NOT NULL
);
CREATE INDEX IF NOT EXISTS reseller_link_account_idx ON reseller_account_link (account_id);
CREATE INDEX IF NOT EXISTS reseller_link_reseller_idx ON reseller_account_link (reseller_id);
-- At most one open link per customer. Two would mean two resellers earning on
-- the same revenue, which the database should refuse rather than the
-- application remember to.
CREATE UNIQUE INDEX IF NOT EXISTS reseller_link_one_open_idx
  ON reseller_account_link (account_id) WHERE until IS NULL;

CREATE TABLE IF NOT EXISTS reseller_territory (
  -- The postcode area is the key, which is what makes exclusivity a database
  -- guarantee rather than a promise the application has to keep.
  area          text PRIMARY KEY,
  reseller_id   text NOT NULL REFERENCES reseller (reseller_id) ON DELETE CASCADE,
  granted_at    timestamptz NOT NULL,
  granted_by    text NOT NULL
);
CREATE INDEX IF NOT EXISTS reseller_territory_reseller_idx ON reseller_territory (reseller_id);

-- --------------------------------------------------------------------------
-- Website and support
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS cms_page (
  page_id       text PRIMARY KEY,
  slug          text NOT NULL UNIQUE,
  state         text NOT NULL,
  nav_order     integer,
  document      jsonb NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS support_request (
  request_id    text PRIMARY KEY,
  account_id    text NOT NULL,
  tenant_id     text NOT NULL,
  state         text NOT NULL,
  document      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS support_request_account_idx ON support_request (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_request_state_idx ON support_request (state, created_at);

-- --------------------------------------------------------------------------
-- Grants
-- --------------------------------------------------------------------------
--
-- The application role gets data rights and no schema rights. A process that
-- cannot DROP a table cannot be made to drop one.

DO $$
DECLARE
  t text;
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'awa_app') THEN
    FOREACH t IN ARRAY ARRAY[
      'auth_user','auth_session','password_reset_token','account',
      'account_subscription','subscription','plan_version','invoice',
      'invoice_sequence','credit_lot','credit_ledger_entry','payment',
      'reseller','reseller_account_link','reseller_territory','cms_page',
      'support_request'
    ] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO awa_app', t);
    END LOOP;
    GRANT USAGE, SELECT ON SEQUENCE reseller_account_link_link_id_seq TO awa_app;
  END IF;
END
$$;

