<img src="brand/detent-logo.jpg" alt="Detent" width="320">

# Agentic Website Assistant

A multi-tenant, multi-CRM agentic website assistant. Any company installs it on
any website with a snippet. It engages visitors, answers from that tenant's
approved knowledge, qualifies conversationally, books meetings with the right
owner, and synchronises with whichever CRM that tenant uses.

**Every consequential behaviour is governed by deterministic policy rather than
delegated to a language model.** That sentence is the product. Chat quality is
a commodity that Salesforce, HubSpot and Intercom already ship; the governed
commercial layer is the part they have not built and the part a UK or EU
mid-market buyer's DPO will actually interrogate.

> **Your website chat has to tell people it is AI, and you have to be able to
> evidence that it did.** EU AI Act Article 50 transparency obligations apply to
> systems interacting with natural persons, and "we configured it that way" is
> not evidence. This product shows the disclosure in the surface on the first
> screen of every conversation, records that it did in a hash-chained audit log,
> and exports the coverage figure as a document a DPO can file. The disclosure
> cannot be switched off by a tenant, and that is a feature rather than a
> constraint. See [`docs/TRUST.md`](docs/TRUST.md).

Implements three specifications:

| Version | Scope | Docs |
|---|---|---|
| **v1.0** sections 1 to 36 | The governed multi-CRM assistant | [`ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`COMPLIANCE.md`](docs/COMPLIANCE.md) |
| **v1.1** sections 37 to 50 | Competitive parity extension | [`PARITY-EXTENSION.md`](docs/PARITY-EXTENSION.md) |
| **v1.2** sections 51 to 62 | Unoccupied ground | [`UNOCCUPIED-GROUND.md`](docs/UNOCCUPIED-GROUND.md) |

See [`docs/SPEC-TRACEABILITY.md`](docs/SPEC-TRACEABILITY.md) for the
requirement-by-requirement map across all three, including what is deliberately
not built.

---

## What is here

```
packages/
  # v1.0: the governed core
  core         canonical model, tool-schema validator, PII redaction, tenant config,
               outcome taxonomy, approval state, verification ladder, media marking
  audit        hash-chained, tamper-evident, replayable audit log
  policy       consent service, policy engine, tool matrix, price authority, metering
  connectors   connector framework + HubSpot, Salesforce, Dynamics, Zoho, Pipedrive
  identity     normalisation, deterministic scoring waterfall, classification
  knowledge    governed ingestion, tenant-bound retrieval, grounding, injection defence
  agent        tool catalogue, turn orchestrator, output validation, playbook engine
  server       composition root, HTTP gateway, admin API, webhooks, API keys
  widget       Shadow DOM launcher, sandboxed panel, host consent-signal reader

  # v1.1: competitive parity
  onboarding   governed crawl, typed extraction, four generators, staging ledger
  studio       business-language authoring compiler, versioning, simulation panel
  outcomes     nine-outcome taxonomy, trial provisioning, confirmation callbacks
  analytics    qualification funnel and the two scorecards nobody else ships
  followup     three sending lanes and the jurisdiction rules engine
  signals      company-level proactive engagement, enrichment, account matching

  # v1.2: unoccupied ground
  context      the nine non-CRM system categories, unified CustomerContext
  entitlement  verification ladder, entitlement answers, excess-use tasks
  modes        seven conversational modes and the mode gate
  groups       group/entity hierarchy, group suppression, partner registry
  machine      buyer-side agent surface with its own quota
  assurance    Behavioural Assurance Pack, replay, sector presets

brand/         Detent palette and mark
db/            PostgreSQL schema with database-enforced row-level security
tests/         one file per CI gate across all three specifications
examples/      two runnable end-to-end demonstrations
```

## Running it

```bash
pnpm install
pnpm typecheck   # strict TypeScript across every package
pnpm test:vitest # 1,224 tests, one file per CI gate
pnpm demo          # three visitor scenarios, end to end, with the audit trail
pnpm demo:customer # the v1.2 flagship: declining to sell to an unhappy customer
pnpm serve         # HTTP gateway on :8787 with a provisioned demo tenant
```

No database, no API keys and no network access are needed for any of those. Every
store is behind an interface with an in-memory implementation; production swaps
the implementations passed to `new Platform(...)` and nothing else changes.

**It also runs with no dependencies at all.** `pnpm test:fallback` and
`pnpm serve:node` execute the whole product from source on Node 22 alone, with
an empty `node_modules`. That exists because a locked-down registry blocking one
package must not make the suite unrunnable: a platform whose argument is that its
controls are demonstrable cannot have controls that fail to run. `vitest` is an
optional dependency for the same reason, and `tools/mini-test.ts` implements the
Vitest subset the suite uses so the tests run unchanged either way.

## The five controls that matter

Everything else in this codebase is in service of these.

**1. The consent gate precedes identity resolution, in code.**
`IdentityResolutionService.resolve()` reads the stored consent event as its
first statement. There is no configuration, no tenant override and no fast path
that reaches a CRM search before it. Absence of an affirmative event is refusal,
not a default. Matching a visitor against CRM records using a device identifier
is a PECR Regulation 6 event, and the Data (Use and Access) Act 2025 raised the
ceiling for getting it wrong from £500,000 to £17.5m or 4% of turnover.

**2. The model never receives CRM record contents.**
Resolution returns a classification and a permitted behaviour. No record id, no
name, no company, no deal, no stage, no activity history. The model cannot leak
what it never receives. This is structural, not prompt-based, and it should not
be relaxed for convenience.

**3. Ownership, lifecycle stage, pipeline and stage are read-only. Always.**
Enforced in three independent places: no tool schema exposes them,
`assertNoForbiddenFields` rejects any envelope carrying one, and every connector
constructs its write payload without them. Overwriting a CRM owner is the single
thing a RevOps buyer will not forgive.

**4. Marketing enrolment is structurally impossible without evidenced consent.**
`enrol_sequence` cannot execute without a stored consent event id, and a
fabricated id that does not match the stored event is refused. No prompt change,
jailbreak or misconfiguration produces an unlawful enrolment.

**5. A commitment made to a person is never retracted to preserve consistency.**
If the calendar confirms a booking and the CRM write fails, the visitor is told
the meeting is confirmed, because it is. The CRM is repaired asynchronously and
alerted on.

**6. Selling is switched off when the customer is unhappy.** (v1.2) The CRM says
"customer, owned by Priya, stage Renewal" whether they are delighted or three
days into a severity-one outage. Reading the support system changes the mode to
`SERVICE_ONLY`, and the policy gate then refuses every selling tool. The model is
never told there is a ticket, so it cannot mention that either. Run
`pnpm demo:customer` to see the same CRM record produce three different
behaviours.

## Architecture in one paragraph

A **governed control plane** holds all consequential authority and all
credentials. A **bought conversational plane** handles language, speech and
turn-taking. The two are separated by a typed tool interface, and the language
model never holds a CRM credential or writes to a CRM directly. Every turn runs
the same ten steps, ingest, retrieve, reason, validate, policy, authorise,
execute, audit, validate output, emit, with no fast path that skips validation.
See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Evidence, not assertions

The audit log is append-only and hash-chained per tenant, covering every consent
event, tool call, policy decision and disclosure decision. It is replayable: any
past conversation can be reconstructed with the prompt, model, policy and config
versions that produced it, and the tenant can export it with its own chain
verification attached. That replayability is what makes the governance claim
checkable by a buyer rather than merely asserted at them.

```bash
curl -H "authorization: Bearer $ADMIN_KEY" \
  localhost:8787/v1/admin/tenants/t_demo/audit
```

## Further reading

| Document | For |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Engineers: layers, trust boundaries, the turn pipeline |
| [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) | DPOs and compliance owners: PECR, Article 50, retention, residency |
| [`docs/CONNECTORS.md`](docs/CONNECTORS.md) | Integrations engineers: the contract, and adding a CRM in two weeks |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | On-call: kill switches, degradation, reconciliation, runbooks |
| [`docs/SPEC-TRACEABILITY.md`](docs/SPEC-TRACEABILITY.md) | Anyone checking this against the specification |
| [`docs/TRUST.md`](docs/TRUST.md) | Buyers and procurement: security posture, sub-processors, SLA, roadmap |
| [`docs/SECURITY-QUESTIONNAIRE.md`](docs/SECURITY-QUESTIONNAIRE.md) | The standard questionnaire, pre-filled |
| [`docs/AUDIT-RESPONSE.md`](docs/AUDIT-RESPONSE.md) | The September 2026 audit, finding by finding |
| [`db/README.md`](db/README.md) | Why row-level security rather than application filtering |

## The September 2026 independent audit

An independent code audit reviewed this repository for user experience,
security, performance and the commercial offering. Every recommendation in it
has been accepted and implemented; the finding-by-finding response, with the
file that closes each one, is in
[`docs/AUDIT-RESPONSE.md`](docs/AUDIT-RESPONSE.md).

The four things it changed most:

- **Persistence is real.** `@detent/awa-db` implements every store interface
  against Postgres, binding `SET LOCAL app.tenant_id` inside each transaction, and
  the isolation probe suite asserts that no adapter can issue an unbound query.
  The composition root now reports whether a deployment is durable, and says so
  at boot when it is not, because evidence that evaporates on restart is not
  evidence.
- **There is an approval console.** Connect → Generate and approve → Dry run →
  Go live → Evidence, at `/console.html`. The best thing in this product used to
  be reachable only by curl.
- **The visitor surface is usable.** The panel can be closed from the keyboard,
  streams its answers sentence by sentence with each one validated before it is
  sent, survives a page navigation, works on a phone, and ships in six locales.
- **A real model provider.** `AnthropicModelProvider` sits behind the same
  `ModelProvider` port as the scripted one the governance suite runs against.

## What this build does not do

Stated explicitly, because an unstated exclusion becomes an assumed inclusion at
the first stakeholder review.

- **Voice.** The specification sequences text before voice, and the voice half
  is contingent on multi-tenant vendor terms that are unconfirmed. The
  modality flag, the switch-to-text rule and the recording consent gate are all
  modelled; the WebRTC audio path is not built.
- **Voice provider wiring.** As above: the port exists, the audio path does not.
- **Tier 2 and Tier 3 CRM connectors.** Five Tier 1 connectors are built
  against the real vendor API shapes. The framework is what makes the sixth cheap.
- **Marketplace listings and the design partner programme** (v1.1 §46 to 47),
  process, not engineering. The self-serve trial and the OAuth connect handshake
  a marketplace listing needs are built.
- **Data residency routing beyond a single region.** `residencyRegions` is
  honoured where a deployment declares it, and a tenant whose residency has no
  declared region is refused rather than quietly served from the wrong place. A
  deployment that declares none makes no residency claim, and the Enterprise
  tier description should not make one either until it does.
- **Video and channels beyond website and email** (v1.1 §44 to 45). The
  channel-agnostic conversation model that makes them cheap is built; the
  adapters are not.
- **Priority-2 and 3 non-CRM connectors** (v1.2 §54): warehouse, CPQ, ERP,
  marketing automation, professional services. The contract is defined and the
  three priority-1 categories have two exemplar connectors each.
- **The independent accessibility audit** (v1.2 §58). The widget is built to
  WCAG 2.2 AA and the conformance statement generator refuses to claim
  conformance without a named auditor and a date.

None of these are hidden behind a stub that pretends to work. Where a capability
is absent it is absent, and where a connector cannot do something its capability
declaration says so and the product degrades explicitly.
