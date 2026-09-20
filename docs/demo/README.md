# The Detent Engage demonstration

Everything needed to give the end-to-end walkthrough to a CRO, CFO, COO and
CIO, and everything needed to rebuild it from the product rather than from a
slide deck.

## Scope: Engage, and only Engage

Ten scenes about the assistant that meets a visitor on a customer's website,
qualifies them under governance, and hands over an outcome with the evidence
attached.

It does **not** cover **Detent Recover**, which is a separate offering:
contract monetisation, excess-use recovery, renewal and notice windows. An
earlier cut bled into it, selling Recover's proposition off Engage's screens,
and those scenes are gone. The back-office money surfaces are also out,
pricing, dual control and the money roles, because they are platform rather
than Engage.

| File | What it is |
|---|---|
| `player.html` | The demonstration. Ten scenes, keyboard-driven, plays the footage, the narration and the spoken conversation. Open it directly; no server needed. |
| `clips/` | Seven recordings of the product being used: the cursor moves, the form is typed, the pages respond. Not screenshots. |
| `SCRIPT.md` | The script, with the reaction each seat has to have and what each scene must land. |
| `scenes.json` | The running order as data: clips, shots, captions, narration, the conversation. |
| `shots/` | Fourteen screenshots. Poster frames for the films, and the fallback for any clip a browser will not decode. |
| `json/` | The API responses shown in scenes 8, 11 and 12, exactly as the platform returned them. |
| `audio/README.md` | Where the voiceover clips are and what to name them. |
| `capture/` | The scripts that produced all of it, so it can be rebuilt. |
| `PARTNER-CUT.md` | The partner cut: who it is for, its narration, and why it states no commission rate. |
| `reseller.json` | The partner cut as data: beats, cue points and lower thirds. |
| `promo.json` | The promotional cut as data, in the same shape. |

## Rebuilding it

See `capture/README.md`. It holds no credentials; every password comes from
the environment.

## What is staged and what is not

Nothing in `clips/`, `shots/` or `json/` is a mockup. Every screen was
recorded or photographed from the running build against real PostgreSQL, and
every payload is what the platform actually returned.

The films are a real browser driving the real product: the navigation, the
typing and the responses are the product's own. What the capture script adds
is the person, because a recorded browser has no visible cursor, input
appears instantaneously and scrolling jumps. Only the hand is simulated.

Three things are not the production article, and each is named in the
demonstration where it appears rather than in a footnote:

1. **The assistant's wording** came from the deterministic reference provider,
   because this build was recorded without a model key. The governance path,
   disclosure, consent gate, tool gate, outcome ledger, is the real one; the
   phrasing is fixed text in `packages/server/src/demo-seed.ts`.
2. **The assistant's voice** is the product's own. The panel captures, the
   governed pipeline answers, the reply is synthesised and played, the voice
   minute is metered and the audit entry is written. What the demonstration
   build does differently is serve those particular lines from recordings
   made by the same voice rather than calling the vendor again each time,
   exactly as it serves a scripted conversation in place of a model.
3. **The narrator** is a voice model, and is never the product. Scene 11 says
   so out loud.

Scene 14 lists the remaining gaps, which is deliberate: an audience that is
told the gaps believes the rest.

## Playing it

Chrome or Edge. The clips are VP8 in WebM, which is what the bundled encoder
produces; Safari plays them from version 14 on macOS, and the player falls
back to the screenshots if a browser refuses one.

## The four cuts

| Cut | Audience | Length | Built by |
|---|---|---|---|
| `detent-engage-demo.mp4` | CRO, CFO, COO and CIO, in one room | 8 min 48 | `capture/stitch.mjs` from `scenes.json` |
| `detent-engage-promo.mp4` | A CRO or founder who already has a chat agent | 58 sec | `capture/promo.mjs promo.json` |
| `detent-engage-reseller.mp4` | A web agency that builds and hosts client sites | 2 min 12 | `capture/promo.mjs reseller.json` |
| `detent-engage-voice.mp4` | Anyone who asks whether it really speaks | 2 min 15 | `capture/voice-film.mjs` |

The walkthrough gives every scene its own narration and lets the scene last
as long as the narration. The other two have one continuous read and cut the
pictures to it, which is why they share an assembler and differ only by
manifest. Each has a 1080x1920 version for a feed, fitted and padded rather
than centre-cropped: a 9:16 crop of a 16:9 frame keeps the middle 607 pixels
and took the first and last word off every headline.

**Before showing the partner cut to anyone who could sign, read the
commission-rate warning in `PARTNER-CUT.md`.** The rate published on the
marketing site and the default bands in `packages/reseller/src/bands.ts` are
two different programmes.

## The spoken assistant

`detent-engage-voice.mp4` is the assistant holding the conversation out loud,
and all three cuts that are not the walkthrough now carry it. Three voices,
so a listener can tell who is talking: the narrator, the visitor, and the
assistant's own English voice.

What is filmed is the product. The panel is the shipping one, the server is
the running build on PostgreSQL, the microphone control is the one a visitor
presses, the voice disclosure is spoken before capture is armed, and the
voice minute is metered from the duration that actually played. Two things
the container cannot supply and the capture script does:

- **A microphone.** There is no person and no sound card, so the browser's
  speech recogniser is fed the visitor's lines as transcripts. That is what
  the recogniser would hand the panel after hearing them, and it is the same
  substitution already made for the cursor.
- **A soundtrack.** A recorded page has no audio track, so the take writes a
  cue sheet of what was spoken and when, and the mix is laid on afterwards
  from the same recordings the panel fetched and played.

`capture/voice.cjs` films it and `capture/voice-film.mjs` cuts it.

