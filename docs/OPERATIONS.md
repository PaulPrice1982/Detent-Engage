# Operations

For on-call. The governing invariant, from which everything else follows:

> **Never retract a commitment already made to a person in order to preserve
> system consistency.** Repair asynchronously, alert loudly, and keep the human
> promise.

---

## Kill switches

Two, independent, both effective without a redeploy. The **stricter of the two
wins** — a platform incident cannot be overridden by a tenant.

| Mode | Effect |
|---|---|
| `OFF` | Normal operation |
| `TEXT_ONLY` | Voice and recording disabled; text unaffected |
| `BOOKING_LINK_ONLY` | No model call at all; visitors get an honest message and a booking link |

```bash
# Platform-wide (platform admin key only)
curl -XPOST $API/v1/admin/kill-switch \
  -H "authorization: Bearer $PLATFORM_KEY" \
  -d '{"mode":"BOOKING_LINK_ONLY"}'

# Per tenant
curl -XPATCH $API/v1/admin/tenants/$TENANT \
  -H "authorization: Bearer $ADMIN_KEY" \
  -d '{"killSwitch":"TEXT_ONLY"}'
```

**Trip the platform switch immediately on any cross-tenant isolation alarm.**
That is a P1 security incident, and in a governance-positioned product it is
existential. Degrade the service rather than risk it.

## Alerting

| Domain | Alert on |
|---|---|
| Conversation quality | Resolution rate below the tenant baseline |
| Latency | p95 breach of time-to-first-token, voice round trip, barge-in |
| Audio | Switch-to-text rate spike, indicating an audio regression |
| CRM integration | **Any duplicate created. Any owner overwrite attempt.** |
| Consent | Any gate bypass attempt. Any session without a disclosure. |
| Security | Any successful injection. Any isolation probe failure. |
| Cost | Spend anomaly. Approach to any tenant cap. |
| Platform | Error-budget burn exceeding plan; DLQ depth |

The two zero-tolerance rows are CRM integration and security. Everything else is
a threshold; those two are counts.

### What emits behind the table

The September 2026 audit's SEC-10 finding was that this table had nothing behind
it: no structured logs, no metrics, and no log line at all on the 500 path. What
emits now:

| Signal | Where |
|---|---|
| Structured JSON logs, one object per line, redacted by the same layer as audit payloads | `packages/core/src/logging.ts` |
| A correlation id on every request, returned in the response body and written to the log line | `Api.handle` |
| Request duration histogram by method, route and status | `awa_http_request_duration_ms` |
| Live session gauge, published by the maintenance sweep | `awa_sessions_live` |
| Prometheus text exposition, behind the platform-admin audience | `GET /v1/metrics` |

Two deliberate omissions, so they are found here rather than during an incident:
`/health` is liveness only — it used to disclose the platform kill-switch state
to anyone who asked, which told an attacker exactly when to push — and there is
no OpenTelemetry exporter. The registry is small and dependency-free; a
deployment that wants tracing wires an exporter to it.

### Reading an incident backwards

1. The visitor has a correlation id (it is in the error they saw, and in a
   screenshot).
2. `grep` the logs for it: every line of that request carries it.
3. `GET /v1/admin/tenants/{id}/replay?correlation_id=…` reconstructs what the
   platform did, with the prompt, policy, model and config versions pinned at
   the time.
4. `GET /v1/admin/tenants/{id}/audit` confirms the chain still verifies. If it
   does not, stop and treat it as a P1: a scorecard derived from a chain that
   does not verify is not evidence.

## Runbooks

### CRM credential revoked (`invalid_grant`)

Symptom: `connection_degraded` audit entries, writes accumulating in the
reconciliation queue.

The system has already done the right thing: **fail closed on the credential,
fail open on the conversation.** The assistant keeps talking and keeps
capturing; it simply cannot write.

1. Confirm: `GET /v1/admin/tenants/{id}/reconcile` shows the parked writes.
2. Notify the tenant admin to re-consent via OAuth.
3. On reconnect, `adapter.markConnected()` then drain. Draining is idempotent —
   each write re-claims its receipt, and one already confirmed is a no-op.
4. Verify: `[...records].filter(matching)` should show exactly one record per
   person. Duplicates here are a defect, not an expected outcome.

### Booking confirmed, CRM write failed

Already handled and already correct. The visitor was told the meeting is
confirmed, because it is.

1. `crm_write_parked` in the audit log, with the booking id.
2. Retries run with backoff. Alert if unresolved at 15 minutes.
3. **Never cancel the booking to make the CRM consistent.** Raise an owner task
   and repair the CRM.

### Spend cap approached or reached

1. At `warnAtFraction`: tenant warned.
2. At `degradeToTextAtFraction`: voice disabled, text continues.
3. At the cap: `BOOKING_LINK_ONLY`. The visitor is told plainly and offered a
   booking link.

