/**
 * The furniture for a single-read cut: full cards and lower thirds.
 *
 *   node docs/demo/capture/cards.cjs [manifest.json]
 *
 * Reads the same manifest promo.mjs reads and writes into the frames
 * directory the manifest names, so the promotional cut and the partner cut
 * cannot overwrite each other.
 *
 * Deliberately not the walkthrough's. A walkthrough carries a title bar and a
 * scene number because somebody is being taken through something in order. A
 * promotional cut has one job for the first second, and a header competing
 * with the hook loses it. So: full-bleed cards with type big enough to read
 * on a phone in a feed, and a single lower third over the footage.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DEMO = path.resolve(__dirname, '..');
const MANIFEST = process.argv[2] || 'promo.json';
const D = JSON.parse(fs.readFileSync(path.resolve(DEMO, MANIFEST), 'utf8'));
const OUT = path.resolve(DEMO, D.frames || 'frames/promo');
fs.mkdirSync(OUT, { recursive: true });

// The one browser on this machine. Downloading another is both slow and
// pointless: nothing here needs a version the bundled build has not got.
const CHROME = process.env.CHROME
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/&lt;br&gt;/g, '<br>');

/**
 * The Detent Engage lockup: the supplied artwork, not a redraw.
 *
 * brand/detent-engage-wordmark-alpha.png, embedded as a data URI because the card
 * pages are rendered from a string with no base URL, so a relative path
 * would resolve to nothing and the frame would ship with a hole in it.
 *
 * It is the amber chevron with "Detent" in white and "Engage" in amber. Its
 * amber is #EFA13C, which is the repository palette to the digit.
 *
 * Its ground is keyed out rather than kept. The supplied artwork sits on
 * #0B1420 and the films on #0B1622: near enough to look identical in
 * isolation, and far enough apart that the logo showed as a faint rectangle
 * on the card behind it.
 *
 * An earlier cut used a blue ball-and-vector mark from a design canvas. That
 * canvas was exploratory and its Engage sibling was labelled "proposed".
 * This is the real one. brand/brand.md records the rest.
 */
const ENGAGE_LOCKUP = (width) =>
  `<img class="lockup-img" style="width:${width}px;height:auto;display:block" src="data:image/png;base64,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" alt="Detent Engage">`;

const SHELL = (body, extra) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500&family=IBM+Plex+Sans:wght@400;500;600&family=Space+Grotesk:wght@400;600&display=swap">
<style>
:root{--ink:#0B1622;--amber:#EFA13C;--paper:#F4F7FA;--mute:#93A6BB;
 --display:"Newsreader",Georgia,serif;--body:"IBM Plex Sans",system-ui,sans-serif}
*{box-sizing:border-box;margin:0}
html,body{width:1920px;height:1080px;overflow:hidden}
body{font:400 16px/1.5 var(--body);color:var(--paper)}
${extra}</style></head><body>${body}</body></html>`;

/**
 * A full card. The type is the picture.
 *
 * The last card is the exception: it signs off with the mark and the
 * wordmark rather than setting the product's name in the body serif, which
 * is a caption of a logo rather than a logo.
 */
const card = (b) => b.card === 'end' ? endCard(b) : SHELL(`
  <div class="wrap">
    <div class="mark"><span class="dot"></span><span>Detent Engage</span></div>
    <h1>${esc(b.big)}</h1>
    ${b.small ? `<p>${esc(b.small)}</p>` : ''}
  </div>`, `
  body{background:var(--ink);display:grid;place-items:center;padding:0 130px}
  .wrap{max-width:1500px}
  .mark{display:flex;align-items:center;gap:13px;margin-bottom:40px;opacity:${b.card === 'end' ? 0 : 1}}
  .dot{width:13px;height:13px;border-radius:50%;background:var(--amber)}
  .mark span{font:500 23px/1 var(--body);letter-spacing:-.01em;color:var(--mute)}
  h1{font:400 ${b.card === 'end' ? 130 : 88}px/1.08 var(--display);letter-spacing:-.025em;
    text-wrap:balance}
  p{font:400 ${b.card === 'end' ? 34 : 38}px/1.4 var(--body);color:var(--mute);margin-top:32px;
    max-width:30ch}
  ${b.card === 'end' ? '.wrap{text-align:center;margin:0 auto}p{margin-left:auto;margin-right:auto}' : ''}`);

/** The sign-off: the mark, the wordmark, and one line under it. */
const endCard = (b) => SHELL(`
  <div class="wrap">
    ${ENGAGE_LOCKUP(820)}
    ${b.small ? `<p>${esc(b.small)}</p>` : ''}
  </div>`, `
  body{background:var(--ink);display:grid;place-items:center;padding:0 130px}
  /* The artwork carries its own ink ground, so nothing is set behind it and
     nothing is drawn beside it. A wordmark with a second wordmark typeset
     next to it is the mistake this replaced. */
  .wrap{text-align:center}
  .lockup-img{margin:0 auto}
  p{font:400 32px/1.4 var(--body);color:var(--mute);margin:40px auto 0;max-width:30ch}`);

/** A lower third: one sentence, over the footage, with room to breathe. */
const lower = (text) => SHELL(`<div class="bar"><p>${esc(text)}</p></div>`, `
  body{background:transparent}
  .bar{position:absolute;inset:auto 0 0 0;padding:0 96px 78px;
    background:linear-gradient(to top,rgba(11,22,34,.94) 0%,rgba(11,22,34,.84) 55%,rgba(11,22,34,0) 100%);
    padding-top:190px}
  p{font:500 46px/1.28 var(--body);letter-spacing:-.012em;max-width:34ch;text-wrap:balance;
    border-left:5px solid var(--amber);padding-left:28px}`);

(async () => {
  const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const page = await (await b.newContext({ viewport: { width: 1920, height: 1080 } })).newPage();
  const shoot = async (html, name, transparent) => {
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.waitForTimeout(420);
    await page.screenshot({ path: `${OUT}/${name}.png`, omitBackground: Boolean(transparent) });
    console.log(name);
  };
  for (let i = 0; i < D.beats.length; i += 1) {
    const beat = D.beats[i];
    const n = String(i).padStart(2, '0');
    if (beat.card) await shoot(card(beat), `beat-${n}`, false);
    else if (beat.lower) await shoot(lower(beat.lower), `beat-${n}`, true);
  }
  await b.close();
})();
