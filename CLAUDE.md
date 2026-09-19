# Working agreement — Detent Agentic Website Assistant

## Standing instruction: deliver a zip and a Replit prompt on every change

**This applies to every change, without being asked again.** After any change is
committed and pushed, produce both:

1. `dist-zip/detent-agentic-website-assistant.zip` — the full source, built from a
   pristine `git ls-files` copy so no build artefact can leak in.
2. `REPLIT-PROMPT.md` — rewritten for *that specific change*, not a generic
   rebuild prompt.

Send both to the user. Do not wait to be asked.

### The objective: minimise Replit credit burn without compromising the build

Replit charges per **Agent** request. The Shell is free. So every prompt written
here is judged on one question: how few Agent requests does it take to get from
the current state to verified green?

Rules, in priority order:

1. **Prefer the Shell over the Agent.** If a step can be a shell command, it must
   be a shell command. An update the user can apply with `git pull && pnpm test`
   costs nothing and should be offered first, with the zip as the fallback for
   when the Replit copy is not a git checkout.
2. **Never let the Agent think it is building.** It must be told, in the first
   line, that the repository is finished, typechecked and tested, and that it is
   there to run it, not to write it. An Agent that decides to refactor
   `packages/core` costs twice: once to do it, once to undo it.
3. **State the expected output of every command.** An Agent that cannot tell
   success from failure will retry, and every retry is a request.
4. **Name what must not be touched.** Source, tests, dependencies and migrations
   are off limits.
5. **Give an explicit stop condition.** "Report the output and STOP." Without it
   the Agent keeps going and keeps charging.
6. **Never buy a green test run with a weakened test.** Credit efficiency never
   justifies deleting, skipping or loosening a test. If the suite fails, the
   Agent stops and reports; it does not "fix" the suite.
7. **State a realistic request budget** and the point at which the user should
   drop back to the Shell.

### Build the zip like this

Verify in a throwaway copy, never in place — an in-place `tsc --build` leaves
`dist/` and `.tsbuildinfo` behind and they end up in the zip. Then zip from a
second copy populated only from `git ls-files`. Confirm the file count and that
no `dist/`, `node_modules/` or `*.tsbuildinfo` is present before sending.

## Engineering constraints that do not change

- Development API keys are printed once at boot and stored only as SHA-256
  digests. Never plaintext, never in a log.
- The platform never holds a card number. PSP token references only.
- Credentials never enter model context, a prompt, or a log line.
- Postgres RLS binding uses `SET LOCAL app.tenant_id`, never a plain `SET`: a
  plain `SET` survives the transaction back into the pooled connection and
  becomes the next request's tenant context.
- Never run `pnpm install --no-optional`. It breaks esbuild's platform binary,
  which tsx needs.
- The server binds `0.0.0.0`. A loopback bind leaves the process healthy and
  unreachable, which a preview proxy reports as "running, but the preview isn't
  ready".
- One test file per CI gate. A test is changed only when the test is wrong, and
  the reason is stated.
