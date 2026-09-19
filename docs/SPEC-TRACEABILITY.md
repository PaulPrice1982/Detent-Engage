# Specification traceability

Maps all three specifications to this codebase: v1.0 (sections 1–36), v1.1
(sections 37–50) and v1.2 (sections 51–62). Requirements with no owning component or no test are defects in the
specification, not gaps to be resolved later — so where something is not built,
it says so.

**Legend:** ✅ built and tested · ◐ partially built · ⬚ deliberately not built

## Functional requirements

| ID | Requirement | Status | Where | Test |
|---|---|---|---|---|
| FR-001 | Real-time text chat | ✅ | `agent/orchestrator.ts`, `server/api.ts` | `end-to-end-flows` |
| FR-002 | Streaming voice, barge-in, turn-taking | ⬚ | Modality modelled; WebRTC path not built | — |
| FR-003 | Move between text and voice in a session | ◐ | `session.ts` carries modality; voice absent | — |
| FR-004 | Answer only from approved knowledge | ✅ | `knowledge/retrieval.ts`, `grounding.ts` | `pii-and-grounding` |
| FR-005 | Conversational qualification per tenant criteria | ✅ | `agent/playbook.ts` | `booking-and-escalation` |
| FR-006 | Capture and explicitly confirm contact fields | ✅ | `policy/engine.ts` `unconfirmedFields` | `pii-and-grounding` |
| FR-007 | Resolve identity against tenant CRM | ✅ | `identity/resolution.ts` | `consent-gate` |
| FR-008 | Never disclose CRM contents to an unverified visitor | ✅ | `toModelSafe()`, `output-validation.ts` | `prompt-injection` |
| FR-009 | Route known contacts to their owner | ✅ | `scoring.ts` classification | `end-to-end-flows` |
| FR-010 | Create and update CRM records with correct associations | ✅ | `connectors/adapter.ts` | `crm-integrity`, `connector-contract` |
| FR-011 | Book a meeting with the correct person | ✅ | `agent/services.ts` | `booking-and-escalation` |
| FR-012 | Human handoff on threshold triggers | ✅ | `policy/escalation.ts` | `booking-and-escalation` |
| FR-013 | Present approved pricing only | ✅ | `policy/pricing.ts` | `booking-and-escalation`, `disclosure-and-output` |
| FR-014 | Handle objections within approved boundaries | ✅ | `agent/playbook.ts` | `booking-and-escalation` |
| FR-015 | Separate evidenced marketing consent before enrolment | ✅ | `tool-matrix.ts`, `engine.ts`, `services.ts` | `consent-gate` |
| FR-016 | Always offer a text-only, non-recorded route | ✅ | `api.ts`, `panel.html` | `disclosure-and-output` |
| FR-017 | Disclose that the visitor is interacting with AI | ✅ | `orchestrator.ts`, `launcher.ts`, `panel.html` | `disclosure-and-output` |
| FR-018 | Never misrepresent as human, pressure, or infer sensitive attributes | ✅ | `output-validation.ts` | `disclosure-and-output` |
| FR-019 | Internal sales notification on qualified leads | ✅ | `agent/services.ts` | `end-to-end-flows` |
| FR-020 | Ingest CRM change events via webhooks | ✅ | `server/webhooks.ts` | `webhooks-and-lifecycle` |
| FR-021 | Never auto-merge on ambiguous match | ✅ | `scoring.ts`, `resolution.ts` | `identity-resolution` |
| FR-022 | Per-tenant and platform kill switch | ✅ | `platform.ts`, `engine.ts` | `metering-and-kill-switch` |
| FR-023 | Consented recording with diarised transcript | ⬚ | Consent gate built; pipeline not built | `consent-gate` (gate only) |
| FR-024 | Tenant self-service onboarding | ◐ | `tenant-store.ts` lifecycle + admin API; no UI | `webhooks-and-lifecycle` |
| FR-025 | Tenant data export and deletion | ◐ | Audit export built; four-store erasure not wired | `webhooks-and-lifecycle` |
| FR-026 | Per-tenant metering, quota and spend caps | ✅ | `policy/metering.ts` | `metering-and-kill-switch` |
| FR-027 | Graceful degradation per capability declaration | ✅ | `contract.ts`, `adapter.ts` | `crm-integrity`, `connector-contract` |
| FR-028 | Public REST API, tenant-scoped | ✅ | `server/api.ts`, `auth.ts` | `cross-tenant-isolation` |
| FR-029 | Source and campaign attribution | ⬚ | Custom-field registry modelled; capture not built | — |
| FR-030 | Additional languages | ⬚ | English (UK) only, per the specification | — |

