# Replit prompt: the spoken assistant

**Budget: 2 Agent requests.** One to update and run, one to look at the page.
If the first does not produce a green run, drop to the Shell and follow "If
the Agent stalls" at the bottom. The Shell is free; the Agent is not.

What this build changes, in one line: **the assistant can speak, and until
now it could not.**

`packages/voice` held 730 lines of governed voice session, a realtime
provider and a port, and was imported by nothing but its own test file. The
platform metered voice minutes, the console sold concurrent voice calls, the
tenant config carried a separate voice disclosure with its own validation,
and the knowledge base answered "can it speak?" with "both". Everything
around the feature existed except the feature.

It is wired now, on a turn-shaped surface beside the realtime one, under the
same rule: the synthesiser is handed text that has already been through the
governed pipeline and it utters that text. It is given no history, no
question and no tools.

**This build is verified by ear as well as by test.** The check that matters
is pressing the microphone in the preview and hearing the disclosure before
the microphone arms. A test suite cannot hear that, which is exactly the
class of thing that shipped unnoticed here before.

---

```
This repository is COMPLETE. It typechecks clean and all 1,254 tests pass
under each of its three runners. Do NOT write, refactor, reformat or
"improve" any source, test, dependency, stylesheet or migration. Your only
job is to update it, run it, listen to one page, and report what happened.

STEP 1, update the checkout.

Run, in the Shell:

    git pull && pnpm install

Expected: pnpm reports up-to-date or installs packages, and exits 0.

If this is not a git checkout, use the supplied zip instead. This build adds
files and does not move code between them, so extracting over the top is
safe:

    unzip -o detent-engage-replit.zip
    pnpm install

Two zips exist and they are not interchangeable.
`detent-engage-replit.zip` is 2.6 MB and is the one to use here: everything
the build and the tests need. `detent-agentic-website-assistant.zip` is
33 MB and is the full archive, which additionally carries the
demonstration's recordings, screenshots and film frames. Nothing on Replit
reads those, and they are 38 of its 43 MB.

NOTE: never run `pnpm install --no-optional`. It breaks esbuild's platform
binary, which tsx needs, and the failure looks like a broken repository.

STEP 2, verify.

    pnpm typecheck

Expected: two lines, the pnpm banner and `tsc --build --force`, then nothing.
Any TypeScript error means the checkout is incomplete. Re-run STEP 1. Do not
"fix" a type error.

    pnpm test

Expected final lines, one shape or the other depending on whether vitest is
installed. Both run the same files and both must report the same counts:

    Test Files  71 passed | 2 skipped (73)          <- vitest
         Tests  1254 passed | 3 skipped (1257)

    Test files  73                                   <- built-in runner
    Tests       1254 passed, 3 skipped

Either is a pass. The 3 skipped tests want a PostgreSQL and a Redis and skip
themselves without one, which is correct on Replit and is not a failure.

If a test fails, STOP and report the failing test name and its output
verbatim. Do not delete, skip, loosen or rewrite a test to make the suite
pass. tests/voice-wiring.test.ts is the new one; a failure there is a real
regression in the spoken path, not a flake.

STEP 3, secrets, then run it.

In the Secrets pane (the padlock), you need the two you already have:

    DETENT_CONSOLE_PASSWORD   12 characters or more
    DETENT_SESSION_SECRET     32 characters or more

And, for voice, two more:

    AWA_FEATURE_SPOKEN_VOICE  1
    DETENT_VOICE_API_KEY      the speech vendor key

DETENT_VOICE_ID is optional and picks the voice. Left unset it uses the
English assistant voice the product ships with.

Voice is OPTIONAL. Without DETENT_VOICE_API_KEY the server runs exactly as
before and serves the text assistant, which is the whole product and not a
degraded one. If you do not have the key, skip to STEP 5.

Then:

    pnpm serve

Expected on stdout, with one line that is new in this build:

    voice            elevenlabs, speaking

Two other things it can say, and what each means:

    voice            text only (AWA_FEATURE_SPOKEN_VOICE=1 to offer it)
        The flag is off. Correct if you are not using voice.

    voice            OFFERED BUT SILENT; set DETENT_VOICE_API_KEY
        The flag is on with nothing behind it. Fix this before showing
        anyone: the panel would offer a microphone that produces no sound.

Every other line of the boot banner is unchanged.

The server binds 0.0.0.0. A loopback bind is unreachable from the Replit
preview proxy and shows as "running, but the preview isn't ready". Do not
change it.

STEP 4, the check this build exists for. LISTEN to the page.

Open the preview at the widget panel, in Chrome. Firefox and Safari do not
implement the browser speech recogniser this uses, and the panel correctly
hides the microphone there rather than offering one that does nothing.

Expected, in this order:

  1. A microphone button to the left of the message box.
  2. Press it. The line under the heading changes to the SPOKEN disclosure,
     "Just so you know, you are speaking with an AI assistant", and you hear
     it read aloud.
  3. Only when it has finished does the button turn solid and the status
     line say "Listening. Press the microphone to stop."
  4. Say something. The answer appears as text AND is spoken.
  5. The text box still works the whole time.

If the microphone arms BEFORE the disclosure finishes, STOP and report it.
That order is the compliance claim, not a nicety.

If there is no microphone at all, the deployment is not offering voice.
Check the boot banner line from STEP 3.

STEP 5, confirm it in the Shell as well, then STOP.

    curl -s -X POST $URL/v1/sessions \
      -H "authorization: Bearer $WIDGET_KEY" \
      -H "origin: $YOUR_REGISTERED_ORIGIN" \
      -H 'content-type: application/json' \
      -d '{"jurisdiction":"UK","modality":"voice"}' | head -c 300

Expected: a JSON object whose "disclosure" is the spoken wording, with
"voice_available": true and an "audio" field of base64. On a deployment
without voice, "voice_available" is false and there is no "audio", which is
also correct.

Report the boot banner's voice line, the last two lines of pnpm test, and
what you heard in STEP 4. Then STOP. There is nothing else in this build.
```

---

## If the Agent stalls

Everything above except STEP 4 is a Shell command. Run them yourself in this
order and you will spend nothing: `git pull && pnpm install`, `pnpm
typecheck`, `pnpm test`, set the secrets in the padlock pane, `pnpm serve`.
STEP 4 needs a person with a browser and speakers, and no Agent request buys
you that.

## What must not be touched

Source, tests, dependencies, migrations and the CSP. In particular:

- **`assertApprovedForSpeech`** in `packages/voice/src/speech-synthesiser.ts`
  and **`Platform.speakApproved`**. They are the reason a spoken word cannot
  come from anywhere but the governed pipeline. An Agent that finds the
  `approved` parameter redundant and removes it has removed the safety
  argument for having voice at all.
- **The order in `panel.js`**: the disclosure is awaited, then the microphone
  is armed. Do not make it concurrent to save a second.
- **`MAX_SPOKEN_CHARS`**. It is the last gate before a per-character vendor
  bill.

## One thing in this build that needs a person, not a machine

`docs/demo/PARTNER-CUT.md` still records the commission conflict: the
marketing site's `partners.html` publishes two flat tiers for the life of the
customer, and `packages/reseller/src/bands.ts` defaults to four bands rising
with annualised book value. Those are two different programmes. Do not
"reconcile" them by editing `bands.ts`; the code may be right and the page
wrong, and a pull request is the wrong room to decide a commercial question.
