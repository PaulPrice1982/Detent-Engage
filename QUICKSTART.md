<img src="brand/detent-logo.jpg" alt="Detent" width="280">

# Quickstart

```bash
corepack enable
pnpm install
pnpm test            # 387 tests, expect zero failures
pnpm demo:customer   # the one to watch
```

No database, no API keys and no network access are needed for any of that.

### If your registry blocks a package

It still runs. Node 22 executes the whole product from source with **no
`node_modules` at all**:

```bash
pnpm test:fallback   # 387 tests on Node alone
pnpm serve           # then open http://localhost:8787/ for the status page:node      # the API on Node alone
```

`vitest` is an optional dependency, so a registry refusing it leaves a warning
rather than aborting the install. `pnpm test` and `pnpm serve` pick the best
available runner automatically — vitest, then tsx, then Node's own TypeScript
transform. All three run the same files unmodified.

## Where to look first

| If you are | Read | Then run |
|---|---|---|
| Deciding whether this is real | `README.md` | `pnpm demo:customer` |
| Deploying it to Replit | `REPLIT-PROMPT.md` | the prompt in it |
| An engineer | `docs/ARCHITECTURE.md` | `pnpm test` |
| A DPO or compliance owner | `docs/COMPLIANCE.md` | the compliance scorecard endpoint |
| An integrations engineer | `docs/CONNECTORS.md` | `tests/connector-contract.test.ts` |
| On call | `docs/OPERATIONS.md` | `pnpm serve` |
| Checking it against the specs | `docs/SPEC-TRACEABILITY.md` | — |

## The two demos

```bash
pnpm demo           # v1.0/v1.1: consent refused, known contact, prompt injection
pnpm demo:customer  # v1.2: the same customer, three situations, three behaviours
```

`demo:customer` is the one to show anyone evaluating this. Same CRM record in
all three scenarios. In the second, the customer has an open severity-one
ticket, and the assistant refuses to sell — because it read the support system,
and because the model was never told there was a ticket, so it cannot mention it
either.

## What this is

A multi-tenant, multi-CRM agentic website assistant in which every consequential
behaviour is governed by deterministic policy rather than delegated to a
language model. Implements three specifications end to end: v1.0 (the governed
core), v1.1 (competitive parity) and v1.2 (unoccupied ground).

Nothing here calls a real language model, a real CRM or a real database. Every
external dependency is behind a port with an in-memory implementation, which is
what makes the whole suite runnable offline and what makes swapping a vendor a
one-file change.
