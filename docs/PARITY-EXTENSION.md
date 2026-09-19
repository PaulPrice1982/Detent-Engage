# v1.1 — Competitive parity extension

Implements `Agentic Website Assistant v1.1, Competitive Parity Extension`,
sections 37 to 50. Nothing in v1.0 is replaced: every architectural decision,
deterministic boundary, consent gate and connector contract still stands, and
each capability attaches to an existing component rather than working around it.

## Instant onboarding (§38)

Signup to a live, governed, CRM-connected assistant in under fifteen minutes,
with every generated artefact presented as a **draft requiring explicit
approval**.

Four generators run on a governed crawl — own registrable domain only, robots
respected, nothing off-domain ever fetched:

| Generator | Produces |
|---|---|
| Knowledge | Corpus with per-page provenance and a confidence on each claim |
| Playbook | Draft catalogue, claims, prices, objection responses |
| **Mapping** | Canonical-to-CRM field mapping by schema introspection |
| Routing | Owner rules from live owners, pipelines and stages |

The mapping generator is the one no competitor has, because no competitor
integrates deeply enough to need one. It turns v1.0's heaviest onboarding step
into its fastest, and it is only possible because of the connector contract that
already exists.

### The approval invariant

`approved` defaults to **false** on every claim and every price. A generated
price the tenant has not read cannot be quoted, so the price authority rule
survives an onboarding path that generates prices automatically.

Three structural answers to risk 14 — that instant onboarding erodes the
governance position by making approval feel like friction to remove:

- there is **no skip-all control** anywhere in `GenerationService`;
- low-confidence items are **excluded**, not merely unapproved, so they are not
  in the list a hurried tenant clicks through;
- a section cannot be signed off with unread items in it, and approval coverage
  is reported to the compliance scorecard.

Dry-run staging completes it: the first conversations produce **real, validated,
fully policied** canonical envelopes that land in a staging ledger. The diff
names the fields that will be written *and the fields that will not* — "owner:
not touched" is the line that answers the RevOps buyer's actual question.

## Agent Studio (§39)

Business-language authoring across seven surfaces. The compilation step is the
whole point: natural-language authoring produces **deterministic configuration,
not a longer prompt**. "Always confirm budget before booking" becomes a policy
gate, not a suggestion the model may ignore.

A rule the compiler cannot express is surfaced as **uncompiled**, never quietly
demoted to guidance. A tenant who wrote a rule expects a rule, and filing it
under "tone" would let them believe a boundary exists when it does not.

### The simulation harness

Ten synthetic buyers, run against the draft **before publish**, scored on
groundedness, boundary adherence, escalation correctness and disclosure safety.

A tenant can see, before going live, that their configuration will not invent a
price. No competitor offers this, and it is only possible because the boundaries
are deterministic and therefore testable — a prompt-governed assistant has
nothing stable to assert against.

**A publish that fails is blocked, not warned.** Warned is what every competitor
does, and a warning on a screen at 5pm on a Friday is not a control.

## Outcome taxonomy (§40)

Nine outcomes where v1.0 had one. Billability is a commercial design as much as
a product one:

- escalation, disqualification and abandonment are **never** billable, which
  removes the incentive to over-qualify;
- an outcome needing downstream confirmation is not billed until the tenant's own
  system confirms it happened. The platform does not bill for a routing decision
  that failed downstream.

Trial provisioning uses a webhook, a magic link or a redirect. **The platform
never holds a credential for the tenant's product** and never creates accounts
directly: that would extend the credential blast radius for marginal benefit.

## Analytics and the two scorecards (§41)

The funnel is table stakes and is built plainly. The two scorecards are where the
argument is.

### CRM data quality scorecard

Write fidelity is invisible in a demo and decisive in month three. This makes it
visible in week one: duplicates prevented (naming the record), owner overwrites
blocked, lifecycle protections, ambiguous matches escalated, reconciliation
backlog, measured precision on the tenant's own data.

The most important number should always read zero: **owner overwrites blocked.**
Reading zero *is the point* — it is the difference between claiming to protect
ownership and showing a counter that has never moved, derived from a log that
verifies.

### Compliance scorecard

The extension's own nominated highest-leverage item. It takes a compliance
architecture the buyer cannot see and turns it into a report they can take to
their own board, and it is the surface most likely to survive competitive
copying **because a competitor cannot report on gates it does not have.**

Every figure derives from the hash-chained audit log rather than a counter, and
the export carries the chain verification with it. A scorecard whose underlying
log does not verify is not evidence, and shipping it without saying so would be
compliance theatre.

Building it exposed a real gap: `ConsentService` stored events without auditing
them, so consent was invisible to the very report a DPO asks for. Now fixed.

## Consent-safe follow-up (§42)

Three legally distinct lanes rather than one, because lane two — a single
relevant follow-up under legitimate interest — is the capability competitors have
and v1.0 lacks, and it is defensible only with machinery.

**Fail closed is the governing principle.** An unresolvable jurisdiction produces
transactional-only, never a guess in the platform's commercial favour. A `.com`
address does not resolve to US; a public mailbox resolves to nothing.

Four further controls:

- lane two is disabled until the tenant's LIA is marked complete, and the
  platform generates the template but cannot complete it — an LIA is the
  controller's own balancing test;
- frequency caps are platform-enforced and **cannot be raised** by a tenant;
- a **global suppression list** across all tenants. Addresses are stored as
  salted digests, the only operation is "is this suppressed", and it can stop a
  message but never cause one — which is why the isolation argument does not
  apply in the direction that matters;
- sender identity and a physical address are required before any
  non-transactional message.

## Proactive engagement, lawful subset (§43)

Section 43.2 changes the design, and it is worth stating plainly because the
commercial pressure runs the other way:

> **The lawful version of proactive engagement is company-level, not
> person-level, in any non-consented session.**

That is materially narrower than what Warmly and Qualified market. The position
taken here is to sell the narrower version honestly rather than match a claim
that may not survive scrutiny.

The person-level gate is in code, not policy. The company-resolution return type
has **no person-shaped field at all**, which is a cheaper guarantee than a rule
everyone has to remember. The visitor's IP is used to resolve a company and is
never recorded.

Enrichment is metered, capped, cached per tenant, and its cost is previewed
before any bulk routine. It is explicitly **not model-mediated**: there is no
path by which a language model decides to spend a tenant's money.

## Sequencing

The extension's own verdict, which this build follows: fund Wave A. Wave A
closes every gap that decides a first meeting, improves the unit economics, and
strengthens rather than dilutes the governance position. Waves B and C add 44 to
64 engineer-weeks, degrade the unit economics, and enter races against
specialists.

Wave B's follow-up engine and the lawful subset of proactive engagement are built
here because both are genuinely code-shaped and both attach to existing
components. The marketplace programme and the design partner programme are
process, not engineering, and are not in this repository.
