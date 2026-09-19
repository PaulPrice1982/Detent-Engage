# Compliance

For DPOs, compliance owners and anyone running a security or privacy review.

The DPO is the persona most competitors ignore and the one most likely to block
a purchase in the UK and EU mid-market. This document exists because "we take
privacy seriously" is not a control and cannot be tested.

---

## 1. Controller and processor

The platform is a **processor** for tenant conversation and CRM data, and a
**controller** for platform-level processing (billing, security telemetry,
aggregate service improvement). That split must be written into the DPA, not
assumed. Four consequences follow.

| Consequence | What is built |
|---|---|
| Subprocessor transparency | The chain must be published and maintained: conversational vendor, model providers, cloud region, vector store, connector substrate, any pass-through unified API. Tenants must be able to object to changes with notice. |
| International transfers | UK IDTA or the UK Addendum for UK tenants; EU SCCs for EU tenants; transfer risk assessments per subprocessor. |
| Tenant obligations | The tenant is the controller and must reference the assistant in its own privacy notice and cookie banner. The platform generates the suggested wording, because most tenants will not do this correctly unaided. |
| Consent for the identifier | The identifier is set in the tenant's context, so the tenant obtains consent through its own CMP. The widget **reads** that signal rather than setting its own. |

That last row is load-bearing. A widget that sets identifiers regardless of the
host page's consent state makes the platform complicit in the tenant's breach.
`packages/widget/src/consent-signal.ts` reads IAB TCF, OneTrust, Cookiebot, a
`dataLayer` flag, or an explicit script attribute — and where none can be read,
**returns no consent**. Never "assume yes".

## 2. The identity-resolution consent gate (PECR Regulation 6)

Matching an unidentified visitor against CRM records using a cookie, device
fingerprint or other visitor identifier is a PECR Regulation 6 event requiring
prior consent to the UK GDPR Article 4(11) standard — independently of whether
any CRM content is disclosed to the visitor. Regulation 6 is technology-neutral,
and ICO guidance aligned with EDPB Guidelines 2/2023 covers cookies, local
storage and fingerprinting alike.

Exposure rose materially: the Data (Use and Access) Act 2025 raised the PECR
fine ceiling from £500,000 to £17.5m or 4% of global turnover, with the new
powers applying to conduct from 5 February 2026 per the ICO's commencement
position.

**How it is enforced.** The first statement of
`IdentityResolutionService.resolve()` reads the stored consent event. No
configuration reaches it, no tenant can override it, and there is no code path
to a CRM search that does not pass through it.

Where consent is refused or absent, the assistant runs stateless and
non-resolving: no device identifier is read or written for matching, no CRM is
queried by identifier, and the visitor is treated as fully anonymous. **It still
answers, qualifies, captures and books.** Refusing consent costs the visitor
nothing, which is both the correct outcome and the reason the gate does not
create commercial pressure to weaken it.

**How it is tested.** `tests/consent-gate.test.ts`. The strongest assertion
available is not that no data was returned, but that no CRM call was made at all
— proven by the absence of a `resolution_started` audit entry.

## 3. The marketing consent gate

A B2B visitor who supplies an email address to request information has not
thereby consented to marketing. In a multi-tenant product the applicable rule
varies by recipient, so the platform holds a jurisdiction rule and applies the
**stricter of** the recipient's and the tenant's position.

| Jurisdiction | Platform default |
|---|---|
| UK | Explicit consent event required. The corporate-subscriber carve-out under PECR Reg 22 is deliberately **not** relied on: a named individual at a corporate domain may be an individual subscriber, and soft opt-in has conditions most tenants will not meet. |
| EU | Explicit consent event required; several member states apply the opt-in rule to corporate subscribers. |
| US | Opt-out honoured immediately; sender identity mandatory. |
| Canada | CASL: express consent. **No implied-consent path is implemented.** |
| AU / NZ | Explicit consent event required. |

**How it is enforced.** `enrol_sequence` cannot execute without a stored
consent event id. Two independent refusals: the policy engine denies without a
`GRANTED` event, and `NotificationService.enrolInSequence` throws without an id
— so a policy regression alone cannot produce an unlawful enrolment. A
fabricated id that does not match the stored event is also refused, because the
stored event is the evidence, not the model's argument.

## 4. EU AI Act Article 50

Article 50 of Regulation (EU) 2024/1689 has applied since 2 August 2026. The
Digital Omnibus (Regulation (EU) 2026/1744, in force 27 July 2026) deferred
Annex III high-risk obligations to 2 December 2027 but **did not defer
Article 50**. Penalties reach €15m or 3% of worldwide annual turnover. UK-
established providers are in scope where the system is placed on the EU market
or its output is used in the EU.

| Requirement | Implementation |
|---|---|
| Disclose AI at the start of every conversation, in text and in voice | Returned at session open, rendered in the panel header, and emitted on the first turn. The launcher itself carries an `AI` badge and a screen-reader hint before anyone types. |
| In the surface, not buried in a privacy policy | It is the second element on screen. |
| Not disableable by a tenant | `TenantStore.update()` rejects an empty or token disclosure. Editable for tone, not removable. |
| Never claim to be human when asked | Prohibited in the system prompt *and* blocked by `validateOutput`, which is the control that holds when the prompt does not. |
| Provider and deployer split documented per tenant | The platform is most likely the provider, the tenant the deployer. Both carry duties. |
| In the visitor's own language | Locale bundles for en-GB, fr, de, es, nl and it, with per-tenant per-locale overrides. A disclosure a visitor cannot read is not a disclosure. |
| Evidenced, not asserted | Coverage is a figure on the compliance scorecard and in the assurance pack, derived from the chain: sessions with a `disclosure_shown` entry over sessions opened, target 100%. |