## Non-functional requirements

| ID | Target | Status | Note |
|---|---|---|---|
| NFR-001 | Time to first token < 2s p95 | ◐ | Depends on the model provider; pipeline adds no blocking I/O beyond policy |
| NFR-002 | Voice latency < 1.5s p95 | ⬚ | Voice not built |
| NFR-003 | Barge-in stop < 1s | ⬚ | Voice not built |
| NFR-004 | Degrade to text on low transcription confidence | ⬚ | Rule specified; voice not built |
| NFR-005 | 99.9% availability with degradation ladder | ✅ | Ladder built: text → booking link |
| NFR-006 | RPO 5 min, RTO 4 hours | ⬚ | Operational, not a code artefact |
| NFR-007 | CRM write visible < 60s p95 | ✅ | Bounded by each CRM's own index latency; reads go by id after create |
| NFR-008 | No confirmed booking without a durable record or queued task | ✅ | `tool-executor.ts` `book_meeting`; tested |
| NFR-009 | Pooled voice concurrency with per-tenant caps | ✅ | `metering.ts` `openVoiceSession` |
| NFR-010 | WCAG 2.2 AA | ◐ | Built to the standard; independent audit not run |
| NFR-011 | Current Chrome, Edge, Safari, Firefox | ✅ | Standard Web Components, no polyfills required |
| NFR-012 | UK and EU residency per tenant | ◐ | Modelled in config and schema; deployment topology not in scope |
| NFR-013 | Widget payload < 40KB gzipped, lazy-loaded | ✅ | Loader is a few KB; panel loads on first interaction |
| NFR-014 | Zero cross-tenant leakage | ✅ | Three enforcement points | 
| NFR-015 | COGS ≤ £0.60 per conversation | ✅ | Tracked and asserted; demo reports 2.5p at demo mix |
| NFR-016 | Error budget 0.1% monthly | ⬚ | Operational |
| NFR-017 | Correlation id and audit entry on every consequential write | ✅ | `adapter.ts`, `audit/log.ts` |
| NFR-018 | Config change effective < 60s without redeploy | ✅ | Config is data; version increments |

## Sequence flows (section 12)

| # | Flow | Status | Test |
|---|---|---|---|
| 1 | Anonymous new visitor, text | ✅ | `end-to-end-flows` |
| 4 | Contact details supplied and corrected | ✅ | `pii-and-grounding` (confirmation control) |
| 5, 6 | Known contact returns with an open opportunity | ✅ | `end-to-end-flows` |
| 7 | Multiple possible matches | ✅ | `identity-resolution` |
| 8 | Existing customer mistaken for a new prospect | ✅ | `end-to-end-flows` |
| 9 | Qualified lead books a meeting | ✅ | `booking-and-escalation` |
| 10 | Assigned owner unavailable | ◐ | Round-robin fallback not built; callback task is |
| 11 | Tenant CRM temporarily unavailable | ✅ | `crm-integrity` |
| 12 | Booking succeeds, CRM write fails | ✅ | `booking-and-escalation` |
| 13 | Transactional email follow-up | ✅ | `services.ts`, kind-separated |
| 14 | Prospect declines recording | ✅ | `consent-gate` |
| 15 | Consent revoked or deletion requested | ◐ | Withdrawal built; four-store erasure not wired |
| 16 | Insufficient confidence | ✅ | `booking-and-escalation` |
| 17 | Prompt injection | ✅ | `prompt-injection` |
| 18 | Post-processing | ◐ | Summarisation not built |
| 19 | CRM token revoked mid-operation | ✅ | `end-to-end-flows` |
| 20 | New tenant signs up and connects a CRM | ✅ | `webhooks-and-lifecycle` |
| 21 | Tenant exceeds quota | ✅ | `end-to-end-flows` |
| 22 | Tenant requests export and deletion | ◐ | Export built; erasure not wired |
| 23 | Tenant migrates CRM | ⬚ | Dry-run parallel connection not built |

## Section-by-section

