# The Detent Engage demonstration

Everything needed to give the end-to-end walkthrough to a CRO, CFO, COO and
CIO, and everything needed to rebuild it from the product rather than from a
slide deck.

| File | What it is |
|---|---|
| `player.html` | The demonstration. Fourteen scenes, keyboard-driven, plays the footage, the narration and the spoken conversation. Open it directly; no server needed. |
| `clips/` | Eleven recordings of the product being used: the cursor moves, the form is typed, the pages respond. Not screenshots. |
| `SCRIPT.md` | The script, with the reaction each seat has to have and what each scene must land. |
| `scenes.json` | The running order as data: clips, shots, captions, narration, the conversation. |
| `shots/` | Thirty screenshots. Poster frames for the films, and the fallback for any clip a browser will not decode. |
| `json/` | The API responses shown in scenes 8, 11 and 12, exactly as the platform returned them. |
| `audio/README.md` | Where the voiceover clips are and what to name them. |
| `capture/` | The scripts that produced all of it, so it can be rebuilt. |

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
2. **The assistant's voice** is an ElevenLabs voice standing in for the OpenAI
   Realtime voice being wired into the production build. The words it speaks
   are the words the governed pipeline produced.
3. **The narrator** is a voice model, and is never the product. Scene 11 says
   so out loud.

Scene 14 lists the remaining gaps, which is deliberate: an audience that is
told the gaps believes the rest.

## Playing it

Chrome or Edge. The clips are VP8 in WebM, which is what the bundled encoder
produces; Safari plays them from version 14 on macOS, and the player falls
back to the screenshots if a browser refuses one.
