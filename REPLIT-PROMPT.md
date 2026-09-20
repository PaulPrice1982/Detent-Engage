# Replit prompt: the back office renders

**Copy everything in the fenced block below into the Replit Agent, once.**

The repository is finished, typechecked and tested. The Agent is there to run
it, not to write it.

What this build changes, in one line: **every page the server renders was
arriving in the browser with its own stylesheet refused, and now is not.**

The content security policy for a request was chosen from the file extension in
its path. Every page this server renders is served from a path with no
extension, so the whole back office, the whole customer area, the reseller
portal and every sign-in page were given the API policy, `default-src 'none'`,
which blocks the page's own CSS. Nothing failed: no status was wrong, no handler
threw, and curl, which enforces no policy, returned perfect HTML. The only
symptom was that every screen rendered in a real browser as an unstyled
document, and curl could not see it.

Two more things travel with it. `form-action` moves from `'none'` to `'self'`,
because it does not inherit from `default-src` and with `'none'` nobody can
submit a form once the page policy applies. And the Approve and Reject buttons
in the back office posted to `/v1/console/approvals/...`, which is the API's
reserved space and authenticates a bearer key rather than a browser session, so
every press answered POLICY_DENIED and no action held for a second person could
ever be released by one.

**This one is verified by eye, not only by a test.** The check that matters is
opening `/console/signin` in the preview and seeing a styled page. A test suite
cannot see a stylesheet that the browser declined to apply, which is exactly why
this shipped.

**Budget: 2 Agent requests.** If the first does not produce a green run, drop to
the Shell and follow "If the Agent stalls" at the bottom. The Shell is free; the
Agent is not.

---

```
This repository is COMPLETE. It typechecks clean and all 1,233 tests pass under
each of its three runners. Do NOT write, refactor, reformat or "improve" any
source, test, dependency, stylesheet or migration. Your only job is to update
it, run it, look at one page, and report what you saw.

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
overwrites files and never removes one, and this build MOVED code out of files
rather than only changing it: fourteen CSS blocks left the TypeScript
renderers and became two files in packages/server/public. Merging this build
into an old tree leaves the old inline copies in place, and you get a page that
loads the new stylesheet and the stale inline one on top of it.

The command above removes only directories the zip restores in full. It leaves
node_modules, .git, .replit and the Secrets pane untouched.

The zip is about 21 MB in this build. Most of that is docs/demo, which is the
recorded product demonstration and is not needed to run anything. If space is
short you may delete docs/demo after extracting. Delete nothing else.

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

    Test Files  70 passed | 2 skipped (72)          <- vitest
         Tests  1233 passed | 3 skipped (1236)

    Test files  72                                   <- built-in runner
    Tests       1233 passed, 3 skipped

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

Every line of that is expected and correct, and none of it changed in this
build. "model scripted" means no ANTHROPIC_API_KEY is set. "sessions lost on
restart" is the truth without a database, not a fault. The NOTE says the audit
chain does not survive a restart, which is the honest state of an in-memory run.

The server binds 0.0.0.0. A loopback bind is unreachable from the Replit
preview proxy and shows as "running, but the preview isn't ready". Do not
change it.

STEP 4, the check this build exists for. LOOK at the page.

Open the preview at:

    /console/signin

Expected: a DARK NAVY page, with a white card in the middle of it holding the
email and password fields and a dark "Sign in" button.

If you see a white page with a serif font and blue underlined links, the
stylesheet was refused and this build did not take. Report that and STOP.
Do not try to fix it.

Then sign in with:

    email     operator@detent.local
    password  the DETENT_CONSOLE_PASSWORD you set in STEP 3

Expected: it redirects to /console and shows the accounts screen with a DARK
HEADER BAR across the top carrying the Detent mark, a "BACK OFFICE" tag, and
the links Accounts, Approvals, Audit and Service. Underneath, on a pale grey
ground, cards with rounded corners.

Again: serif text on white with blue links means the stylesheet was refused.

STEP 5, confirm it in the Shell as well, then STOP.

Two free checks. Replace $URL with your preview origin, or use
http://localhost:8787 from the Shell.

    curl -s -o /dev/null -w "%{http_code} %{content_type}\n" $URL/backoffice.css

Expected exactly:

    200 text/css; charset=utf-8

A 404 here means the stylesheet is not being served and the pages above cannot
have rendered. Report it.

    curl -sI $URL/console/signin | grep -i content-security-policy

Expected: one line, beginning

    content-security-policy: default-src 'self'; base-uri 'none'; form-action 'self'; ...

The two words that matter are `'self'` after `default-src` and `'self'` after
`form-action`. If you see `default-src 'none'` on this path, the build did not
take: that is the API policy, and it is what broke every page.

Then the runtime check, which makes the session request from Node rather than
from a shell, so there is nothing to quote and nothing to mangle:

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

    Platform probes
      PASS  /health   {"status":"ok"}
      PASS  /healthz  {"status":"ok"}
      PASS  /readyz   {"status":"ready","durable":false}
      PASS  /livez    {"status":"ok"}
      PASS  /_health  {"status":"ok"}

    Session API
      PASS  POST /v1/sessions  201, session sess_...

    All checks passed.

`durable: false` on /readyz is correct without a DATABASE_URL and is not a
failure. It reports what is actually wired rather than what the deployment
claims about itself.

Do not verify any of this with a hand-typed curl against /v1/sessions. Two
releases were reported broken on a mangled command rather than on the server:
once when line continuations were lost, and once when a pasted key carried a
line break into a header, which the HTTP parser refuses with HPE_LF_EXPECTED.
`pnpm smoke` exists because of both.

If the server does not start at all, read the first line it prints. A port
already held by an earlier instance says so in one line, names the port, and
exits: it does not print a stack trace. Stop the older process, or set PORT.

Report what you saw in STEP 4 in your own words, and the output of STEP 2 and
STEP 5, and STOP. Do not commit, do not open a pull request, do not modify
configuration, and do not continue to any further step.
```