**How it is tested.** `tests/disclosure-and-output.test.ts`, including that a
tenant cannot reduce the disclosure to "Hi.", and `tests/visitor-surface.test.ts`
for the locale coverage.

## 5. Recording

Recording defaults to **off** per tenant. Where enabled, the stricter-of rule
applies automatically, because in a multi-tenant product the tenant and the
visitor are routinely in different jurisdictions.

- Consent is obtained before capture begins, not before storage. No audio is
  buffered pending a decision.
- The consent event is stored immutably with its timestamp, the exact wording
  shown, and the choice made.
- A refusal is stored and honoured for the session, and the visitor is not asked
  again — `ConsentService.hasAnswered()` is the check the widget uses.
- A non-recorded route is always available and clearly offered.

Every US visitor is treated as all-party consent, because *Kearney v. Salomon
Smith Barney, Inc.*, 39 Cal.4th 95 (2006) applied California law to an
out-of-state recorder.

## 6. Data classification and retention

| Class | Classification | Default retention | Residency |
|---|---|---|---|
| Consent evidence | Special handling, immutable | Limitation period, tenant configurable | UK or EU |
| Lead personal data | Confidential | Tenant configurable; review at 24 months | UK or EU |
| Conversation transcripts | Confidential | Short by default | UK or EU |
| Voice recordings | Sensitive | Shortest practical, redaction on request | UK or EU, enterprise vendor terms required |
| CRM credentials | Restricted | Life of the connection | UK or EU, per-tenant key |
| Operational logs | Internal, PII redacted | Short | UK or EU |
| Audit log | Restricted, tamper-evident | Long, per legal obligation | UK or EU |

`redactObject()` runs before anything reaches a log or the audit chain.
Credentials are dropped outright rather than pattern-redacted; free text is
pattern-redacted for emails, phones, cards, NI numbers, postcodes and IPs. The
NI pattern is deliberately broader than the valid prefix set: over-redaction in
a log is cosmetic, under-redaction is reportable.

## 7. Erasure and data subject rights

Erasure executes across four stores:

1. the operational datastore,
2. the tenant's vector namespace,
3. object storage for voice artefacts,
4. the conversational vendor's own retention.

Where the tenant's CRM provides a dedicated permanent-erasure endpoint distinct
from ordinary archival, that endpoint is used — HubSpot's GDPR-delete is wired;
Salesforce, Dynamics and Zoho are declared `PARTIAL` in their capability
declarations rather than claimed, because their erasure is org-configured.

A visitor can also trigger erasure of their own conversation from inside it:
the "forget me" control records a refusal against the purpose, drops the
transcript, and audits the erasure. Sessions expire in any case at 30 minutes
idle or 24 hours absolute, and the transcript goes with the session — previously
a transcript lived until the process restarted, which is not a retention period,
it is an accident.

Evidence of erasure is retained in the audit log, which is itself exempt from
erasure on legal-obligation grounds and holds no personal data to begin with.

## 8. Residency

UK and EU regions, selected per tenant at provisioning and immutable thereafter
without a migration. Cross-region replication never leaves the selected
jurisdiction.

**What the code actually does, stated plainly.** A deployment declares the
regions it operates (`residencyRegions`). A tenant whose residency has no
declared region is refused at session open rather than quietly served from the
wrong region, and a deployment that declares none makes no residency claim at
all. This was an audit finding (BIZ-8): `residency` was a column in the
migration and a word in the Enterprise tier description, and nothing routed on
it. A residency claim the code does not route on is the kind of gap that
surfaces in a DPA review, in front of the buyer who cares most — so the
commercial materials should claim residency only where a deployment has
configured it.

The dependency to watch: the conversational vendor's residency and zero-retention
mode are enterprise-tier features and must be contracted. On lower tiers audio
may be used to improve models unless opted out, which is unacceptable for a
processor handling tenant personal data. This is a contract question, not an
engineering one, and it gates the voice half of the product.

## 9. Evidence a reviewer can ask for

| Ask | Where it comes from |
|---|---|
| "Show me consent was obtained, and the exact wording" | `GET /v1/admin/tenants/{id}/audit`, `consent_recorded` entries with `wordingShown` |
| "Prove the AI disclosure was shown" | `disclosure_shown` entries, one per session, with the wording |
| "Prove no resolution happened without consent" | `resolution_blocked_no_consent` entries, and the absence of `resolution_started` |
| "Prove this log has not been edited" | The export carries its own chain verification |
| "Reconstruct what happened in this conversation" | `AuditLog.replay(tenantId, correlationId)` with the version pins |
| "Show me the subprocessor chain" | Published register; a contractual deliverable, not a code artefact |

## 10. Open compliance items

Honestly stated rather than quietly omitted.

- **Subprocessor register** is a contractual deliverable and is not in this
  repository.
- **DPIA** must be completed and signed off by the DPO before production.
- **Vendor terms** covering multi-tenant use, concurrency, residency and
  retention must be signed. The voice half of the product is void without them.
- **Accessibility audit** to WCAG 2.2 AA: the widget is built to the standard
  (keyboard reachable, announced state changes, disclosure in both modalities,
  permanent text-only route) but an independent audit has not been run.
- **Article 50(2) machine-readable marking** for synthetic voice output applies
  where the marking duty bites; it is not implemented because voice is not built.
- **Administrative SSO and MFA.** A bearer key is currently the only thing
  between the internet and a tenant's audit export. Raised by the September 2026
  audit (SEC-10), open, and stated in `docs/TRUST.md` and
  `docs/SECURITY-QUESTIONNAIRE.md` rather than left for a buyer to discover.
- **An independent penetration test.** Not yet commissioned.
