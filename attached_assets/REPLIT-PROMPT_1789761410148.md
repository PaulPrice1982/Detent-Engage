# Replit prompt — audit remediation build

**Copy everything in the fenced block below into the Replit Agent, once.**

The repository is finished, typechecked and tested. The Agent is there to run
it, not to write it. This build closes every finding in the 18 September 2026
independent code audit: persistence adapters, an approval console, credential
encryption, rate limiting, streaming, six locales, and 484 tests.

**Budget: 2 Agent requests.** If the first one does not produce a green run,
drop to the Shell and follow "If the Agent stalls" at the bottom. The Shell is
free; the Agent is not.

---

```
This repository is COMPLETE. It typechecks clean and all 484 tests pass. Do NOT
write, refactor, reformat or "improve" any source, test, dependency or migration.
Your only job is to update it, run it, and report what the commands printed.

STEP 1 — update the checkout.

Run, in the Shell:

    git pull && pnpm install

Expected: pnpm reports up-to-date or installs packages, and exits 0.

If this is not a git checkout, unzip the supplied
dist-zip/detent-agentic-website-assistant.zip over the project root instead
(overwrite everything), then run `pnpm install`.

NOTE: never run `pnpm install --no-optional`. It breaks esbuild's platform
binary, which tsx needs, and the failure looks like a broken repository.

STEP 2 — verify.

    pnpm typecheck

Expected output: two lines, the pnpm banner and `tsc --build --force`, then
nothing. Any TypeScript error means the checkout is incomplete — re-run STEP 1.
Do not "fix" a type error.

    pnpm test

Expected final lines:

    Test Files  31 passed (31)
         Tests  484 passed (484)

If a test fails, STOP and report the failing test name and its output verbatim.
Do not delete, skip, loosen or rewrite a test to make the suite pass.

STEP 3 — run it.

    pnpm serve

Expected on stdout:

    Detent Agentic Website Assistant listening on 0.0.0.0:8787
      open             http://localhost:8787/
      console          http://localhost:8787/console.html
      tenant           t_demo
      model            scripted
      widget key       awa_pub_...
      tenant admin key awa_sk_...
      platform key     awa_sk_...

      NOTE: this process is running on the in-memory stores. ...

The NOTE is expected and correct: without the Postgres adapters wired, the audit
chain and consent events do not survive a restart, and the boot message says so
deliberately. It is not an error.

The server binds 0.0.0.0. A loopback bind is unreachable from the Replit preview
proxy and presents as "running, but the preview isn't ready" — do not change it.

STEP 4 — check four surfaces and report, then STOP.

Open the preview and confirm each of these returns a page:

    /                 the status page
    /console.html     the five-step approval console
    /trust.html       the public trust page
    /widget/panel.html  the conversation panel

Then, in the Shell, with the widget key printed at boot:

    curl -s -XPOST localhost:8787/v1/sessions \
      -H "authorization: Bearer <WIDGET_KEY>" \
      -H "origin: http://localhost:8787" \
      -H "content-type: application/json" \
      -d '{"jurisdiction":"UK"}'

Expected: a JSON object containing session_id, disclosure, locale and
streaming_available. The `origin` header is required — widget keys are bound to
the tenant's registered origins, and a request without one is refused with 403.
That refusal is the control working, not a bug.

Report the output of STEP 2, STEP 3 and STEP 4 and STOP. Do not commit, do not
open a pull request, do not modify configuration, and do not continue to any
further step.
```

---

## What changed in this build

Everything below is already done. It is listed so you know what you are looking
at, not as work for the Agent.

| Area | Change |
|---|---|
| Persistence | `@detent/awa-db` — Postgres adapters behind every store interface, `SET LOCAL app.tenant_id` inside each transaction, plus an isolation probe suite |
| Console | `/console.html` — Connect, Generate and approve, Dry run, Go live, Evidence |
| Credentials | Envelope encryption under a KMS-style provider, with rotation |
| Abuse | Per-key, per-IP and per-session rate limits, input cap, spend cap checked before the model call |
| Widget | Close control, Escape inside the panel, streaming, session resume, mobile sheet, six locales |
| Provider | `AnthropicModelProvider` behind the same port as the scripted one |
| Commercial | Self-serve trial, OAuth connect, outcome ledger, value-first analytics, assurance pack as a printable document, trust page and pre-filled security questionnaire |

The finding-by-finding record is `docs/AUDIT-RESPONSE.md`.

## Configuration this build understands

None of it is required to run; all of it is read from the environment.

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Uses the real model provider instead of the scripted one |
| `AWA_MODEL` | Model id, default `claude-opus-5` |
| `AWA_ORIGINS` | Comma-separated registered origins, default `http://localhost:8787` |
| `AWA_ROOT_KEY` | Root key for credential encryption. Generated per run if unset — which means a restart cannot read the previous run's credentials |
| `AWA_FEATURE_*` | Per-flag overrides, e.g. `AWA_FEATURE_SELF_SERVE_TRIAL=1` |
| `AWA_HSTS`, `AWA_TRUST_PROXY`, `AWA_ALLOW_PAGE_PROBE` | Off by default; each is a deliberate opt-in |

## If the Agent stalls

Stop it and use the Shell. Every step above is a shell command, and the Shell
costs nothing:

```bash
git pull && pnpm install
pnpm typecheck
pnpm test
pnpm serve
```

If `pnpm` itself is missing, the whole product also runs on Node alone with an
empty `node_modules`:

```bash
pnpm test:fallback   # the built-in runner under Node's TypeScript transform
pnpm serve:node      # the same server, no dependencies
```
