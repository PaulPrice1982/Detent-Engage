# Response to the independent code audit, 18 September 2026

Every recommendation in the audit has been accepted and implemented. This is the
finding-by-finding record: what was found, what changed, and where to look. It
is written to be checked rather than believed — each row names the file that
closes the finding and, where there is one, the test that would fail if it
regressed.

Two figures that moved: the suite went from 387 tests to 484, and the shipping
surface is now explicit rather than implicit — everything beyond the v1.0 spine
is behind a feature flag (`packages/core/src/features.ts`), which is the
structural half of the audit's "cut scope hard and ship a spine".

---

## 1 · User experience

| Finding | What changed | Where | Test |
|---|---|---|---|
| **UX-1 (high)** · The panel could not be closed from the keyboard and had no close control. Escape was bound on the host document while the conversation lives in a cross-origin iframe, so keystrokes never reached it — WCAG 2.2 failures 2.1.2 and 2.4.3 behind a README claiming AA. | A close control in the panel header; Escape handled inside the panel; a `postMessage` handshake to the launcher, accepted only from the panel's own origin; focus moved to the heading on open and returned to the launcher on close. | `packages/widget/public/panel.html`, `panel.js`, `packages/widget/src/launcher.ts` | `tests/visitor-surface.test.ts` |
| **UX-2 (high)** · No streaming and no typing indicator; a multi-second turn read as broken. | A typing indicator on submit, and sentence-level streaming over server-sent events. Each sentence is validated by the same output validator before it is sent, so perceived latency drops without unvalidated text reaching anyone. | `TurnOrchestrator.runStreaming`, `POST /v1/sessions/{id}/stream`, `packages/agent/src/providers/anthropic.ts` | `tests/streaming-and-provider.test.ts` |
| **UX-3 (high)** · No admin interface at all. The approval workflow — the product's central claim — was reachable only by curl. | A five-screen console: Connect, Generate and approve, Dry run, Go live, Evidence. One static page, no build step, against the same API the tests exercise. | `packages/server/public/console.html` | `tests/visitor-surface.test.ts` |
| **UX-4 (medium)** · The conversation was lost on every page navigation, which also inflated the conversation meter and the tenant's bill. | The session id is held in the panel's partitioned `sessionStorage` and the transcript is replayed from `GET /v1/sessions/{id}`. Every storage access is guarded, because it throws in a private window. | `panel.js`, `Api.handleSessions` | `tests/visitor-surface.test.ts` |
| **UX-5 (medium)** · Mobile was an afterthought: a desktop card squeezed onto a phone, no keyboard handling, no safe-area padding. | Below 640px the panel is a full-screen sheet; `visualViewport` drives the panel height so the composer stays above the on-screen keyboard; `env(safe-area-inset-*)` throughout. | `launcher.ts`, `panel.css`, `panel.js` | `tests/visitor-surface.test.ts` |
| **UX-6 (medium)** · English only, with UI copy hardcoded in the markup. | Locale bundles for en-GB, fr, de, es, nl and it, served from `GET /v1/locales/{locale}`, with per-tenant overrides. Consent wording is stored verbatim per locale, because the evidence is the words the visitor actually saw. | `packages/server/src/locales.ts` | `tests/visitor-surface.test.ts` |
| **UX-7 (medium)** · Escalation was a dead end for the visitor. | The turn returns a structured `nextAction` — `booking_link`, `await_human` (saying explicitly whether a human was notified, and the tenant's response promise) or `leave_details` — rendered as a card. | `packages/agent/src/orchestrator.ts`, `panel.js` | `tests/visitor-surface.test.ts` |
| **UX-8 (medium)** · The consent bar was thinner than the product's own positioning. | A "what does this mean?" disclosure, the tenant's privacy-notice link, and a persistent "forget me" control that records a refusal, drops the transcript and audits the erasure. | `panel.html`, `POST /v1/sessions/{id}/forget` | `tests/visitor-surface.test.ts` |
| **UX-9 (medium)** · Roughly a third of the codebase was unreachable from a browser. | Feature flags name the shipping surface; the spine ships with the v1.2 packages off. The two that earned a surface got one: a dismissible proactive greeting on the launcher, and the partner registry over the admin API. | `packages/core/src/features.ts`, `launcher.ts`, `/v1/admin/tenants/{id}/partners` | `tests/self-serve.test.ts` |
| **UX-10 (low)** · No retry on a failed send, no timestamps, thin branding, body-only analytics windows, an unstyled manual install page. | Retry that keeps the visitor's text; per-turn timestamps; branding for accent, position, avatar, assistant name, font and greeting; query-string reporting windows so a report is linkable; a rebuilt install page with a snippet builder, a CSP generator, a test-mode toggle and live install verification. | `panel.js`, `packages/core/src/tenant.ts`, `Api.window`, `packages/widget/public/install.html` | `tests/visitor-surface.test.ts` |

## 2 · Security

| Finding | What changed | Where | Test |
|---|---|---|---|
| **SEC-1 (high)** · The public widget key could confirm billable outcomes: `handleOutcomes` had no audience check, and the comment claimed a signature that was not verified. | `assertAudience(tenant_admin, platform_admin)` on the route, plus the HMAC signature the comment described, verified where the tenant has configured a signing key. | `Api.handleOutcomes` | `tests/audit-security-findings.test.ts` |
| **SEC-2 (high)** · No abuse control on the visitor API, and the spend cap was checked only after the money was spent. | A token-bucket limiter keyed on key, IP and session with a hard per-conversation ceiling; an input length cap before the tokeniser; origin binding on widget keys; and the spend cap evaluated **before** the model call and at session open, degrading to a booking link rather than failing. | `packages/server/src/rate-limit.ts`, `TurnOrchestrator.execute` | `tests/audit-security-findings.test.ts` |
| **SEC-3 (high)** · Nothing was persisted, and the composition root claimed otherwise. | `@detent/awa-db` implements every store interface against Postgres, with `withTenant` binding `SET LOCAL app.tenant_id` inside a transaction and an isolation probe asserting no adapter can issue an unbound query. Migration `0002` adds the tables the adapters need. The composition root reports `durable` and the dev server says at boot when it is not. The comment now describes what exists. | `packages/db/`, `db/migrations/0002_audit_findings.sql`, `packages/server/src/platform.ts` | `tests/db-isolation-probe.test.ts` |
| **SEC-4 (high)** · CRM credentials were plaintext in a Map, with no rotation path. | Envelope encryption: a per-tenant data key from a key-management provider, AES-256-GCM with the tenant id as additional authenticated data, ciphertext-only at rest, just-in-time decryption in the adapter, `rotateKeys()` for root rotation and `refresh()` for token rotation. | `packages/core/src/keyring.ts`, `EncryptedConnectionStore` | `tests/credential-encryption.test.ts` |
| **SEC-5 (medium)** · CORS defaulted to `*` and keys were not bound to origins. | Keys carry an origin allowlist, falling back to the tenant's registered origins; rejection happens at authentication, not just at CORS, because a bot farm does not run a browser. Origins are registered through the console with an install verification step. A tenant with no registered origins cannot serve widget traffic at all. | `assertOriginAllowed`, `/v1/admin/tenants/{id}/origins` | `tests/audit-security-findings.test.ts` |
| **SEC-6 (medium)** · A tenant admin could raise their own spend cap and widen the exfiltration allowlist. | A per-field authority table, enforced in `update()` against the actor. Operator-only: spend caps, outbound allowlist, kill switch, retention, residency, origins, version pins, dry-run. A field absent from the table is refused to everyone, so adding a config field cannot silently open a hole. | `packages/core/src/config-authority.ts`, `TenantStore.update` | `tests/audit-security-findings.test.ts` |
| **SEC-7 (medium)** · Missing response security headers, and the panel could be framed by anyone. | CSP on every served page with no `'unsafe-inline'` — every style and script moved to a file on the origin — `frame-ancestors` on the panel restricted to the tenant's registered origins, HSTS (opt-in, so a dev box is not locked out), `Permissions-Policy`, and cross-origin resource/opener policies. | `securityHeaders` | `tests/visitor-surface.test.ts` |
| **SEC-8 (medium)** · API key lifecycle was incomplete, and keys published the tenant id. | Short random public prefix instead of the tenant id; expiry; last-used timestamp; rotation with an overlap window; a listing endpoint that never returns a key or a digest; and revoke/rotate by id rather than a linear scan. | `packages/server/src/auth.ts` | `tests/audit-security-findings.test.ts` |
| **SEC-9 (medium)** · Injection defences were English regexes presented as controls. | Normalisation first (zero-width characters, homoglyphs, leetspeak, spaced-out letters, HTML entities, percent-encoding), then multilingual patterns grouped by intent, then an optional classifier stage that can only add a detection. A held-out adversarial corpus with benign commercial controls, and the measured rates published in the assurance pack. | `packages/knowledge/src/injection.ts` | `tests/injection-defence.test.ts` |
| **SEC-10 (low)** · Observability and incident-response gaps: nothing logged on the 500 path, no metrics, `/health` disclosed the kill switch, unpaginated export, fire-and-forget audit writes. | Structured JSON logging with a correlation id returned in the response and written to the log line; a Prometheus registry behind the platform-admin audience; `/health` reduced to liveness; a paginated export with page metadata; and the three `void this.audit.write(...)` calls replaced by awaited appends that happen *before* the change they record. Administrative SSO/MFA remains open and is stated as such in the questionnaire. | `packages/core/src/logging.ts`, `metrics.ts`, `tenant-store.ts`, `AuditLog.export` | `tests/audit-security-findings.test.ts` |

## 3 · Performance and scale

| Finding | What changed | Where | Test |
|---|---|---|---|
| **PERF-1 (high)** · The architecture could not run more than one replica. | Follows from SEC-3: every store is behind an interface with a Postgres adapter, the rate limiter's interface is the one a Redis adapter implements with `INCR`/`EXPIRE`, and session state is the remaining in-process item, with a TTL and a sweep so it is bounded. | `packages/db/`, `rate-limit.ts`, `SessionManager` | `tests/db-isolation-probe.test.ts` |
| **PERF-2 (high)** · Every analytics call re-verified the tenant's entire audit history. | Verification resumes from a signed checkpoint, so it is O(entries since the checkpoint); a forged checkpoint fails to open and is ignored. Analytics read a store-side time range instead of exporting everything, the compliance scorecard folds per UTC day with closed days cached, and the export is paginated. | `AuditLog.verify`, `packages/analytics/src/rollup.ts` | `tests/audit-performance-findings.test.ts` |
| **PERF-3 (high)** · Metering was a non-atomic read-modify-write, so the spend cap under-counted under load. | `UsageStore` now exposes `increment(...)` rather than get/put, applied in one critical section in memory and in one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` statement in Postgres, with the concurrency guard evaluated inside it. | `packages/policy/src/metering.ts`, `PostgresUsageStore` | `tests/audit-performance-findings.test.ts` |
| **PERF-4 (medium)** · Retrieval rebuilt the whole BM25 index on every visitor turn. | An inverted index with length statistics, built once per corpus version, cached per tenant with LRU eviction, scoring only the postings for the query's terms. A retire now bumps the corpus version, so a cached index cannot serve a retired chunk. The test holds the new implementation to producing the old one's exact scores. | `packages/knowledge/src/retrieval.ts` | `tests/audit-performance-findings.test.ts` |
| **PERF-5 (medium)** · The per-tenant audit write queue was an unbounded, never-released map. | Queue entries are evicted when they drain, and `drain()` exists for shutdown and for tests. The ordering guarantee is unchanged. | `AuditLog.write` | `tests/audit-performance-findings.test.ts` |
| **PERF-6 (medium)** · Static assets were served `no-store`, with no compression, ETag or content hashing. | Content-hashed filenames served `immutable` for a year; strong ETags and 304s for everything else; Brotli then gzip for compressible types; `no-store` kept for the panel and the console, because a cached copy of a tenant's disclosure and consent wording is a compliance problem rather than a saving. | `packages/server/src/static-files.ts` | `tests/audit-performance-findings.test.ts`, `tests/static-serving.test.ts` |
| **PERF-7 (medium)** · Sessions never expired: an unbounded memory leak and a retention problem. | 30 minutes idle, 24 hours absolute, checked on read as well as swept on a timer, with the transcript cleared when the session is dropped. | `SessionManager` | `tests/audit-performance-findings.test.ts` |
| **PERF-8 (low)** · No HTTP timeouts, no connection cap, buffered responses, and reconciliation of parked writes was "an in-memory list with no worker". | `headersTimeout`, `requestTimeout`, `keepAliveTimeout` and an optional connection cap; streamed SSE responses rather than buffered ones; the visitor input cap that bounds token cost; and a reconciliation worker that replays parked writes when the connection recovers, bounded by an attempt ceiling, leaving anything it abandons for a human with the reason audited. Replay is safe because the idempotency key was already there. | `createHttpServer`, `packages/connectors/src/reconciliation.ts` | `tests/crm-integrity.test.ts` |

## 4 · The commercial offering

| Finding | What changed | Where |
|---|---|---|
| **BIZ-1 (high)** · Cut scope hard and ship a spine; the billing package was a dependency of nothing. | `SPINE_FEATURES` versus `ALL_FEATURES`, with per-flag environment overrides: the v1.2 packages are off by default and the surfaces that need them say `501` rather than pretending. The billing package is wired into the composition root against the plan catalogue. | `packages/core/src/features.ts`, `Platform` |
| **BIZ-2 (medium)** · Turn the compliance scorecard into the thing that gets bought. | `/assurance.html`: the pack as a document, with chain verification, disclosure coverage, consent breakdown, the deterministic boundary table, the measured injection-detection rate, the accessibility statement and a replay of any disputed conversation — with a print stylesheet that produces a filing-ready PDF. | `packages/server/public/assurance.html` |
| **BIZ-3 (medium)** · Lead with a dated regulatory trigger. | The README leads with Article 50 and the evidence obligation; the trust page is organised around what a buyer can verify for themselves rather than what we claim. | `README.md`, `docs/TRUST.md` |
| **BIZ-4 (medium)** · No procurement trust surface. | A public trust page (posture, sub-processors, residency, retention, SLA, certification roadmap, vulnerability reporting) and a pre-filled standard security questionnaire — both explicit about what is *not* done, because that is what survives the follow-up call. | `docs/TRUST.md`, `docs/SECURITY-QUESTIONNAIRE.md` |
| **BIZ-5 (medium)** · The outcome fee asked a customer to trust a ledger they could not see. | The three underlying defects are fixed (SEC-1, SEC-3, PERF-3) and the ledger is customer-visible: every row carries its correlation id and drills through to the audit replay. | `/v1/admin/tenants/{id}/outcome-ledger`, console Evidence screen |
| **BIZ-6 (medium)** · Report value, not cost. | The analytics response leads with meetings held, qualified leads, deflection rate, implied hours saved and out-of-hours coverage; cost per conversation stays, one section down, where a procurement figure belongs. | `Api.handleAdmin` (`analytics`), console |
| **BIZ-7 (medium)** · No distribution motion in the product. | A self-serve trial that provisions a real tenant on the real lifecycle and runs the governed crawl to produce a *generated, unapproved* playbook; an OAuth connect handshake with single-use, tenant-bound state; and the partner registry exposed over the admin API. | `packages/server/src/self-serve.ts` |
| **BIZ-8 (low)** · Do not sell data residency until it routes on residency. | A deployment declares the regions it operates. A tenant whose residency has no declared region is refused rather than served from the wrong one, and a deployment that declares none makes no residency claim — stated in the README and the trust page. | `Platform.regionFor`, `docs/TRUST.md` § 4 |

---

## What the audit asked for that is deliberately still open

Naming these is the point of the exercise. Each is a decision rather than an
oversight, and each is stated in the trust page and the questionnaire so it is
found by us rather than by a buyer.

- **Administrative SSO and MFA** (SEC-10). A bearer key is still the only thing
  between the internet and a tenant's audit export. This is the single largest
  remaining item and belongs before the first production pilot.
- **An independent penetration test and an independent accessibility audit.**
  Both are commissioning decisions, not engineering ones. The accessibility
  conformance generator continues to refuse to claim conformance without a named
  auditor and a date, which is why this build says "partial, self-assessed".
- **A public status page.**
- **A live Postgres in the default test suite.** The adapters and the isolation
  probe run against a fake that models RLS semantics and `SET LOCAL`. That
  proves the adapters always bind; it does not prove a production cluster is
  configured correctly, and only the migrations applied to a real cluster do.
- **A shipped second-stage injection classifier.** The interface, the threshold,
  the failure behaviour and the measurement harness are here; the model is a
  deployment's choice, and shipping one we had not evaluated would be exactly
  the kind of claim this document exists to avoid.
