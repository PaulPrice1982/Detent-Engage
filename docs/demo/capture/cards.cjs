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

const SHELL = (body, extra) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{--ink:#0B1622;--amber:#EFA13C;--paper:#F4F7FA;--mute:#93A6BB;
 --display:"Newsreader",Georgia,serif;--body:"IBM Plex Sans",system-ui,sans-serif}
*{box-sizing:border-box;margin:0}
html,body{width:1920px;height:1080px;overflow:hidden}
body{font:400 16px/1.5 var(--body);color:var(--paper)}
${extra}</style></head><body>${body}</body></html>`;

/** A full card. The type is the picture. */
const card = (b) => SHELL(`
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
