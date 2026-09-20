# Replit prompt: the partner cut

**Budget for this build: zero Agent requests.**

Read that line again before you paste anything. This build changes
`docs/demo/` and nothing else: a new film for resellers, the script that cuts
it, and two documentation files. **No source, no test, no dependency, no
migration and no configuration was touched.** Nothing the server runs is
different, so there is nothing for the Agent to do, and an Agent asked to
"apply" a documentation change will read the repository, form an opinion
about it, and bill you for both.

Do this in the Shell, which is free:

```sh
git pull
```

That is the whole update. If you want to confirm nothing moved under the
product:

```sh
git diff --stat HEAD~1 -- packages tests tools db
```

Expected output: **nothing at all**, and exit 0. A single line of output here
means something other than this build landed in the same pull, and you should
read it before running anything.

If your Replit copy is not a git checkout, use the supplied zip. Unlike the
previous build, this one moves no code between files, so extracting over the
top is safe and the `rm -rf` step is not needed:

```sh
unzip -o detent-agentic-website-assistant.zip
```

Never run `pnpm install --no-optional`. It breaks esbuild's platform binary,
which tsx needs, and the failure looks like a broken repository.

## If you want to prove the build is still green

Optional, still free, still no Agent:

```sh
pnpm typecheck && pnpm test
```

Expected final lines, one shape or the other depending on whether vitest is
installed. Both run the same files and both must report the same counts:

```
Test Files  70 passed | 2 skipped (72)          <- vitest
     Tests  1233 passed | 3 skipped (1236)

Test files  72                                   <- built-in runner
Tests       1233 passed, 3 skipped
```

Either is a pass. The 3 skipped tests want a PostgreSQL and a Redis and skip
themselves without one, which is correct on Replit and is not a failure.

If a test fails, STOP and report the failing test name and its output
verbatim. Do not delete, skip, loosen or rewrite a test to make the suite
pass. It cannot be this build: this build changed no code.

## What actually changed, for the record

- `docs/demo/detent-engage-reseller.mp4`, a 1 minute 46 film for a web
  agency that already builds and hosts client websites, plus a 1080x1920
  version for a feed. Both are rebuilt from source and are not in the
  repository; `docs/demo/*.mp4` is in `.gitignore`.
- `docs/demo/reseller.json`, the film as data: beats, cue points, captions.
- `docs/demo/PARTNER-CUT.md`, which says who the film is for, gives its full narration, and explains
  why it names no commission rate.
- `docs/demo/capture/cards.cjs`, which renders the cards and lower thirds. New to
  the repository; it had been living in a scratch directory.
- `docs/demo/capture/promo.mjs`, which now takes its manifest as an argument, so
  the promotional cut and the partner cut are two manifests rather than two
  copies of a script. It also fits and pads the vertical version instead of
  centre-cropping it, which had been cutting the first and last word off
  every headline.

## The one thing in this build that needs a person, not a machine

`docs/demo/PARTNER-CUT.md` records a conflict nobody should ship past:

- The marketing site's `partners.html` publishes **two flat tiers**, paid
  from the first client, on everything the client pays, for the life of the
  customer.
- `packages/reseller/src/bands.ts` defaults to **four bands** that rise with
  annualised book value, the rate applying to the whole period's revenue once
  a band is reached.

Those are two different programmes, not two wordings of one. A partner who
reads the page and is paid by the code is paid the wrong amount, and the
difference is recoverable from us rather than from them. The film states no
rate for exactly this reason.

**This is not a code change to make.** Do not "reconcile" the two by editing
`bands.ts`: the numbers in the code may be the correct ones and the page
wrong, and picking a winner in a pull request decides a commercial question
in the wrong room. Raise it, and wait for the answer.

## Rebuilding the film, if you ever need to

Not on Replit, and not with the Agent. It wants ffmpeg and a browser:

```sh
cd docs/demo/capture && npm install
node cards.cjs ../reseller.json
node promo.mjs reseller.json
```

## Report and STOP

Reply with the output of `git diff --stat HEAD~1 -- packages tests tools db`,
which should be empty, and, if you ran them, the last two lines of
`pnpm test`. Then STOP. There is nothing else in this build to do.
