# Database

## Why row-level security rather than application filtering

Section 24.2 requires tenant isolation "enforced at the database and at query
construction, never by application-level filtering alone". The practical
difference: an application-filtered system leaks the first time someone writes a
query without a `WHERE tenant_id = $1`, and that mistake is invisible in review
until it is a breach notification. Under RLS with `FORCE` and a `NOBYPASSRLS`
role, the same mistake returns zero rows.

## Session binding

Every request binds its tenant inside the transaction:

```sql
BEGIN;
SET LOCAL app.tenant_id = 't_acme';
-- ... application statements ...
COMMIT;
```

`SET LOCAL` rather than `SET`: the binding must not survive the transaction back
into a pooled connection, where it would silently become another request's
tenant context. That is the single most dangerous mistake available in this
design, so it is stated here and asserted in the isolation probe suite.

A statement issued without the binding sees nothing, because
`current_setting('app.tenant_id', true)` returns NULL and `tenant_id = NULL` is
never true. Failing closed is deliberate.

## What is append-only, and why twice

`consent_event` and `audit_entry` are protected by both a trigger and a withheld
`UPDATE`/`DELETE` grant. The trigger can be dropped by a careless migration; the
missing grant cannot be worked around from application code. Neither control is
sufficient alone, and the pair costs nothing.

## Erasure

Erasure runs across four stores (section 25.5): this database, the tenant's
vector namespace, object storage for voice artefacts, and the conversational
vendor's own retention. `audit_entry` is deliberately exempt on
legal-obligation grounds, the evidence that an erasure happened cannot itself
be erased, and holds no personal data to begin with, because payloads are
redacted before they are written.

## Migrations

Applied as `awa_migrator`. The application role `awa_app` has no DDL rights and
no `BYPASSRLS`, so a compromised application credential cannot disable the
isolation policy it runs under.
