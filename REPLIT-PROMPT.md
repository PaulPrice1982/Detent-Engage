# Replit prompt: production-readiness build

**Copy everything in the fenced block below into the Replit Agent, once.**

The repository is finished, typechecked and tested. The Agent is there to run
it, not to write it.

What this build changes, in one line: **the websites are now served.** The
previous build mounted the API and nothing else, so `/console/signin`,
`/app/signin`, `/reseller/signin` and every password-reset page returned 404 in
every deployment. They answer now, and there is a staff account to sign in with.

**Budget: 2 Agent requests.** If the first does not produce a green run, drop to
the Shell and follow "If the Agent stalls" at the bottom. The Shell is free; the
Agent is not.

---

```
This repository is COMPLETE. It typechecks clean and all 1,192 tests pass. Do
NOT write, refactor, reformat or "improve" any source, test, dependency or
migration. Your only job is to update it, run it, and report what the commands
printed.

STEP 1, update the checkout.

Run, in the Shell:

    git pull && pnpm install

Expected: pnpm reports up-to-date or installs packages, and exits 0.

If this is not a git checkout, use the supplied zip instead. Delete the source
directories FIRST, then extract:

    rm -rf packages tests tools docs db brand examples
    unzip -o detent-agentic-website-assistant.zip
    pnpm install

The deletion is not optional. Extracting a zip over a project adds and
overwrites files and never removes one, so anything renamed in this build
leaves its old copy behind. This build renumbered two migrations, and a
workspace that kept the old names ends up with two files sharing a version
prefix, which the migration runner and `tests/migrations.test.ts` both refuse
outright. That refusal is correct: the order two migrations with the same
prefix run in is whatever the filenames happen to sort to, which is not a
decision anybody made.

The command above removes only directories the zip restores in full. It leaves
node_modules, .git, .replit and the Secrets pane untouched.

NOTE: never run `pnpm install --no-optional`. It breaks esbuild's platform
binary, which tsx needs, and the failure looks like a broken repository.

STEP 2, verify.

    pnpm typecheck

Expected output: two lines, the pnpm banner and `tsc --build --force`, then
nothing. Any TypeScript error means the checkout is incomplete. Re-run STEP 1.
Do not "fix" a type error.

    pnpm test

Expected final lines. There are two shapes, because the suite runs under vitest
where the registry installed it and under the built-in runner where it did not.
Both run the same files and both must report the same counts:

    Test Files  67 passed | 2 skipped (69)          <- vitest
         Tests  1192 passed | 3 skipped (1195)

    Test files  69                                   <- built-in runner
    Tests       1192 passed, 3 skipped

Either is a pass. The 3 skipped tests need a PostgreSQL and a Redis and skip
themselves without one, which is correct on Replit and is not a failure.

If a test fails, STOP and report the failing test name and its output verbatim.
Do not delete, skip, loosen or rewrite a test to make the suite pass.

STEP 3, set two secrets, then run it.

In the Secrets pane (the padlock), add:

    DETENT_CONSOLE_PASSWORD   a password you choose, 12 characters or more
    DETENT_SESSION_SECRET     32 characters or more

Generate the second one in the Shell if you like:

    node tools/make-secret.mjs session

Then:

    pnpm serve

Expected on stdout:

    Detent Agentic Website Assistant listening on 0.0.0.0:8787
      open             http://localhost:8787/
      console          http://localhost:8787/console.html
      tenant           t_demo
      model            scripted
      hosts            (path prefixes)
      operator         operator@detent.local
      sessions         lost on restart (no DATABASE_URL)
      payments         sandbox
      widget key       awa_pub_...
      tenant admin key awa_sk_...
      platform key     awa_sk_...

      NOTE: this process is running on the in-memory stores. ...

Every line of that is expected and correct:

  - "model scripted" means no ANTHROPIC_API_KEY is set, so the deterministic
    provider is answering. The governance tests rely on it.
  - "hosts (path prefixes)" means no DETENT_*_HOST is set, so the sites are
    reached by path rather than by hostname. Correct on a preview.
  - "sessions lost on restart (no DATABASE_URL)" is the truth, not a fault: the
    session records are in memory without a database, so a restart signs
    everybody out. It names every reason it found, so if you skipped
    DETENT_SESSION_SECRET in STEP 3 it says that too.
  - The NOTE says the audit chain and consent events do not survive a restart.
    That is the honest state of an in-memory run and is not an error.

The server binds 0.0.0.0. A loopback bind is unreachable from the Replit preview
proxy and shows as "running, but the preview isn't ready". Do not change it.

STEP 4, check the surfaces and report, then STOP.

Open the preview and confirm each of these returns a page:

    /                     the marketing home
    /console/signin       the staff sign-in page        <- new in this build
    /app/signin           the customer sign-in page     <- new in this build
    /reseller/signin      the partner sign-in page      <- new in this build
    /console.html         the five-step approval console
    /trust.html           the public trust page
    /widget/panel.html    the conversation panel

Then sign in at /console/signin with:

    email     operator@detent.local
    password  the DETENT_CONSOLE_PASSWORD you set in STEP 3

Expected: it redirects to /console and shows the accounts screen.

Then, in the Shell, run the runtime check. It makes the session request from
Node rather than from a shell, so there is nothing to quote and nothing to
mangle:

    pnpm smoke

Expected, with the widget key taken from the boot output:

    node tools/smoke.mjs --key awa_pub_...paste_the_widget_key_here...

    Pages
      PASS  /
      PASS  /console/signin
      PASS  /app/signin
      PASS  /reseller/signin
      PASS  /console.html
      PASS  /trust.html
      PASS  /widget/panel.html

    Session API
      PASS  POST /v1/sessions  201, session sess_...

    All checks passed.

Without `--key` it checks the pages and reports the session check as SKIP,
which is a pass for the pages and not a failure.

How to read anything else:

  - `FAIL ... 403` means the key or the origin was refused. The message names
    the origin it sent; it must be one of AWA_ORIGINS, and the key must be the
    `awa_pub_` one rather than either `awa_sk_` key. That refusal is the
    control working, not a bug.
  - `FAIL ... MALFORMED_REQUEST` from `pnpm smoke` would mean something between
    this command and the server is rewriting the request, because the script
    builds it itself. It has never been seen.

Do not verify this with a hand-typed curl. Two releases were reported broken on
a mangled command rather than on the server: once when line continuations were
lost, and once when a pasted key carried a line break into a header, which the
HTTP parser refuses with HPE_LF_EXPECTED. `pnpm smoke` exists because of both.

If the server does not start at all, read the first line it prints. A port
already held by an earlier instance now says so in one line, names the port,
and exits: it does not print a stack trace. Stop the older process, or set PORT.

Report the output of STEP 2, STEP 3 and STEP 4 and STOP. Do not commit, do not
open a pull request, do not modify configuration, and do not continue to any
further step.
```

