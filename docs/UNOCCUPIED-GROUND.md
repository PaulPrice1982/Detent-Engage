# v1.2 — Unoccupied ground

Implements `Agentic Website Assistant v1.2, Unoccupied Ground`, sections 51 to 62.

## The argument in one page

Every competitor in this category built an inbound lead tool, and every one of
them reads only the CRM.

**The CRM is the worst-informed system in the stack about an existing
customer.** It knows a stage, an owner and some activity. It does not know
whether they have paid, whether they are angry, what they are entitled to, or
whether their usage is growing.

Billing knows the first. Support knows the second. The CLM knows the third. The
warehouse knows the fourth. No competitor reads any of them, because reading
them is outside the category they defined for themselves.

An assistant that reads all four is categorically better at the
existing-customer conversation, which for most mid-market B2B businesses carries
more revenue than new logo. That ground is not underserved. It is empty.

---

## The one demonstration

```bash
pnpm demo:customer
```

Same customer, same CRM record, three different situations:

| Situation | CRM says | This platform does |
|---|---|---|
| In good standing, happy | customer, owned by Priya, stage Renewal | Service and expansion. Selling permitted. |
| Open severity-one ticket | *identical* | **SERVICE_ONLY. Selling refused at the policy gate.** |
| In arrears | *identical* | **ESCALATE_ONLY. Routed without comment.** |

The CRM record is the same in all three. Every competitor sells into all three.

Two things make the second row work, and neither is a prompt instruction:

1. `checkModeGate` refuses `quote_price`, `create_opportunity`, `enrol_sequence`
   and `capture_contact` in `SERVICE_ONLY`. The policy engine denies the tool
   call before it executes.
2. The model is never told there is a ticket. It receives
   `permittedBehaviours: ["...", "do_not_sell", "escalate_immediately"]` and
   `verificationLevel`. Nothing else. **It cannot mention what it was never
   given.**

## The unified CustomerContext

Nine system categories resolve into one structure (`packages/context`). The
model-facing projection has exactly two fields:

```ts
service.toModelSafe(context)
// → { permittedBehaviours: [...], verificationLevel: 1 }
```

That is the FR-084 boundary: **zero source-system data in model context.** Not
redacted on the way out — never present. `CustomerContext` carries the arrears
flag, the ticket severity and the excess-use detection so the platform can raise
a task; `ModelSafeContext` is a two-field type and cannot carry any of it.

### The read-only rule

Every non-CRM integration is read-only, with exactly three exceptions requiring
explicit per-tenant enablement: create a support ticket, create a CLM task,
create a quote request.

The reason is blast radius. Section 24.2 identifies the credential store as the
highest-value target in the product, and adding nine categories multiplies it.
`assertReadOnlyUnlessEnabled` runs at **registration**, so a connector holding an
unexpected write never reaches a credential.

It is also a materially easier security review. A buyer grants read access to
billing far faster than write.

## Entitlement, and the verification ladder

Reading the CLM turns the assistant from a lead tool into a revenue instrument.
It is also the most sensitive thing it touches, so:

| Level | Reached by | Permits |
|---|---|---|
| 0 | anonymous | nothing |
| 1 | email stated | relationship and standing bands — **behaviour only, never disclosed** |
| 2 | one-time code **to the address on the contract** | in-scope / out-of-scope at category level. No clause text |
| 3 | authenticated portal handoff | clause text from **their own** executed agreement |

Level 2 is the practical working level. The code goes to the address on the
contract, not the address the visitor typed — a visitor who types a customer's
email proves nothing, and a code sent to the typed address would prove nothing
either.

Level 3 additionally checks that the verified party *is* the counterparty. Level
3 alone would otherwise permit reading anyone's contract.

### It reads and it cites. It never interprets.

`isInterpretationRequest` runs on the **question**, before any contract is read.
"Does this clause mean we can terminate early?" is refused before the CLM is
touched, because reading a contract to answer it and then declining would be
doing the prohibited thing and not saying so.