| § | Subject | Where |
|---|---|---|
| 8 | Architecture and principles | `docs/ARCHITECTURE.md`, `platform.ts` |
| 11 | Trust boundaries | `docs/ARCHITECTURE.md`; B1 `grounding.ts`, B2 `schema.ts`, B3 `0001_init.sql`, B4 `adapter.ts` |
| 13 | Reasoning, policy, tool execution | `policy/engine.ts`, `agent/tool-executor.ts` |
| 13.2 | Tool catalogue and confirmation matrix | `policy/tool-matrix.ts` |
| 13.4 | Price and discount authority | `policy/pricing.ts` |
| 13.5 | Injection and exfiltration | `knowledge/grounding.ts`, `agent/output-validation.ts` |
| 14 | Qualification and objections | `agent/playbook.ts` |
| 15 | Knowledge and retrieval | `knowledge/` |
| 16 | Multi-CRM integration | `connectors/`, `docs/CONNECTORS.md` |
| 17 | Identity resolution and dedup | `identity/` |
| 18 | Calendar, email, notification | `agent/services.ts` |
| 20 | Recording consent | `core/consent.ts` (gate built; pipeline not) |
| 21 | Canonical model and mappings | `core/canonical.ts`, per-connector mapping |
| 22 | API contracts and schemas | `agent/tools.ts`, `identity/resolution.ts` |
| 23 | State machines | `agent/session.ts`, `playbook.ts`, `server/tenant-store.ts` |
| 24 | Security and threat model | `server/auth.ts`, `db/migrations`, `docs/ARCHITECTURE.md` |
| 25 | Privacy and compliance | `docs/COMPLIANCE.md` |
| 26 | Widget and visitor identity | `packages/widget/` |
| 27 | Handoff and escalation | `policy/escalation.ts`, `agent/services.ts` |
| 28 | Failure, retries, reconciliation | `connectors/adapter.ts`, `receipts.ts` |
| 29 | Observability and audit | `audit/` |
| 30 | Testing and evaluation | `tests/`, `docs/OPERATIONS.md` |
| 31 | Deployment and rollback | `docs/OPERATIONS.md` |
| 32 | Cost model and unit economics | `policy/metering.ts` |

## Where this build departs from the specification, and why

**`create_opportunity` does not create an opportunity.** It raises an owner task
instead. Stage and pipeline are CRM-authoritative, and an opportunity created
without them is worse for the tenant's reporting than no opportunity at all. The
tool exists, is gated, and captures the request; a human sets the stage. If a
tenant wants true opportunity creation, the stage must come from a CRM read of
their live pipeline configuration, which is a per-tenant onboarding decision
rather than a default.

**`ownerRef` is permitted on activity writes.** The blanket forbidden-field rule
would make owner routing impossible — flow 5 requires a task to reach the right
person's queue. The distinction that keeps it safe: no tool schema exposes an
owner field, so an `ownerRef` on an activity can only have come from a CRM read.

**Retrieval is lexical (BM25), not vector.** Deterministic, explainable, and
behind an interface the specification already anticipates replacing with the
conversational vendor's integrated retrieval. For the governed layer,
explainability is worth more than recall on paraphrase.

**Groundedness checking is narrow.** It verifies numbers, currency figures and
dates against the retrieved material and the approved price list. Those are the
claims that cause commercial damage when invented and the claims a lexical check
can verify honestly. Prose is judged by the per-tenant evaluation set in CI
rather than pretended to be checked at runtime.


---

# v1.1 — Competitive parity extension (FR-031 to FR-074)

