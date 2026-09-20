# Detent brand

## Palette

Taken from the supplied logo.

| Token | Value | Use |
|---|---|---|
| `--detent-ink` | `#0F1B2A` | Primary ground. The logo's field. |
| `--detent-amber` | `#EFA13C` | The mark's dot. Accent only — never a large area. |
| `--detent-paper` | `#FFFFFF` | Wordmark, and text on ink. |
| `--detent-slate` | `#5B6B7F` | Secondary text on paper. |
| `--detent-line` | `#E3E8EF` | Rules and borders on paper. |
| `--detent-ink-2` | `#1B2A3D` | Raised surfaces on ink. |

## The mark

A filled amber dot followed by a left-pointing chevron, then the wordmark in
white on ink. The dot and chevron together read as a detent: the notch a
mechanism settles into. That is the product argument in a logo — the assistant
stops at a defined position rather than running on.

Reproduced in the widget as an inline SVG so it needs no network fetch and
survives the host page's Content Security Policy.

## Applying it

- Amber is an accent, never a background. It marks one thing at a time.
- The launcher is ink with a white wordmark; the amber dot is the only colour.
- The `AI` badge on the launcher is never amber. Article 50 disclosure is not
  decoration and must not read as a brand flourish.

## Two marks, and which one wins

There are two Detent identities in circulation and they are not variants of
each other. This section exists so the next person does not have to work
that out again.

**The shipped mark, and the authority.** `detent-logo.jpg` above: amber dot,
left-pointing chevron, ink `#0F1B2A`. It is what the widget, the console,
the customer app and the marketing site render, and it stays the source of
truth for the product. A change to it is a change to every screen.

**The logo canvas.** A separate design canvas, titled "Detent Recover —
Logo", proposes a different system: a module mark is one seated detent plus
a vector, where only the vector's behaviour changes. Recover's line falls,
seats on a gold ball and returns above where it started; Engage's leaves the
same seat on one outbound vector and does not come back. Different symbol,
different gold (`#CE8A1F`), different ink (`#0D1117`), and Space Grotesk
rather than the product's faces. The canvas itself notes that the palette,
the typeface and the Engage sibling were proposed rather than matched,
because no Engage artwork existed to work from.

**The decision.** The shipped chevron mark remains authoritative and the
canvas is superseded: nothing in the product is to be rebuilt from it.

**The one exception**, taken deliberately: the films sign off with the
canvas's Engage mark, drawn inline in `docs/demo/capture/cards.cjs` and
`docs/demo/capture/frames.cjs`. It was chosen over the Recover lockup
because these are Engage films and Recover is a separate offering, and over
the chevron because the sign-off is where the sub-brand reads.

**The consequence, stated rather than discovered.** A viewer who watches a
film and then opens the website sees two different symbols. That is a real
inconsistency and it is not resolved by either file: somebody has to decide
which identity Detent actually has, and until they do, this is where the
seam is.