The pattern list deliberately excludes "cover". *"Does our agreement cover X"* is
the commonest legitimate question a customer asks and is answered by reading the
entitlement list. Treating it as interpretation would refuse the question the
whole feature exists to answer.

### What is never said

Excess use, arrears and renewal exposure produce **internal tasks only**.
Telling a visitor they are over their limit is a commercial conversation for a
human with authority. The finding never enters model context, so the assistant is
structurally unable to raise it.

## Multi-entity groups

**The group is a billing and reporting construct, not a data-sharing construct.**
Two entities in the same group are still two tenants under database row-level
security. Entities in a portfolio are frequently competitors of one another and
are always separate controllers.

Group access to an entity's conversation content requires an explicit, auditable,
revocable grant **from the entity**. A group administrator cannot grant
themselves access to a portfolio company's conversations.

The correct asymmetry, and worth stating in the sales conversation:
**suppression crosses where data does not.** An opt-out at entity A suppresses at
entities B to H immediately, on a per-group salted digest — so a group honours an
opt-out everywhere without pooling personal data anywhere.

The group policy floor is a floor, never a ceiling. An entity may be stricter.

## Buyer-side agent traffic

Increasingly the visitor is another AI agent researching on a buyer's behalf. The
opportunity is not to serve agents better than humans. It is to be the vendor
that can tell a tenant **how much agent traffic they receive, what it asked, and
what it was told.**

| Question | Position |
|---|---|
| Can an agent consent for a person? | No. All agent traffic is non-consented. Zero identity resolutions. |
| Does the Article 50 disclosure apply? | Served anyway, so any downstream human is told. Cost zero, ambiguity removed. |
| How is an agent authenticated? | Optional scoped key. A self-declared identity is never trusted. |
| Can an agent be told CRM information? | Never. The surface receives *less* than a human does. |
| Denial of wallet? | Separate rate limits, quota and spend cap. **Never shares the voice pool.** |
| Can an agent commit the tenant? | No. A booking is provisional until a verified human confirms, via a token emailed to the requester. |

## The Behavioural Assurance Pack

In financial services, legal services, healthcare and the public sector, the
barrier is not capability. **It is the inability to prove the agent will not do
something prohibited.**

`AssurancePackGenerator` assembles four artefacts in one action:

1. the deterministic boundary table — 22 rows across v1.0, v1.1 and v1.2,
   generated from one place so the sales artefact cannot drift from the code;
2. the simulation panel results;
3. the compliance scorecard, with its chain verification;
4. a version-pinned replayed conversation.

No competitor can assemble that pack, because none of them has deterministic
boundaries to evidence.

The accessibility statement **refuses to claim conformance** without a named
auditor and a date. Section 58 risk 28: no claim published without an
independent audit.

Sector presets only ever tighten. A regulated tenant can be stricter than the
platform floor; never looser.

## What is built, and what is not

| Section | Status |
|---|---|
| 53 Multi-entity and group operation | ✅ hierarchy, grants, group reporting, group suppression |
| 54 Integration surface beyond the CRM | ✅ contract, CustomerContext, six exemplar connectors across the three priority-1 categories |
| 55 Entitlement-aware conversation | ✅ verification ladder, entitlement service, excess-use and renewal tasks |
| 56 Existing-customer lane | ✅ seven modes, mode gate, seven new outcomes |
| 57 Buyer-side agent traffic | ✅ machine surface, provisional bookings, separate quota, traffic reporting |
| 58 Accessibility and regulated procurement | ✅ assurance pack, replay, sector presets. ⬚ the external audit itself |
| 59 Channel and partner routing | ✅ registry, deterministic routing, consent gate, conflict escalation |
| Warehouse, CPQ, ERP, marketing automation, professional services connectors | ⬚ contract defined, connectors not built (priority 2 and 3) |

## The honest trade

This variation abandons the self-serve, low-touch motion that v1.1 optimises
for. It sells to a larger buyer, at a higher price, over a longer cycle. That is
a strategic choice, not a side effect.

The risk that follows: **a longer sales cycle starves the business before the
position pays.** The sequencing answer is the assurance pack and the
billing-plus-support integration first, because both are sellable before the
full programme exists.