---

## What changed in this build

Already done. Listed so you know what you are looking at, not as work for the
Agent.

| Area | Change |
|---|---|
| **The websites** | `main.ts` never passed the site routers to the HTTP server, so every sign-in page, the console, the customer area and the reseller portal answered 404 in every deployment. They are mounted now, resolved by hostname and then by path, and an unrecognised hostname is served no content at all. |
| **The build** | Nine packages (auth, cms, console, ingestion, payments, persistence, reseller, support, voice) were imported by the server and the tests and were in no dependency list and no tsconfig. The repository did not compile and 22 test files never loaded, so their tests were never counted: the real total is 1,182, not 484. |
| **Migrations** | No longer open their own transaction, are safe to run twice, and apply on a managed PostgreSQL that will not create a role. Two files shared the `0002_` prefix; renumbered. |
| **Boot** | A deployment now checks the database, keys, model id and origins before constructing anything, and serves the reasons rather than crash-looping if any is missing. Durability is measured from the stores, not declared. |
| **Metering** | The Postgres usage store now increments in one atomic statement. It also clamped the concurrency delta rather than the result, so every release of a voice slot was discarded. |
| **Isolation** | Five tenant-scoped tables added by an earlier migration (`auth_user`, `account`, `subscription`, `invoice`, `support_request`) had no row-level security at all. They do now. |
| **MFA** | `mfaEnrolled` could never become true, which made nine money capabilities unreachable, and a hard-coded `true` in the console bypassed the gate entirely. TOTP enrolment exists, verified against the RFC 6238 test vectors. |
| **Console authorisation** | Capability checks decided which buttons to draw and nothing checked them on the way to acting. Every console write is now refused server-side without the capability. |
| **Rate limits** | The counter interface was synchronous, so no shared store could implement it. A Redis adapter now enforces one budget across every instance. |
| **CI** | There was none. Four jobs, including the suite against a real PostgreSQL under a role that cannot bypass row-level security. |

