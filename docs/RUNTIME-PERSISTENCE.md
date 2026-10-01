# Assistant runtime persistence

The server entry point uses Postgres whenever `DATABASE_URL` is set. It restores
tenant settings, API-key digests and revocations, customer widget ownership and
keys, active visitor conversations (with their original expiry times), and the
platform kill switch before listening. The snapshot is authenticated ciphertext
under `AWA_ROOT_KEY`. Tenant registry rows and the snapshot commit together.

Audit entries and signed checkpoints, consent evidence, usage, CRM credentials,
write receipts, parked writes, runtime knowledge, outcomes, suppression records,
credits, subscriptions and operator approvals use their Postgres adapters.
Successful HTTP responses and SSE events are withheld until runtime state has
committed. A persistence failure refuses further requests until restart.

## Deployment

1. Back up the database and retain the existing encryption keys.
2. Apply migrations with `node tools/migrate.mjs`, including `0006_runtime.sql`.
3. Set stable `AWA_ROOT_KEY` (32 random bytes, base64url) and
   `AWA_CHECKPOINT_KEY`, alongside the existing production settings.
   `AWA_ALLOW_LOCAL_KEY` cannot bypass the stable-key requirement.
4. Run **one serving instance** using a direct Postgres connection or a
   session-pooling proxy. Stop the previous instance before starting its
   replacement. A session-level advisory lock excludes concurrent runtimes;
   loss of its database connection terminates the process.

Requests are serialised while the cached domain models are in use. This is a
correctness constraint and limits throughput; autoscaling and overlapping
rolling deployments are intentionally refused. Moving those models to fully
transactional repositories is required before enabling replicas.

Production registers the real CRM adapters but does not create a demo tenant,
sign a demo DPA, connect a `dev-token`, or generate replacement API keys.
New customer tenants remain REGISTERED with an unconfigured connector until
their ordinary onboarding is completed. Historical state already lost by the
old in-memory runtime cannot be recovered by this migration.

Customer uploads and review records share the encrypted runtime snapshot, while
website approvals and manual entries publish to the assistant's serving corpus.
Publication waits for its archive write before exposing the content to retrieval.
Document withdrawal retires associated chunks and prevents their drafts being
approved again. Existing version-one snapshots without uploads/reviews remain
readable; those optional fields start empty.

Pricing drafts, published versions and withdrawn history use the existing
Postgres `plan_version` table from migration `0003_platform.sql`. Publication
withdraws the old version and publishes the new one in a single transaction.
Startup seeds only missing initial versions; it does not overwrite stored terms.
The console, customer accounts and assistant subscription service share this
catalogue. New subscriptions save the published plan version and its terms;
existing subscriptions retain their contracted fees, credits and entitlements.
Older subscription records without a terms snapshot resolve their exact historical
version and fail closed if that version is unavailable. Pricing changes lost by
the previous in-memory implementation cannot be reconstructed automatically.
Short-lived caches and provider-owned external state are not represented as
durable application records.

## Verification

`tests/runtime-restart.test.ts` covers restored identities, settings, sessions,
expiry, revocation, failure handling and response ordering. The encrypted archive
test checks that recoverable widget keys are not plaintext in storage.
`tests/customer-knowledge-runtime.test.ts` exercises the authenticated customer
routes, tenant isolation, restart recovery and withdrawal, plus failed saves.

Set `TEST_DATABASE_URL` to a disposable Postgres test database and run
`tests/runtime-postgres.test.ts` for migration, fresh-pool recovery of state and
evidence, and exclusion of a second serving instance. The integration test skips
when no test database is configured; the offline tests do not prove SQL behavior.

`tests/pricing-persistence.test.ts` covers published sale prices, historical terms,
account entitlements and stale change confirmations. Its Postgres restart test
also requires `TEST_DATABASE_URL` and is skipped when it is absent.
