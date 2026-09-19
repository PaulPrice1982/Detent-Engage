# Connectors

Adding a CRM must be a task, not a project. The target from the specification is
**one Tier 2 connector per two engineering weeks** once the framework is stable,
and everything below is arranged to make that true.

## The contract

Fifteen methods, fixed and small (`packages/connectors/src/contract.ts`). It has
stayed small because three concerns that would otherwise grow it live in the
adapter instead:

- source-of-truth enforcement,
- idempotency and write receipts,
- rate limiting, retry and backoff.

A rule that lives in five connectors will be wrong in one of them.

**No method accepts an owner, lifecycle stage, pipeline or stage.** Those are
read-only from the CRM, always. The one deliberate exception is `ownerRef` on an
*activity* — assigning a task to an owner reference read from the CRM is not the
same as writing ownership onto a person, and conflating them would make owner
routing impossible. No tool schema exposes an owner field, so that reference can
only have come from a CRM read.

## Built connectors

| CRM | Tier | Auth | Lead object | Idempotency mechanism |
|---|---|---|---|---|
| HubSpot | 1 | OAuth / private app | No, unified contact | Batch upsert on `idProperty`; 409 conflict converted to update |
| Salesforce | 1 | OAuth 2.0 | Yes | External ID upsert (`PATCH` on `Detent_Key__c`) |
| Dynamics 365 | 1 | OAuth via Entra ID | Yes | Alternate-key upsert (`PATCH /leads(detent_key='...')`) |
| Zoho CRM | 1 | OAuth 2.0, region-bound | Yes | `/upsert` with `duplicate_check_fields` |
| Pipedrive | 1 | OAuth 2.0 | No | Search-then-write under a mutex + write receipt |

### What each one taught us, in its own comments

**HubSpot.** A create that collides with an existing unique property returns 409
naming the existing record id. That is converted into an update, never retried
as a create — retrying is how duplicates get made. New records are not
immediately searchable, so reads after a create go by id.

**Salesforce.** The lead-versus-contact decision is made once, from the canonical
qualification state. An unqualified visitor becomes a Lead. Creating a Contact
for an unqualified visitor corrupts the tenant's conversion reporting, and a
RevOps buyer will not forgive it. Both Lead and Contact are searched, because a
person present as both is an ambiguity signal the scorer must see.

**Zoho.** The API host is data-centre bound and the token is region-bound.
Getting the region wrong produces a 401 that looks exactly like a revoked grant,
so the credential carries the region and the connector **refuses rather than
guessing**. A 204 empty search is an empty result, not a failure.

**Dynamics.** Upsert requires the `If-Match` / `If-None-Match` semantics of an
alternate-key `PATCH`. Omitting them turns an intended upsert into an accidental
create.

**Pipedrive.** No native upsert, so idempotency is search-then-write inside a
per-session mutex with a stored write receipt. The capability declaration says
`PARTIAL` for that reason rather than claiming parity. The write key goes into a
custom field the tenant provisions at onboarding — without it, a write leaves no
trace reconciliation can read back, which is exactly the case Pipedrive's
missing upsert makes most likely.

## Capability declarations

Every connector declares what it can and cannot do. Where a capability is
partial or absent, the product **degrades explicitly**: a tenant on a CRM
without change notification is told that returning-visitor recognition will lag,
rather than being quietly given a worse experience.

```ts
const capabilities = await adapter.capabilities(tenantId);
// → duplicateDetectionOrMerge: 'NONE'
// → degradationNotes: ['No duplicate-detection or merge API: suspected
//    duplicates raise an owner task rather than being merged.', ...]
```

The contract suite asserts that every Tier 1 connector declares **at least one**
honest limitation or degradation note. A connector that declares `FULL` for
everything is a connector nobody has looked at.

## Adding a connector

1. **Implement `CrmConnector`.** Start from `sandbox.ts`, which models the
   awkward parts on purpose — a separate lead object, read-only owner and
   lifecycle, and an injectable failure mode.
2. **Write an honest capability declaration.** Where the vendor has no
   equivalent, say `NONE` and add a degradation note. Do not claim parity.
3. **Register it** in `ConnectorRegistry`.
4. **Add it to `CASES` in `tests/connector-contract.test.ts`** with recorded
   response shapes. That is the whole test-writing effort: the assertions are
   already written and run against every connector.
5. **Meet the definition of done** below.

### Definition of done

- Contract tests green against a live sandbox or test account.
- Deduplication precision above 95% on the standard synthetic dataset.
- Webhook replay, duplication and out-of-order tests passing.
- Rate-limit backoff verified against the vendor's published limits.
- A complete and accurate capability declaration.
- Documented erasure behaviour.

### Sandbox availability

Salesforce and Dynamics provide full sandboxes. HubSpot's availability is
edition-dependent, and lower tiers require a separate developer test account.
Several Tier 2 and most Tier 3 CRMs provide none at all, in which case a
dedicated paid test tenant is provisioned and the cost carried as a fixed
platform expense. That expense is the price of a connector suite that runs in CI.

## Rate limiting

Per **tenant**, not per connector: one tenant must not be able to exhaust
another tenant's CRM quota, and most CRM limits are enforced per portal or per
org, not per application.

Buckets are sized below the vendor's published limit. HubSpot search is treated
conservatively at 4 requests per second despite the documented increase to 5.
Burst capacity is one second's worth — larger bursts look fine locally and trip
the vendor's own limiter under concurrency.

Backoff is exponential with **full jitter**. Jitter is not decoration:
synchronised retries across tenants after a shared outage are a self-inflicted
flood. `Retry-After` is honoured where the provider supplies it, in both numeric
and HTTP-date forms.

## Writes, conflicts and reconciliation

| Concern | Approach |
|---|---|
| Idempotency | Native upsert on a stable external id where supported; search-then-write under a mutex with a stored receipt where not |
| Conflict on create | Catch the duplicate response and convert to an update. Never retry the create. |
| Correlation | Every write carries a correlation id, stored in a receipt **before** the call and confirmed after |
| Search index latency | Never rely on immediate searchability. Read back by id after a create. |
| Ordering | Change events versioned by the CRM's own last-modified timestamp. Out-of-order events are **discarded, not applied** — applying stale state is worse than dropping it. |
| Merges | A merge can produce a new record id, so stored identifiers are remapped rather than assumed stable |
| Partial failure | Multi-object operations decompose into individually idempotent steps, never wrapped in a transaction the CRM does not provide |
| Source of truth | Ownership, lifecycle stage, pipeline and stage are always CRM-authoritative |

## Change events

`ChangeEventProcessor` enforces three properties, each tested:

- **Signature verification** on every event, timing-safe, with a length mismatch
  treated as failure. An unsigned event is a forgery attempt, not a delivery
  problem, and is recorded as a security event.
- **Idempotency** on `{event_id, tenant_id, attempt}`.
- **Ordering** by `source_version`, discarding anything not newer.

Payloads carry metadata only; a follow-up read fetches the record. A payload is
a claim about state at some past moment; the record is the state now.

## The Tier 3 long tail

Served by a pass-through unified API behind the same `CrmConnector` interface,
so nothing upstream can tell the difference. Pass-through, not sync-and-store:
a sync-and-store platform holds a copy of every tenant's CRM data, which
materially worsens the DPA conversation with a compliance-sensitive buyer and
creates a second breach surface for data the platform did not need to hold.
