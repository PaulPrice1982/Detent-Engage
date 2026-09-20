/**
 * The film's furniture, rendered rather than drawn with drawtext.
 *
 * Every scene gets a 1920x1080 overlay: an opaque bar top and bottom, and a
 * transparent window in between where the recording plays. The evidence
 * scenes, whose subject is a payload rather than a screen, get a full slide
 * instead. Rendering them in a browser keeps the film's typography the same
 * as the player's, which drawtext with a system font would not.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DEMO = path.resolve(__dirname, '..');
const D = JSON.parse(fs.readFileSync(path.resolve(DEMO, 'scenes.json'), 'utf8'));
const EX = JSON.parse(fs.readFileSync(path.resolve(DEMO, 'json/excerpts.json'), 'utf8'));
const OUT = path.resolve(DEMO, 'frames');
fs.mkdirSync(OUT, { recursive: true });

// The one browser on this machine. Downloading another is slow and pointless.
const CHROME = process.env.CHROME
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * The Engage mark, for the closing slide.
 *
 * One seated detent and one outbound vector, from the logo system's family
 * rule. Not the chevron mark in brand/detent-logo.jpg, which stays
 * authoritative for the product itself; brand/brand.md records why the two
 * differ and that somebody has to reconcile them.
 */
const ENGAGE_MARK = (size) => `<svg viewBox="0 0 48 48" width="${size}" height="${size}"
  role="img" aria-label="Detent Engage" xmlns="http://www.w3.org/2000/svg">
  <g transform="translate(1.173 2.374) scale(0.924)">
    <path d="M 9 35 L 40 11" fill="none" stroke="#F4F7FA" stroke-width="4.8" stroke-linecap="butt"/>
    <g fill="#F4F7FA" stroke="#F4F7FA"><g transform="translate(40 11) rotate(-37.747)">
      <path d="M 6.6 0 L -0.6 -4.5 L -0.6 4.5 Z" stroke-width="1.1" stroke-linejoin="round"/>
    </g></g>
    <circle cx="9" cy="35" r="5.4" fill="#2E6BE6"/>
  </g></svg>`;

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const SHELL = (body, extra = '') => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&family=Space+Grotesk:wght@400;600&display=swap">
<style>
:root{--ink:#0B1622;--panel:#111F2F;--edge:#22364C;--amber:#EFA13C;--paper:#F4F7FA;
 --mute:#93A6BB;--slate:#6C819A;--ok:#54C98E;--bad:#E86F6F;
 --display:"Newsreader",Georgia,serif;--body:"IBM Plex Sans",system-ui,sans-serif;
 --mono:"IBM Plex Mono",monospace}
