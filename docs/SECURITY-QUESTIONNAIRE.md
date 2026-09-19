# Standard security questionnaire, pre-filled

*Detent Agentic Website Assistant. Last reviewed 18 September 2026.*

The September 2026 audit's finding (BIZ-4) was that answering a mid-market
buyer's security questionnaire late costs weeks per deal, and that a pre-filled
pack removes the longest pole in the sales cycle. This is that pack: the
questions that appear in almost every questionnaire we have seen, answered
once, with the file or control that backs each answer named so a reviewer can
check rather than take our word.

**Where an answer is "no" or "not yet", it says so.** A questionnaire that
overstates gets found out in the follow-up call, and the follow-up call is with
the person who can veto the purchase.

---

## A · Company and scope

| # | Question | Answer |
|---|---|---|
| A1 | What does the product do? | A governed conversational assistant on a company's own website: it answers from that company's approved content, qualifies, books meetings and writes to their CRM under deterministic policy. |
| A2 | Is it multi-tenant? | Yes. Isolation is enforced at the authorisation layer and again at the database under row-level security. |
| A3 | Where is it hosted? | In the region matching each tenant's declared residency (UK or EU). A deployment that has not declared a region for a residency refuses that tenant rather than serving them elsewhere. |
| A4 | Is any of it subcontracted? | See the sub-processor table in [`TRUST.md`](TRUST.md) § 3. |

## B · Authentication and access control

| # | Question | Answer | Where |
|---|---|---|---|
| B1 | How are API credentials stored? | SHA-256 digests, compared in constant time. The key itself is shown once at issue and is not recoverable. | `packages/server/src/auth.ts` |
| B2 | Do keys expire and rotate? | Yes. Optional expiry, last-used timestamp, and rotation with an overlap window so a site redeploy is not an outage. | `ApiKeyService.rotate` |
| B3 | Is a public key in page source a risk? | It is bound to the tenant's registered web origins and refused from anywhere else, enforced at authentication rather than only at CORS — a script or bot farm does not run a browser's CORS check. | `assertOriginAllowed` |
| B4 | How is cross-tenant access prevented? | The tenant id is derived from the key, never accepted from the caller. A platform admin is the only principal that may address another tenant, and that access is audited. | `ApiKeyService.assertTenantAccess` |
| B5 | Is there role separation? | Three audiences: `widget`, `tenant_admin`, `platform_admin`. Configuration fields carry a per-field authority: a tenant admin cannot raise their own spend cap, widen the outbound allowlist, change the kill switch or alter retention. | `packages/core/src/config-authority.ts` |
| B6 | Is administrative SSO/MFA available? | **Not yet.** Administrative access is a bearer key today. SSO with enforced MFA is on the roadmap and should be raised in any procurement conversation rather than discovered in one. | — |
| B7 | Is there break-glass access, and is it logged? | Yes, and it is an audited event type in its own right. | `audit` event `break_glass_access` |

## C · Data protection

| # | Question | Answer | Where |
|---|---|---|---|
| C1 | Is data encrypted in transit? | TLS, with HSTS (including subdomains, preload) where the deployment enables it. | `securityHeaders` |
| C2 | Is data encrypted at rest? | Storage-level encryption from the hosting provider, plus application-level envelope encryption for CRM credentials under a per-tenant data key and a KMS root key. | `packages/core/src/keyring.ts` |
| C3 | Who can read a tenant's CRM credential? | Nobody, in plaintext, outside the adapter call that uses it. It is decrypted just in time, never logged, and redacted from every audit payload and log line by the same redaction layer. | `EncryptedConnectionStore` |
| C4 | Is personal data in the audit log? | No. Payloads are redacted before they are written, which is also why the audit log is exempt from erasure. | `AuditLog.appendSerialised` |
| C5 | How is erasure handled? | Across four stores (database, vector namespace, object storage, vendor retention), with the audit entry recording that it happened. A visitor can trigger it from inside the conversation. | `POST /v1/sessions/{id}/forget` |
| C6 | What are the retention periods? | Transcripts 90 days, voice 30 days (off by default), lead data 730 days, audit 7 years. Sessions expire at 30 minutes idle / 24 hours absolute. | [`TRUST.md`](TRUST.md) § 5 |
| C7 | Is tenant data used to train models? | No. | — |
| C8 | Is data ever shared between tenants? | No, and the knowledge corpus, the audit chain, the consent store and the usage counters are all keyed per tenant with the binding applied at query construction. | `tests/cross-tenant-isolation.test.ts` |

## D · Application security

