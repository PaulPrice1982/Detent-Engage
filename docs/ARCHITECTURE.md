# Architecture

## The governing idea

A governed control plane holds all consequential authority and all credentials.
A bought conversational plane handles language, speech and turn-taking. They are
separated by a typed tool interface, and the language model never holds a CRM
credential or writes to a CRM directly.

The rule that follows from this, and that every design decision below serves:
**anything with a legal, financial or data-integrity consequence is business
logic, not model output.**

## What is deterministic and what is not

| Deterministic business logic | Delegated to the language model |
|---|---|
| Whether identity resolution may begin | Understanding what the visitor wants |
| Whether marketing enrolment is permitted | Tone, register and brand voice |
| What price may be stated | Framing an approved price in context |
| Whether any CRM data may be disclosed | Asking a non-disclosing question |
| Which CRM record is written to, and which fields | Drafting the note or summary |
| Whether a match is confident enough to act on | Explaining why a human will follow up |
| Whether to escalate | Recognising the sentiment or risk signal |
| Whether a tenant is within quota | Objection framing within boundaries |
| Retention, redaction and residency | Summarisation and field extraction |

Every row on the left is a decision the model is structurally prevented from
making — not discouraged from making in a prompt.

## Layers

```
Client        Widget loader, Shadow DOM launcher, sandboxed panel     build
Edge          Session gateway, API keys, rate limiting, CORS          build
Conversational  Speech, turn-taking, model orchestration, retrieval   buy (port)
Governance    Policy, consent, tool execution, output validation      build ← the differentiator
Integration   CRM adapter, connector framework, identity, calendar    build Tier 1
Platform      Tenant management, metering, admin API                  build
Data          Postgres + RLS, queues, object storage, audit chain     managed
```

The only layer bought outright is the conversational one, behind `ModelProvider`.
Swapping vendors changes one implementation of one interface. That matters
commercially: the largest single vendor dependency in the specification is
unconfirmed multi-tenant terms, and an architecture that cannot survive that
answer being "no" is not an architecture, it is a bet.

## Trust boundaries

| Boundary | From → To | Control at the crossing |
|---|---|---|
| **B1** untrusted input | visitor text, retrieved content → conversational plane | Treated as data, never instruction. Injection detection. Nothing is ever concatenated into the system prompt. |
| **B2** model output | conversational plane → control plane | Typed schema validation, policy evaluation, output validation, redaction before logging |
| **B3** tenant boundary | any tenant context → data and retrieval | RLS at the database under a restricted role; tenant binding at query construction, never post-filter |
| **B4** external write | tool execution → CRM, calendar, email | Least-privilege per-tenant credential, idempotency key, correlation id, audit before and after |

### B1 in practice

Retrieved content is wrapped by `wrapAsData()` in a delimited envelope with a
**random per-call delimiter**. Content that contains a literal delimiter cannot
close the envelope and start issuing instructions, because it cannot guess the
one in use. The envelope states explicitly that the content is reference
material and cannot issue commands.

### B2 in practice

`packages/core/src/schema.ts` is a deliberately small JSON Schema subset. It is
implemented rather than imported because it is a security control: the whole of
it fits on one screen, it cannot be extended by a schema arriving at runtime,
and `additionalProperties: false` is enforced rather than advisory. That last
point is the one that matters — an unknown property is how a model smuggles an
unvalidated field into a CRM write.

## The turn pipeline

Every turn follows the same ten steps. There is no fast path.

```
 1  ingest      visitor input, tagged untrusted; injection classifier runs
 2  retrieve    tenant-bound namespace only; content wrapped as data
 3  reason      model produces a response and zero or more tool calls
 4  validate    each tool call checked against its typed JSON schema
 5  policy      deterministic gate: consent, authority, quota, disclosure, escalation
 6  authorise   least-privilege per-tenant credential fetched at execution time
 7  execute     idempotent call with a correlation id
 8  audit       pre- and post-execution entries appended to the hash chain
 9  validate    model output checked; PII redacted before any logging
10  emit        response streamed to the visitor
```