*{box-sizing:border-box;margin:0}
html,body{width:1920px;height:1080px;overflow:hidden}
body{font:400 16px/1.5 var(--body);color:var(--paper)}
${extra}
</style></head><body>${body}</body></html>`;

/* The overlay: bars only, everything between them transparent. */
function overlay(s) {
  return SHELL(`
    <div class="top">
      <span class="dot"></span><span class="brand">Detent Engage</span>
      <span class="num">${String(s.n).padStart(2, '0')} / ${D.scenes.length}</span>
      <h1>${esc(s.title)}</h1>
      <span class="seat">${esc(s.seat)}</span>
    </div>
    <div class="bottom">
      <span class="live">Live</span><span class="cap">${esc(s.caption || '')}</span>
    </div>`, `
    body{background:transparent}
    .top{position:absolute;inset:0 0 auto 0;height:96px;background:var(--ink);
      display:flex;align-items:center;gap:22px;padding:0 48px;
      border-bottom:1px solid var(--edge)}
    .dot{width:11px;height:11px;border-radius:50%;background:var(--amber);flex:none}
    .brand{font:500 21px/1 var(--body);letter-spacing:-.01em;margin-left:-10px}
    .num{font:500 15px/1 var(--mono);color:var(--amber);letter-spacing:.05em;
      padding-left:22px;border-left:1px solid var(--edge)}
    h1{font:400 34px/1 var(--display);letter-spacing:-.015em;flex:1}
    .seat{font:500 12px/1 var(--body);letter-spacing:.14em;text-transform:uppercase;
      color:var(--mute);border:1px solid var(--edge);border-radius:999px;padding:9px 16px}
    .bottom{position:absolute;inset:auto 0 0 0;height:80px;background:var(--ink);
      display:flex;align-items:center;gap:18px;padding:0 48px;border-top:1px solid var(--edge)}
    .live{font:500 12px/1 var(--body);letter-spacing:.15em;text-transform:uppercase;
      color:#0B1622;background:var(--amber);border-radius:4px;padding:7px 11px;flex:none}
    .cap{font:400 21px/1.3 var(--body);color:var(--mute)}`);
}

/* A full slide, for a scene whose evidence is a payload or a table. */
function slide(s, inner) {
  return SHELL(`
    <div class="top">
      <span class="dot"></span><span class="brand">Detent Engage</span>
      <span class="num">${String(s.n).padStart(2, '0')} / ${D.scenes.length}</span>
      <h1>${esc(s.title)}</h1>
      <span class="seat">${esc(s.seat)}</span>
    </div>
    <main>${inner}</main>
    <div class="bottom"><span class="cap">${esc(s.caption || '')}</span></div>`, `
    body{background:var(--ink)}
    .top{position:absolute;inset:0 0 auto 0;height:96px;display:flex;align-items:center;
      gap:22px;padding:0 48px;border-bottom:1px solid var(--edge)}
    .dot{width:11px;height:11px;border-radius:50%;background:var(--amber);flex:none}
    .brand{font:500 21px/1 var(--body);letter-spacing:-.01em;margin-left:-10px}
    .num{font:500 15px/1 var(--mono);color:var(--amber);letter-spacing:.05em;
      padding-left:22px;border-left:1px solid var(--edge)}
    h1{font:400 34px/1 var(--display);letter-spacing:-.015em;flex:1}
    .seat{font:500 12px/1 var(--body);letter-spacing:.14em;text-transform:uppercase;
      color:var(--mute);border:1px solid var(--edge);border-radius:999px;padding:9px 16px}
    main{position:absolute;inset:96px 0 80px 0;padding:34px 48px;overflow:hidden;
      display:flex;gap:34px}
    .bottom{position:absolute;inset:auto 0 0 0;height:80px;display:flex;align-items:center;
      padding:0 48px;border-top:1px solid var(--edge)}
    .cap{font:400 21px/1.3 var(--body);color:var(--mute)}
    .pane{flex:1;min-width:0;background:#050C14;border:1px solid var(--edge);
      border-radius:12px;padding:20px 24px;overflow:hidden}
    .pane h3{font:500 13px/1 var(--mono);color:var(--slate);margin-bottom:14px;
      letter-spacing:.05em}
    pre{font:400 15px/1.55 var(--mono);color:#BFD2E4;white-space:pre-wrap;word-break:break-word}
    pre b{color:var(--amber);font-weight:500}
    pre i{color:var(--ok);font-style:normal}
    table{width:100%;border-collapse:collapse;font-size:19px}
    th{text-align:left;font:500 12px/1 var(--body);letter-spacing:.13em;text-transform:uppercase;
      color:var(--slate);padding:0 18px 14px 0}
    td{padding:13px 18px 13px 0;border-top:1px solid var(--edge);vertical-align:top;color:#CBD9E7}
    td.who{color:var(--paper);font-weight:500}
    td.can::before{content:"\\2713  ";color:var(--ok)}
    td.cannot{color:var(--mute)}
    td.cannot::before{content:"\\2715  ";color:var(--bad)}`);
}

const json = (v) => esc(JSON.stringify(v, null, 1))
  .replace(/&quot;([^&]*?)&quot;:/g, '<b>&quot;$1&quot;</b>:')
  .replace(/: &quot;([^&]*?)&quot;/g, ': <i>&quot;$1&quot;</i>');

const pane = (label, value) => `<div class="pane"><h3>${esc(label)}</h3><pre>${json(value)}</pre></div>`;

(async () => {
  const b = await chromium.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();

  const shoot = async (html, file, transparent) => {
    await page.setContent(html, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${file}.png`, omitBackground: Boolean(transparent) });
    console.log(file);
  };

  for (const s of D.scenes) {
    if (s.clip) await shoot(overlay(s), `overlay-${String(s.n).padStart(2, '0')}`, true);
  }

  const by = (n) => D.scenes.find((s) => s.n === n);
  await shoot(slide(by(6),
    pane('outcome-ledger', EX['outcome-ledger']) + pane('analytics', EX.analytics)), 'slide-06');
  await shoot(slide(by(7),
    pane('session \u2014 text', EX['session-text']) + pane('session \u2014 voice', EX['session-voice'])), 'slide-07');
  await shoot(slide(by(8),
    pane('audit \u2014 this conversation', { entries_total: EX.audit.entries_total, shown: EX.audit.shown }) +
    pane('compliance', EX.compliance)), 'slide-08');

  // The opening and closing cards.
  await shoot(SHELL(`<div class="wrap">
      <div class="mark"><span class="dot"></span><span>Detent Engage</span></div>
      <h1>An end-to-end<br>demonstration</h1>
      <p>For the chief revenue, financial, operating and information officers.</p>
      <p class="fine">Every screen in this film is the running build. Nothing is a mockup.</p>
    </div>`, `body{background:var(--ink);display:grid;place-items:center}
      .wrap{text-align:left;max-width:1100px}
      .mark{display:flex;align-items:center;gap:14px;margin-bottom:38px}
      .dot{width:14px;height:14px;border-radius:50%;background:var(--amber)}
      .mark span{font:500 26px/1 var(--body);letter-spacing:-.01em}
      h1{font:400 96px/1.04 var(--display);letter-spacing:-.025em;margin-bottom:34px}
      p{font:400 27px/1.5 var(--body);color:var(--mute);max-width:26ch}
      .fine{font-size:20px;color:var(--slate);margin-top:26px;max-width:46ch;
        border-left:3px solid var(--amber);padding-left:18px}`), 'card-open');

  await shoot(SHELL(`<div class="wrap">
      <div class="lockup">${ENGAGE_MARK(66)}<div class="wordmark">Detent <span>Engage</span></div></div>
      <h1>What is true,<br>and what is next</h1>
      <div class="two">
        <div><h2>Live and verified</h2><ul>
          <li>A disclosure on every session, spoken or written</li>
          <li>Consent before any attempt to identify a visitor</li>
          <li>Answers only from the tenant's own knowledge</li>
          <li>A tool gate between what the model proposes and what the platform permits</li>
          <li>The spoken channel, metered by the minute and governed by the same pipeline</li>
          <li>The outcome ledger, with replayable evidence</li>
          <li>One tenant per row, enforced by the database</li>
          <li>A hash-chained record of all of it</li></ul></div>
        <div><h2>Not yet</h2><ul>
          <li>The platform's audit chain runs in memory until the durable adapters are wired</li>
          <li>The assistant's wording here is a deterministic script, not a model</li>
        </ul></div>
      </div>
    </div>`, `body{background:var(--ink);display:grid;place-items:center}
      .wrap{max-width:1500px;width:100%}
      .lockup{display:flex;align-items:center;gap:18px;margin-bottom:26px}
      .wordmark{font:600 46px/1 "Space Grotesk",system-ui,sans-serif;letter-spacing:-.02em;
        color:var(--paper)}
      .wordmark span{font-weight:400;color:var(--mute)}
      h1{font:400 72px/1.05 var(--display);letter-spacing:-.025em;margin-bottom:44px}
      .two{display:grid;grid-template-columns:1fr 1fr;gap:62px}
      h2{font:500 13px/1 var(--body);letter-spacing:.15em;text-transform:uppercase;
        color:var(--slate);margin-bottom:20px}
      ul{list-style:none}
      li{font:400 24px/1.5 var(--body);color:#CBD9E7;padding-left:30px;position:relative;
        margin-bottom:12px}
      .two>div:first-child li::before{content:"\\2713";position:absolute;left:0;color:var(--ok)}
      .two>div:last-child li::before{content:"\\2192";position:absolute;left:0;color:var(--amber)}`),
    'card-close');

  await b.close();
})();