| ID | Requirement | Status | Where |
|---|---|---|---|
| FR-031 | Generate a governed knowledge corpus from a root domain | ✅ | `onboarding/crawler.ts`, `generators.ts` |
| FR-032 | Generate a draft playbook from pricing and services pages | ✅ | `onboarding/extraction.ts`, `generators.ts` |
| FR-033 | Propose a canonical-to-CRM mapping by schema introspection | ✅ | `onboarding/generators.ts` (>90% standard coverage, tested) |
| FR-034 | Propose routing from live owners, pipelines and stages | ✅ | `generateRouting`, zero hard-coded stage assumptions |
| FR-035 | No generated artefact serves without explicit approval | ✅ | `core/approval.ts`, `GenerationService.approveSection` |
| FR-036 | Dry-run writes to a staging ledger with a diff preview | ✅ | `onboarding/staging-ledger.ts`, `ToolExecutor.writeOrPark` |
| FR-037 | Scheduled re-generation with a change diff | ⬚ | Generation is on demand; scheduling not built |
| FR-038 | Business-language authoring across seven surfaces | ✅ | `studio/authoring.ts` |
| FR-039 | Guidance compiles to deterministic policy | ✅ | `compileAuthoring`, `toCompiledPolicy` |
| FR-040 | Immutable versioning, diff, one-action rollback | ✅ | `studio/versioning.ts` |
| FR-041 | Pre-publish simulation against a synthetic buyer panel | ✅ | `studio/simulation.ts`, ten scenarios |
| FR-042 | Publish blocked on evaluation failure | ✅ | `evaluatePublishGate` — blocked, not warned |
| FR-043 | Tenant-authored panel additions | ✅ | `SimulationOptions.tenantScenarios` |
| FR-044 | Nine-outcome taxonomy, tenant-configurable | ✅ | `core/outcomes.ts`, `outcomes/outcome-service.ts` |
| FR-045 | Trial provisioning via webhook, magic link or redirect | ✅ | No tenant product credential held |
| FR-046 | Confirmation callback before an outcome is billable | ✅ | `OutcomeService.confirm` |
| FR-047 | Escalation, disqualification, abandonment never billable | ✅ | `isBillable`, tested |
| FR-048 | Partner routing with a multi-entity aware registry | ✅ | `outcomes/partners.ts`, extended by v1.2 `groups/partner-registry.ts` |
| FR-049 | Qualification funnel with drill-through | ✅ | `analytics/funnel.ts`, all seven views |
| FR-050 | CRM data quality scorecard | ✅ | `analytics/data-quality-scorecard.ts` |
| FR-051 | Compliance scorecard, exportable | ✅ | `analytics/compliance-scorecard.ts` |
| FR-052 | Scheduled digest | ⬚ | Not built |
| FR-053 | Reporting API, tenant-scoped | ✅ | `/v1/admin/tenants/{id}/analytics`, cross-tenant probe tested |
| FR-054 | Three legally distinct sending lanes | ✅ | `followup/jurisdiction.ts` |
| FR-055 | Jurisdiction rules engine, failing closed | ✅ | `permittedLane`, tested |
| FR-056 | Lane two disabled until the LIA is complete | ✅ | Two independent checks |
| FR-057 | Platform-enforced caps and global suppression | ✅ | `followup/suppression.ts` |
| FR-058 | Opt-out in every non-transactional message | ✅ | Honoured immediately, globally |
| FR-059 | Generated LIA template per tenant | ✅ | `generateLiaTemplate` |
| FR-060 | Company-level visitor resolution where lawful | ✅ | `signals/visitor-signal.ts` |
| FR-061 | Proactive engagement rules, per tenant | ✅ | `signals/engagement.ts` |
| FR-062 | All person-level identification gated on consent | ✅ | Gate in code, tested |
| FR-063 | Enrichment metered, cost shown before bulk routines | ✅ | `signals/enrichment.ts` |
| FR-064 | Account matching to CRM accounts | ✅ | `signals/account-matcher.ts` |
| FR-065 | Waterfall enrichment across at least two vendors | ✅ | Fallback exercised, tested |
| FR-066–067 | Video answers and generated follow-up video | ⬚ | Not built (Wave C) |
| FR-068 | All synthetic media marked machine-readably | ✅ | `core/media.ts`, refuses a synthetic likeness |
| FR-069 | Channel-agnostic model with a continuity key | ✅ | `core/channel.ts` |
| FR-070–071 | Email and WhatsApp channels | ⬚ | Model built, adapters not |
| FR-072–074 | Marketplace distribution | ⬚ | Process, not engineering |
| NFR-019 | Signup to first conversation under 15 minutes | ◐ | Generation pipeline built; measured in staging |
| NFR-020 | Mapping accuracy above 90% | ✅ | Asserted in CI |
| NFR-021 | Zero unapproved generated content reachable | ✅ | Invariant, tested |

# v1.2 — Unoccupied ground (FR-075 to FR-112)

