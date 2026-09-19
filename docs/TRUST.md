# Trust and security

*Detent Agentic Website Assistant. Last reviewed 18 September 2026.*

This document exists because of a specific finding in the September 2026
independent audit: mid-market UK buyers gate on a security posture statement, a
sub-processor list, a DPA, a DPIA, a pen-test summary, a status page, an SLA and
a certification roadmap — and answering that list late costs weeks per deal. It
is public on purpose, and it is written to be read by a buyer's security
reviewer rather than by us.

Where something is not done, it says so. A trust page that overstates is worse
than no trust page, because the overstatement surfaces in a DPA review in front
of the person who cares most.

---

## 1 · What the product does with data

| Question | Answer |
|---|---|
| What personal data does it process? | Whatever a website visitor types, plus a per-session pseudonymous reference. Where consent is recorded, an email address or company domain is matched against the tenant's own CRM. |
| Does it profile visitors across sites? | No. The conversation panel is served from the platform origin inside a sandboxed iframe, so under partitioned storage it gets a per-top-site jar. There is no cross-site identity to carry and building one would be the wrong privacy outcome as well as technically unavailable. |
| Does the model see CRM records? | No. Identity resolution returns a classification and a permitted behaviour — never a record, a name, a company, a deal or a stage. The model cannot leak what it never receives. |
| Is the assistant's AI status disclosed? | Always, in the surface, on the first screen of every conversation, and on the launcher before anyone clicks. A tenant may edit the wording for tone; it cannot be removed or reduced below a meaningful statement. |
| Can a visitor withdraw? | Yes, from inside the conversation. A refusal is recorded against the purpose, the transcript is dropped, and the erasure is itself audited. |
| Is training done on tenant data? | No. Tenant conversations are not used to train any model. |

## 2 · Security controls

**Tenant isolation.** The tenant id is derived from the API key, never accepted
from the caller, so a request naming another tenant cannot be authorised at all.
Under the Postgres adapters, every query runs inside a transaction that binds
`SET LOCAL app.tenant_id`, under a role with `NOBYPASSRLS` and a `FORCE`d
row-level security policy: a query that forgets the binding returns zero rows
rather than another tenant's. The isolation probe suite asserts that no adapter
can issue an unbound query.

**Credentials at rest.** CRM credentials are sealed with a per-tenant data key
under a key-management root key (AWS KMS, GCP KMS or Azure Key Vault in a
deployment; a local provider in development, so the encrypted path is the one
everybody exercises). The tenant id is authenticated as additional data, so a
ciphertext moved between rows does not decrypt. Rotation rewraps data keys
without the plaintext leaving the process.

**API keys.** Stored as SHA-256 digests and compared in constant time. Keys
carry a short random public prefix rather than the tenant id, expire, record
when they were last used, and rotate with an overlap window so a tenant can
redeploy their site before the predecessor stops working. A widget key is bound
to the tenant's registered web origins and is refused from anywhere else — which
is what makes a key embedded in page source safe to embed.

**Abuse control.** Per-key, per-IP and per-session rate limits on the visitor
API; a hard ceiling on messages per conversation; an input length cap applied
before the tokeniser; and the tenant's spend cap checked *before* the model is
called rather than reconciled afterwards.

**Prompt injection.** Retrieved content never enters the system prompt. It
arrives inside a per-turn, unguessable delimiter carrying an explicit statement
that it is data. Detection runs over normalised text — zero-width characters,
homoglyphs, leetspeak, spaced-out letters, HTML entities and percent-encoding
are all folded first — with multilingual patterns and an optional second-stage
classifier. The measured rate against a held-out adversarial corpus is published
in every assurance pack rather than asserted here.

**Output validation.** Every answer is validated before emission, including each
sentence of a streamed answer: unapproved prices and figures, human claims,
urgency that was not given as fact, CRM disclosure, and links or images pointing
anywhere but the tenant's own allowlist. The allowlist is operator-controlled,
because it is the exfiltration control.

**Audit.** Append-only and hash-chained per tenant, covering every consent
event, tool call, policy decision, disclosure decision and break-glass access.
Verification is checkpointed and signed under a key the application holds and
the database does not. Any conversation is replayable with the prompt, policy,
model and configuration versions that produced it.

**Transport and browser.** HSTS, a strict Content-Security-Policy on every
served page (no `'unsafe-inline'` anywhere), `frame-ancestors` on the
conversation panel restricted to the tenant's registered origins, a restrictive
`Permissions-Policy`, and HTTP header, request and keep-alive timeouts.

## 3 · Sub-processors

A deployment's actual list belongs in its own DPA; this is the set the platform
is built to use.