---

## If the Agent stalls

Everything above except looking at the page is a Shell command, and the Shell
is free. In order:

```sh
git pull && pnpm install
pnpm typecheck
pnpm test
pnpm serve            # in a second Shell tab
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8787/backoffice.css
curl -sI http://localhost:8787/console/signin | grep -i content-security
pnpm smoke
```

Then open `/console/signin` in the preview yourself. Dark navy with a white
card is a pass. White with serif type and blue links is a fail, and the fail
is worth reporting rather than working around.

## What changed in this build

Already done. Listed so you know what you are looking at, not as work for the
Agent.

| Area | Change |
|---|---|
| **The page policy** | Chosen from the request path's file extension. Every page this server renders has no extension, so the console, the customer area, the reseller portal and every sign-in page were served `default-src 'none'`, which refuses the page's own stylesheet. The policy is now chosen by who answers the path. |
| **`form-action`** | `'none'` to `'self'`. It does not inherit from `default-src`, so the line above does not fix it, and every page here that does anything does it with a form posting back to itself. With `'none'` nobody can sign in. |
| **The stylesheets** | Fourteen inline `<style>` blocks across the renderers, all of them dropped by the browser. They are now `packages/server/public/backoffice.css` and `marketing.css`, and `tests/page-security-policy.test.ts` fails if one reappears. |
| **Dual control** | Approve and Reject posted to `/v1/console/approvals/...`, which the API owns and which authenticates a bearer key, not a session cookie. Every press answered POLICY_DENIED, so the control the console's design rests on could not be exercised by anybody. They now post to the console's own path, with its CSRF token, and approving a credit also carries it out. |
| **The demonstration** | `docs/demo` holds a fourteen-scene walkthrough for a CRO, CFO, COO and CIO: eleven recordings of the product being used, the script, the API evidence, and the scripts that rebuild all of it. Not needed to run the server; delete it if space is short. |
| **Demo fixtures** | `AWA_DEMO_SEED=1` seeds an approval queue and a scripted qualification, in process, for filming. Refused in a deployment. |

## Verification on this machine, before it was sent

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm test` (vitest) | 1,233 passed, 3 skipped |
| built-in runner under tsx | 1,233 passed, 3 skipped |
| built-in runner on Node alone | 1,233 passed, 3 skipped |
| `node tools/secret-lint.mjs` | clean |
| Every console and customer page, in Chromium | renders styled |
| A second person approving a held credit, through the UI | queue 2 to 1, credit lands |