Steps 4–8 live in `ToolExecutor` because they run per tool call. Steps 1–3 and
9–10 live in `TurnOrchestrator`, which owns the two things that must happen
whatever the model does: the Article 50 disclosure on the first turn, and output
validation before anything reaches the visitor.

### One ordering bug worth naming

An earlier version of the orchestrator substituted the injection refusal only
when the turn had *not* also escalated. An injection that tripped the security
escalation trigger therefore let the model's own text through. The fix — visible
in the comment at that line — is that injection suppression is unconditional and
runs before validation. It is recorded here because the class of bug (a control
that is conditional on another control) is the one to watch for in this design.

## The policy engine

`PolicyEngine.evaluate()` is the single gate. It evaluates, in order:

1. Is the tool in the catalogue at all? An unknown tool is a defect or an attack.
2. Is the tenant in a traffic-serving state?
3. Kill switches — platform-wide, then per-tenant, stricter wins.
4. Has the visitor asked for a human? If so, qualification tools stop. Safety
   tools do not.
5. Is the CRM connection live? If not, CRM tools are parked and the conversation
   continues.
6. Metering: checked *before* the spend, not reconciled at invoicing.
7. The consent gate, where the tool requires one.
8. Field-level confirmation, proven by the arguments rather than asserted by the
   model.
9. Human approval, per tool and per tenant configuration.

**Nothing in this class reads model output as an input to its own verdict.** The
model's claim that consent was given, that a price is approved, or that a field
was confirmed is never evidence. Evidence comes from the consent store, the
tenant configuration, and the tool arguments themselves.

## Identity resolution

Four rules are the whole design: gated on consent, scored not assumed, never
disclosed, never auto-merged.

The scoring waterfall is a fixed weight table, not a model. Same inputs, same
band, every time — which is what makes the deduplication precision figure in CI
mean something and what makes a band explainable to a tenant.

Person-name fuzzy matching is weighted at 4 out of a possible 100. It is an
ambiguity signal, never evidence. Treating it as evidence is how a website
assistant greets the wrong person by name.

Two candidates in the same confidence band produce `AMBIGUOUS`, which routes to
a human. The platform does not break that tie.

## The connector framework

The contract in `packages/connectors/src/contract.ts` is fixed and small. Three
rules live in the adapter rather than in connectors, because a rule that lives
in five connectors will be wrong in one of them:

- source-of-truth enforcement,
- idempotency via a write receipt claimed *before* the call,
- rate limiting and retry, sized per tenant below the vendor's published limit.

The receipt ordering is the mechanism: a crash between call and confirmation
leaves a `PENDING` receipt that reconciliation can resolve by reading back,
whereas a receipt written after the call would leave no trace of the attempt.

## Multi-tenancy

Isolation is enforced in three places and tested at each:

1. **Database.** RLS with `FORCE`, under a `NOBYPASSRLS` role. A forgotten
   `WHERE tenant_id` returns zero rows rather than another tenant's data.
2. **Query construction.** Retrieval takes `tenantId` as a required argument
   with no default and no overload that omits it. A caller that forgets does not
   compile.
3. **Authorisation.** The tenant id is derived from the API key, never supplied
   by the caller. A request naming another tenant cannot be authorised at all.

Per-tenant: KMS keys for CRM credentials, audit chains, rate-limit buckets,
spend caps, vector namespaces, prompt and policy version pins.

## Degrade, never fail

| Failure | Behaviour | Visitor sees |
|---|---|---|
| CRM unavailable | queue writes, reconcile on recovery | conversation continues, lead captured |
| Credential revoked | mark degraded, notify admin, park writes | capture-only mode, unaffected |
| Booking succeeds, CRM write fails | confirm booking, enqueue reconciliation | booking confirmed, never retracted |
| Model degraded | fall back, then to a booking link | reduced capability, honest message |
| Retrieval empty | answer only what is safely known | no fabrication, offer of a human |
| Quota exceeded | warn, degrade to text, then suspend | told plainly, offered a booking link |
| Isolation alarm | trip the platform kill switch | service degraded rather than risked |

The last row is the important one. A cross-tenant isolation failure in a
governance-positioned product is existential, so the correct response is to stop
serving rather than to keep serving and investigate.