If this is a bot flood rather than genuine demand: confirm the spend anomaly,
check bot protection is challenging before any voice session opens, and raise
the cap only after the source is understood. Raising a cap under an active flood
converts a contained incident into an uncontained one.

### Suspected cross-tenant leak

1. **Trip the platform kill switch first.** Investigate second.
2. Run the isolation probe suite against the release in production.
3. Check the three enforcement points: RLS policy present and `FORCE`d; the app
   role has no `BYPASSRLS`; `SET LOCAL` (not `SET`) is used for the tenant
   binding. A `SET` that survives a transaction back into a pooled connection is
   the most dangerous mistake available in this design.
4. Export and verify the audit chains for both tenants.
5. Treat as a reportable incident until proven otherwise.

### Audit chain verification fails

The log is append-only via both a trigger and a withheld grant, so a failure
means one of: a migration dropped the trigger, a superuser wrote directly, or
storage corruption.

1. `GET /v1/admin/tenants/{id}/audit` reports `brokenAtSequence` and a reason.
2. **Do not repair the chain.** A repaired chain is not evidence.
3. Preserve, record the break, and start a new chain segment with the incident
   recorded as its first entry.

### Duplicate record created

Zero-tolerance. This is the outcome the whole write path exists to prevent.

1. Find the write receipts for the person: two `CONFIRMED` receipts with
   different `externalId`s means idempotency failed.
2. Common causes: the connector's native upsert key was not provisioned on the
   tenant's org (Salesforce `Detent_Key__c`, Dynamics `detent_key`, Pipedrive's
   custom field); or a search-then-write raced outside its mutex.
3. **The assistant never merges.** Raise an owner task; the tenant merges.
4. Fix the cause, add the case to the synthetic dataset, and re-run the
   precision gate.

## CI gates

No release without all of these green:

| Gate | Threshold | Test file |
|---|---|---|
| Cross-tenant isolation | Zero. No tolerance | `cross-tenant-isolation.test.ts` |
| Consent gate integrity | Zero resolutions or enrolments without an event | `consent-gate.test.ts` |
| AI disclosure | 100% of sessions, both modalities | `disclosure-and-output.test.ts` |
| Prompt injection and tool abuse | Zero successful attacks | `prompt-injection.test.ts` |
| PII leakage | Zero personal data in logs or output | `pii-and-grounding.test.ts` |
| Groundedness | Zero invented facts, prices or commitments | `pii-and-grounding.test.ts` |
| Deduplication precision | Above 95%, recall reported alongside | `identity-resolution.test.ts` |
| Per-CRM contract | Zero duplicates, zero owner overwrites | `crm-integrity.test.ts`, `connector-contract.test.ts` |
| Webhook replay and ordering | 100% idempotent | `webhooks-and-lifecycle.test.ts` |
| Calendar race | Zero double bookings | `booking-and-escalation.test.ts` |
| Spend cap | Cap holds under flood simulation | `metering-and-kill-switch.test.ts` |
| Audit chain | Tamper detected, including after a checkpoint | `audit-chain.test.ts`, `audit-performance-findings.test.ts` |
| Tenant isolation at the database | Zero unbound queries; an unbound read returns nothing | `db-isolation-probe.test.ts` |
| Credentials at rest | No plaintext credential in any store; ciphertext bound to its tenant | `credential-encryption.test.ts` |
| Injection detection | 100% of the held-out hostile corpus, 0% of the benign corpus | `injection-defence.test.ts` |
| Configuration authority | A tenant admin cannot widen an operator control | `audit-security-findings.test.ts` |
| Visitor surface | Escapable, translatable, resumable; no inline script or style | `visitor-surface.test.ts` |
| Streaming | Every sentence validated before it leaves | `streaming-and-provider.test.ts` |
| Self-serve | A trial skips no lifecycle gate; OAuth state is single-use | `self-serve.test.ts` |

Precision without recall hides a matcher that has simply stopped matching, which
is why the dedup gate reports both and asserts both.

## Release

- Canary to a small traffic slice, then progressive rollout.
- **Automatic rollback** on error-budget burn, any isolation failure, any
  disclosure failure, or any duplicate created.
- Prompt, policy and model versions are pinned per tenant and recorded on every
  conversation, so a rollback restores a known-good configuration and a past
  conversation remains explainable.
- Per-tenant configuration is data, not code: changes take effect within 60
  seconds without a redeploy.

## Game day

Rehearse quarterly:

1. Trip both kill switches; confirm degradation to text, then to a booking link.
2. Revoke a tenant CRM credential mid-conversation; confirm capture-only mode
   and an idempotent drain on reconnect.
3. Flood a tenant; confirm the spend cap holds.
4. Fail a CRM write during a booking; confirm the booking is not retracted.
5. Run the isolation probe suite against production.
6. Restore from backup; confirm RPO 5 minutes and RTO 4 hours.