The finding-by-finding record is `docs/AUDIT-RESPONSE.md`. Who can sign in and
how to restore access is `docs/ACCESS-HANDOVER.md`.

## Configuration

Nothing here is needed to run the preview. Everything here is needed before
Deploy, and a deployment missing any of it serves a page naming what is missing
rather than crash-looping.

| Variable | Effect |
|---|---|
| `DETENT_CONSOLE_EMAIL` | The one staff account's address. Defaults to `operator@detent.local`, which no reset email can reach, so set it. |
| `DETENT_CONSOLE_PASSWORD` | Its password. Read at every boot, so changing it and restarting is the documented way back in. Without it no staff account is created and the sign-in page says so. |
| `DETENT_SESSION_SECRET` | Signs session cookies, 32 characters or more. Generated per boot if unset, which signs everybody out on every restart. |
| `DATABASE_URL` | PostgreSQL. Without it every store is in memory. |
| `AWA_ROOT_KEY` | Encrypts CRM credentials at rest. Generated per boot if unset, so a restart cannot read the previous run's credentials. |
| `AWA_CHECKPOINT_KEY` | Signs the audit checkpoints. |
| `ANTHROPIC_API_KEY` | Uses the real model provider instead of the scripted one. |
| `AWA_MODEL` | Model id, validated at boot against an allow-list. **No default**: a hard-coded id fails as a 404 with nothing pointing at the cause. |
| `AWA_ORIGINS` | Comma-separated origins allowed to embed the widget. |
| `DETENT_EMAIL_PROVIDER`, `DETENT_EMAIL_API_KEY`, `DETENT_EMAIL_FROM` | Sends password-reset links. Without these they are written to the log instead. |
| `DETENT_MARKETING_HOST`, `DETENT_APP_HOST`, `DETENT_CONSOLE_HOST`, `DETENT_RESELLER_HOST` | Hostname per site. The console may not share a hostname with the others; a deployment refuses to start if it does. |
| `AWA_DEV_PRINT_KEYS` | Prints the three API keys at boot. Ignored in a deployment. |
| `AWA_HSTS`, `AWA_TRUST_PROXY`, `AWA_ALLOW_PAGE_PROBE` | Off by default; each a deliberate opt-in. |

## Deploying, as opposed to previewing

A Replit deployment sets `REPLIT_DEPLOYMENT`, which puts this build into
deployment mode. In that mode it refuses to serve the product until
`DATABASE_URL`, `AWA_ROOT_KEY`, `AWA_CHECKPOINT_KEY`, `ANTHROPIC_API_KEY`,
`AWA_ORIGINS` and `AWA_MODEL` are all set and the database answers.

It does not crash. It serves a page listing every missing item at once, and
answers the platform's health probe with 200 so the container stays routable.
If you press Deploy before setting the secrets, that page is what you will see,
and it is the build working as intended.

`[deployment]` runs `node tools/migrate.mjs` before serving, so the schema is
applied as a step of its own rather than by several containers racing at boot.

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