| # | Question | Answer | Where |
|---|---|---|---|
| D1 | How do you prevent prompt injection? | Instruction/data separation with a per-turn unguessable delimiter, normalisation-resistant multilingual detection, an optional classifier stage, and output validation before emission. The measured detection rate against a held-out corpus ships in every assurance pack. | `packages/knowledge/src/injection.ts` |
| D2 | Can the assistant invent a price? | Not without being caught: output validation refuses any figure that is neither in the retrieved material nor in the tenant's approved figure set. | `packages/agent/src/output-validation.ts` |
| D3 | Can it exfiltrate data through a link or image? | Links and images are restricted to the tenant's outbound allowlist, and markdown image beacons are closed. The allowlist is operator-controlled, not tenant-editable. | `output-validation.ts`, `config-authority.ts` |
| D4 | Is there rate limiting? | Per key, per IP and per session, plus a hard message ceiling per conversation and an input length cap before tokenisation. | `packages/server/src/rate-limit.ts` |
| D5 | How is spend bounded? | A per-tenant monthly cap in money, checked before the model is called and again per tool call, degrading to a booking link rather than failing. | `packages/policy/src/metering.ts` |
| D6 | What security headers are set? | CSP (no `'unsafe-inline'`), HSTS, `Permissions-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, and cross-origin resource/opener policies. The conversation panel's `frame-ancestors` is the tenant's registered origins. | `securityHeaders` |
| D7 | Is dependency risk managed? | The runtime dependency surface is one package (the model provider SDK). The product also runs with an empty `node_modules` on Node alone, which is both a supply-chain property and a testable one. | `pnpm test:fallback` |
| D8 | Has it been penetration tested? | **Not yet.** Planned before the first production pilot. | — |
| D9 | Is there a secure development lifecycle? | Strict TypeScript, one test file per CI gate, an isolation probe, an adversarial injection corpus with published pass rates, and an independent code audit whose findings are tracked in [`AUDIT-RESPONSE.md`](AUDIT-RESPONSE.md). | — |

## E · Operations

| # | Question | Answer | Where |
|---|---|---|---|
| E1 | Is there logging and monitoring? | Structured JSON logs with a correlation id on every request and on every failure path, plus Prometheus metrics behind the platform-admin audience. | `packages/core/src/logging.ts`, `/v1/metrics` |
| E2 | Can an incident be reconstructed? | Yes: the correlation id in a response is the correlation id in the log and in the audit chain, and any conversation replays with its pinned versions. | `/v1/admin/tenants/{id}/replay` |
| E3 | Is there a kill switch? | Two, independent: platform-wide and per tenant, each degrading to text-only and then to a static booking link, effective without a redeploy. | `docs/OPERATIONS.md` |
| E4 | What happens if the CRM is down? | Writes are parked with an idempotency receipt and reconciled; a commitment already made to a person is not retracted. | `packages/connectors/src/receipts.ts` |
| E5 | Is there a backup and restore process? | The deployment's own, against the Postgres cluster. The append-only audit chain makes restore verification meaningful: a restored chain either verifies or does not. | `db/README.md` |
| E6 | Is there a public status page? | **Not yet.** | — |
| E7 | What is the availability commitment? | 99.5% (Starter/Growth), 99.9% (Command/Enterprise). | [`TRUST.md`](TRUST.md) § 6 |

## F · Compliance

| # | Question | Answer | Where |
|---|---|---|---|
| F1 | Is the AI status disclosed to end users? | Always, in the surface, on the first screen, and not disableable by a tenant. Coverage is reported as a percentage on the compliance scorecard, with 100% as the target. | `docs/COMPLIANCE.md` |
| F2 | How is consent handled for identity matching? | Consent is recorded before resolution, with the exact wording shown stored verbatim, in the visitor's own language. Absence of an affirmative event is refusal. | `packages/policy/src/consent-service.ts` |
| F3 | Is a DPA available? | Yes, and a signed DPA record is a hard gate: no CRM connection exists without one. | `TenantStore.recordDpa` |
| F4 | Is a DPIA available? | A template is available on request. | — |
| F5 | Which regulations were designed for? | UK GDPR, PECR, the Data (Use and Access) Act 2025, EU GDPR and the EU AI Act — with Article 50 transparency treated as a product feature rather than a compliance overhead. | `docs/COMPLIANCE.md` |
| F6 | Are you SOC 2 or ISO 27001 certified? | **No.** See the roadmap in [`TRUST.md`](TRUST.md) § 7. |
| F7 | Is the product accessible? | Built to WCAG 2.2 AA — keyboard operable throughout, no focus trap, announced state changes, a full-screen mobile sheet — but **not independently audited**, and the conformance statement refuses to claim conformance without a named auditor and a date. | `packages/widget/public/panel.html` |