| ID | Requirement | Status | Where |
|---|---|---|---|
| FR-075 | Group, entity, site hierarchy with per-entity CRMs | ✅ | `groups/hierarchy.ts` |
| FR-076 | Entity-level isolation preserved within a group | ✅ | Entities are separate tenants; probes at zero |
| FR-077 | Group reporting on pseudonymised identifiers | ✅ | `groups/group-identity.ts`, no content crossing |
| FR-078 | Group-wide suppression and opt-out | ✅ | Suppression crosses where data does not |
| FR-079 | Consented cross-entity introduction | ✅ | `mayLearnCrossEntityRelationship` — three conditions |
| FR-080 | Per-entity jurisdiction, consent, retention, residency | ✅ | Entity is a tenant; config is per tenant |
| FR-081 | Connector support for billing, support and CLM | ✅ | Two exemplars per category |
| FR-082 | Unified CustomerContext resolution | ✅ | `context/customer-context.ts` |
| FR-083 | All non-CRM integrations read-only by default | ✅ | Enforced at registration |
| FR-084 | The model receives permittedBehaviours only | ✅ | Two-field type, tested |
| FR-085 | Graceful degradation per category | ✅ | `unconnectedCategories` reported to the tenant |
| FR-086 | Warehouse and usage signals | ◐ | Contract defined; connector not built |
| FR-087 | Authoritative consent from marketing automation | ◐ | Contract defined; connector not built |
| FR-088 | Entitlement resolution from the CLM | ✅ | `context/systems/clm.ts`, `entitlement-service.ts` |
| FR-089 | Four-level verification ladder | ✅ | `core/verification.ts` |
| FR-090 | Excess use, arrears, renewal never disclosed | ✅ | Never in model context |
| FR-091 | Never interpret, advise on or predict a term | ✅ | Refused before the contract is read |
| FR-092 | Excess use creates governed internal tasks | ✅ | `recordExcessUse` with clause reference |
| FR-093 | Clause citation at level 3 | ✅ | Plus a verified-party check |
| FR-094 | Seven modes selected deterministically | ✅ | `modes/mode-selector.ts` |
| FR-095 | Selling disabled on negative sentiment or severe ticket | ✅ | Policy gate, not a prompt |
| FR-096 | No service commitment in arrears or dispute | ✅ | `checkModeGate` |
| FR-097 | Seven additional outcomes, independently metered | ✅ | `core/outcomes.ts` |
| FR-098 | Excess-use recovery share | ✅ | Billable on downstream confirmation only |
| FR-099 | Governed machine surface | ✅ | `machine/machine-surface.ts` |
| FR-100 | All agent traffic treated as non-consented | ✅ | Zero identity resolutions |
| FR-101 | Agent bookings provisional until human confirmation | ✅ | Token to the requester, not the agent |
| FR-102 | Separate rate limits, quota and spend caps | ✅ | Never shares the voice pool |
| FR-103 | Agent traffic analytics | ✅ | `trafficReport` |
| FR-104 | Optional agent registration with scoped keys | ✅ | Self-declared identity never trusted |
| FR-105 | Independent accessibility audit and statement | ◐ | Generator built; refuses to claim without an auditor. The audit itself is external |
| FR-106 | Behavioural Assurance Pack per tenant | ✅ | `assurance/assurance-pack.ts`, one action |
| FR-107 | Version-pinned conversation replay | ✅ | `AssurancePackGenerator.replay` |
| FR-108 | Sector boundary presets | ✅ | `SECTOR_PRESETS`, only ever tighten |
| FR-109 | Partner registry with deterministic routing | ✅ | `groups/partner-registry.ts` |
| FR-110 | Consent recorded before routing to a third party | ✅ | Refused without it |
| FR-111 | Deal registration with attribution preserved | ✅ | `buildDealRegistration` |
| FR-112 | Ownership conflicts escalate to a human | ✅ | Never resolved automatically |

## Further departures, and why

**`route_partner_v2` sits alongside `route_partner`.** v1.1 defined a partner
outcome; v1.2 redefines it with a consent gate and a conflict path. Rather than
change the meaning of an outcome tenants may already be billing on, the v1.2
behaviour is a distinct outcome and the v1.1 one remains as specified.

**Group suppression is cross-tenant state in a product built on isolation.** The
reconciliation: addresses are salted digests, the only operation is "is this
suppressed", and the list can stop a message but never cause one. Isolation
protects against unwanted flows of data; this flow only ever prevents contact.

**The mode gate lives in the policy engine, not in the orchestrator.** Selling
must be refused at the tool boundary, because an orchestrator check would be
bypassed by any caller that reaches `ToolExecutor` directly.
