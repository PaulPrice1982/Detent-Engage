# The voiceover

All twenty-four clips are here: fourteen scenes of narration and the ten
spoken lines of the visitor conversation. They were generated on, and read
back from, this flow:

**https://elevenlabs.io/app/flows/3U5VbEweLStlvcZGC0fJ**

Two ElevenLabs connections are available to this project and they do not
carry the same permissions. The first can generate speech and cannot read a
generation back, which is what `flows` and `speech_history_read` scope buys;
the second can do both. Reading a generation back needs the second. Worth
knowing before anyone concludes the files are unreachable.

## Voices

| Role | Voice | Why |
|---|---|---|
| Narrator | Jim Executive — Authoritative, British and Warm | A British executive register for a British C-suite. The narrator, never the product. |
| Assistant | Eryn — AI Assistant, Customer Service | Warm, neutral American, built for AI assistants. Stands in for the OpenAI Realtime voice Tony and Tom are wiring into the production build. |
| Visitor | Ali — Everyday British (London) Male | Dan Harper, fleet manager. Unpolished on purpose, so he is never mistaken for the narrator. |

## Filenames

Download each clip and save it here under exactly these names. The player
looks for them at these paths and shows a notice for any that is missing.

### Narration, in order

| File | Scene |
|---|---|
| `01-claim.mp3` | 1 — The claim |
| `02-setup.mp3` | 2 — Setting up an account |
| `03-contract.mp3` | 3 — What that gives you |
| `04-pricing.mp3` | 4 — Pricing that does not break the base |
| `05-install.mp3` | 5 — Installation |
| `06-conversation.mp3` | 6 — A visitor arrives |
| `07-consent.mp3` | 7 — Consent, not capture |
| `08-outcome.mp3` | 8 — The outcome |
| `09-dual-control.mp3` | 9 — Nobody moves money alone |
| `10-roles.mp3` | 10 — Who can do what |
| `11-voice.mp3` | 11 — Voice: what is real, what is a stand-in |
| `12-audit.mp3` | 12 — The record |
| `13-personas.mp3` | 13 — Who touches it |
| `14-close.mp3` | 14 — What is true, and what is next |

### The spoken conversation, scene 6

| File | Speaker | First words |
|---|---|---|
| `conv-00-disclosure.mp3` | Assistant | "Just so you know, you are speaking with…" |
| `conv-01-visitor.mp3` | Dan Harper | "We run forty vans out of two depots…" |
| `conv-02-assistant.mp3` | Assistant | "Replacing a telematics contract at renewal…" |
| `conv-03-visitor.mp3` | Dan Harper | "Forty vehicles, and we'd want driver behaviour…" |
| `conv-04-assistant.mp3` | Assistant | "Forty vehicles with driver behaviour scoring…" |
| `conv-05-visitor.mp3` | Dan Harper | "There's a ninety day notice period…" |
| `conv-06-assistant.mp3` | Assistant | "Then the decision has to be made before…" |
| `conv-07-visitor.mp3` | Dan Harper | "It's my call. I run the fleet." |
| `conv-08-assistant.mp3` | Assistant | "Useful, thank you. On what you have told me…" |
| `conv-09-assistant.mp3` | Assistant | "Booked. You will get a confirmation…" |

Dan Harper reading out his own email address has no clip: an address read
aloud adds nothing and dates the demonstration to one fictional domain.

## Re-recording a line

Open the flow, find the node, and regenerate it with a different voice or a
different take. Every node on that canvas is editable and the script text for
each one is in `docs/demo/SCRIPT.md`, so a line can be rewritten and
regenerated without touching the player.

### The single-read cuts

| File | Film | Voice |
|---|---|---|
| `promo.mp3` | `detent-engage-promo.mp4` | Narrator |
| `reseller.mp3` | `detent-engage-reseller.mp4` (the partner cut) | Narrator |

One continuous read each, not one file per scene. The pictures are cut to the
read, so re-recording either line re-times its film and nothing else. The
partner read was generated on its own flow:
**https://elevenlabs.io/app/flows/ECGVRny6g72xfC80q4Cm**