| Sub-processor | Purpose | Data | Region |
|---|---|---|---|
| Model provider (Anthropic by default) | Language understanding and generation | Visitor message text, tenant-approved reference material. No CRM records, no credentials. | Per the deployment's contract |
| Cloud hosting | Compute, database, object storage | All processed data | UK or EU, per the tenant's residency |
| Key management (AWS KMS / GCP KMS / Azure Key Vault) | Root keys for credential encryption | Wrapped data keys only. Never plaintext credentials. | Same region as hosting |
| Email sending | Follow-up lane, where the tenant enables it | Recipient address and message body | UK or EU |
| Reverse-IP company resolution, where enabled | Company-level engagement | IP address, resolved company | Per vendor |
| Enrichment vendor, where enabled | Firmographic enrichment | Company domain | Per vendor |

The last two are off by default and are per-tenant opt-in with their own spend
cap, because they are the two that introduce a per-record cost and a third-party
disclosure.

## 4 · Data residency

`residency` is `UK` or `EU` per tenant. A deployment declares which regions it
operates; a tenant whose residency has no declared region is **refused rather
than quietly served from the wrong region**. A deployment that declares no
regions makes no residency claim, and its commercial materials should not make
one either. This is stated plainly because a residency claim that the code does
not route on is precisely the gap that surfaces in a DPA review.

## 5 · Retention

| Data | Default | Configurable |
|---|---|---|
| Conversation transcripts | 90 days | Yes, per tenant |
| Voice recordings | 30 days, and off by default | Yes |
| Lead personal data | 730 days | Yes |
| Audit entries | 2,555 days (7 years) | No |

Audit entries are exempt from erasure on legal-obligation grounds — the evidence
that an erasure happened cannot itself be erased — and hold no personal data,
because payloads are redacted before they are written. Sessions expire after 30
minutes idle or 24 hours absolute, whichever comes first, and the transcript is
dropped with the session.

## 6 · Availability and support

| Commitment | Starter | Growth | Command | Enterprise |
|---|---|---|---|---|
| Target monthly availability | 99.5% | 99.5% | 99.9% | 99.9% |
| Support response, P1 | 1 business day | 4 business hours | 2 business hours | 1 business hour |
| Incident notification | Status page | Status page + email | Email to named contacts | Email + phone |
| Security incident notification | Without undue delay, and within 24 hours of confirmation | | | |

Degradation is explicit rather than silent: a platform-wide kill switch drops to
text-only and then to a static booking link, a tenant-level switch does the same,
and a CRM outage parks writes for reconciliation rather than losing them. A
commitment already made to a person — a confirmed booking, a raised handoff — is
never retracted to preserve system consistency.

## 7 · Certification and assurance roadmap

Stated as a roadmap because none of it is done, and claiming otherwise would be
the exact failure mode this page exists to avoid.

| Item | Status |
|---|---|
| Independent penetration test | Not yet commissioned. Planned before the first production pilot. |
| SOC 2 Type I | Not started. Target: within 12 months of first revenue. |
| ISO/IEC 27001 | Not started. Target: after SOC 2 Type II. |
| Independent accessibility audit (WCAG 2.2 AA) | Not commissioned. The product is built to the standard and the conformance statement generator refuses to claim conformance without a named auditor and a date. |
| DPIA template | Available on request. |
| DPA | Available on request, and a signed DPA record is a hard gate before a CRM can be connected at all. |
| Public status page | Not yet published. |

## 8 · What a buyer can verify for themselves

Not a claim, an instruction. Every one of these produces evidence derived from
the tenant's own audit chain, and the chain verification travels with it.

```bash
# The compliance scorecard for any date range, in one action.
curl -H "authorization: Bearer $ADMIN_KEY" \
  "$API/v1/admin/tenants/$TENANT/compliance?from=2026-09-01T00:00:00.000Z&to=2026-09-30T23:59:59.999Z"

# The behavioural assurance pack, including the measured injection-detection rate.
curl -H "authorization: Bearer $ADMIN_KEY" "$API/v1/admin/tenants/$TENANT/assurance"

# Any single conversation, replayed with the versions that produced it.
curl -H "authorization: Bearer $ADMIN_KEY" \
  "$API/v1/admin/tenants/$TENANT/replay?correlation_id=$CORRELATION_ID"

# The audit chain itself, paginated, with its verification result.
curl -H "authorization: Bearer $ADMIN_KEY" "$API/v1/admin/tenants/$TENANT/audit?limit=100"
```

Or open `/assurance.html`, build the pack for a period, and print it to PDF.

## 9 · Reporting a vulnerability

Report to **security@detentgtm.io**. We will acknowledge within one business day
and keep the reporter informed until resolution. We will not pursue legal action
against good-faith research that respects tenant data, avoids privacy violations
and service degradation, and gives us reasonable time to remediate before
disclosure.
