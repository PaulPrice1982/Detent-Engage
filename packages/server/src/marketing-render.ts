import { seoTags } from './seo.js';
import { brandMark } from './site-html.js';
import { renderSections, escapeHtml, type Page } from '@detent/awa-cms';
import { format, type PlanVersion } from '@detent/awa-billing';

/**
 * The marketing site's shell: brand, navigation, styles, and the assistant.
 *
 * The shell is fixed and the sections are authored. An author controls what a
 * page says and in what order; they do not control typography, spacing or
 * colour, because those are the brand and a page that gets them wrong damages
 * it more than a missing page would.
 */

export interface ShellInput {
  readonly page: Page;
  readonly navigation: readonly { label: string; href: string }[];
  readonly appBaseUrl: string;
  readonly plans: readonly PlanVersion[];
  readonly assistant?: {
    readonly apiBaseUrl: string;
    readonly publicKey: string;
    readonly panelUrl: string;
  };
  /** Set when rendering an unpublished draft for review. */
  readonly previewOf?: string;
  /**
   * The address this page is indexed under.
   *
   * One canonical origin whatever hostname served the request, because the app
   * answers on its platform hostname as well as its custom domain and two
   * copies of a page compete with each other.
   */
  readonly canonicalOrigin?: string;
  readonly imageUrl?: string;
}

const STYLES = `
:root{--ink:#0F1B2A;--ink-2:#1B2A3D;--amber:#EFA13C;--paper:#fff;--slate:#5B6B7F;
 --mute:#A9B7C8;--line:#E3E8EF}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
 font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;
 -webkit-font-smoothing:antialiased}
.wrap{max-width:1080px;margin:0 auto;padding:0 24px}
header{background:var(--ink);color:var(--paper)}
header .wrap{display:flex;align-items:center;gap:14px;height:68px}
.brand{display:flex;align-items:center;gap:10px;font-weight:650;font-size:19px;
 color:var(--paper);text-decoration:none}
.dot{width:10px;height:10px;border-radius:50%;background:var(--amber)}
.chev{color:var(--amber)}
nav{margin-left:auto;display:flex;gap:4px;align-items:center;flex-wrap:wrap}
nav a{color:var(--mute);text-decoration:none;padding:8px 13px;border-radius:7px;font-size:14.5px}
nav a:hover{color:var(--paper);background:var(--ink-2)}
nav a.cta{background:var(--amber);color:var(--ink);font-weight:650}
nav a.cta:hover{background:#f5b25c}
section{padding:72px 0;border-bottom:1px solid var(--line)}
section.tint{background:#F7F9FC}
section.ink{background:var(--ink);color:var(--paper);border-bottom:0}
section.ink .lede,section.ink .kicker+h2{color:var(--mute)}
section.ink .lede p{color:var(--mute)}
section.centred{text-align:center}
.hero{padding:80px 0 90px}
.hero h1{font-size:clamp(30px,5vw,50px);line-height:1.08;letter-spacing:-.025em;
 margin:0 0 20px;font-weight:680;max-width:18ch}
h2{font-size:clamp(23px,3.4vw,34px);letter-spacing:-.02em;margin:0 0 12px;font-weight:660}
h3{font-size:17px;margin:0 0 8px;font-weight:640}
.kicker{font-size:12px;text-transform:uppercase;letter-spacing:.1em;color:var(--amber);
 font-weight:650;margin:0 0 10px}
.lede{color:var(--slate);font-size:17.5px;max-width:62ch;margin:0 0 32px}
.lede p{margin:0 0 12px}
.centred-lede{margin-left:auto;margin-right:auto}
.actions{display:flex;gap:12px;flex-wrap:wrap}
section.centred .actions{justify-content:center}
.btn{display:inline-block;padding:13px 22px;border-radius:9px;text-decoration:none;
 font-weight:600;font-size:15.5px;border:1px solid transparent}
.btn.primary{background:var(--amber);color:var(--ink)}
.btn.primary:hover{background:#f5b25c}
.btn.ghost{border-color:var(--line);color:var(--ink)}
section.ink .btn.ghost{border-color:#33465e;color:var(--paper)}
.grid{display:grid;gap:20px;grid-template-columns:repeat(auto-fit,minmax(270px,1fr))}
.card{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:24px}
.card p{color:var(--slate);font-size:14.8px;margin:0 0 10px}
.steps{counter-reset:step;list-style:none;padding:0;margin:0;display:grid;gap:18px}
.steps li{counter-increment:step;position:relative;padding-left:52px}
.steps li::before{content:counter(step);position:absolute;left:0;top:0;width:34px;height:34px;
 border-radius:50%;background:var(--amber);color:var(--ink);display:flex;align-items:center;
 justify-content:center;font-weight:700}
.steps p{color:var(--slate);margin:0}
.contrast{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--line);
 border-radius:12px;overflow:hidden;background:var(--paper)}
.contrast>div{padding:24px}
.contrast .no{background:#FCF7F7;border-right:1px solid var(--line)}
.contrast h4{margin:0 0 12px;font-size:13px;text-transform:uppercase;letter-spacing:.07em}
.contrast .no h4{color:#A32A2A}.contrast .yes h4{color:#1B7A4C}
.contrast ul{margin:0;padding-left:19px;color:var(--slate);font-size:14.8px}
.contrast li{margin-bottom:8px}
.statement{font-size:clamp(20px,3vw,27px);line-height:1.42;letter-spacing:-.012em;
 max-width:54ch;margin:0;border-left:3px solid var(--amber);padding-left:22px;font-weight:520}
.faq details{border-bottom:1px solid var(--line);padding:16px 0}
.faq summary{cursor:pointer;font-weight:600;font-size:16.5px}
.faq p{color:var(--slate);margin:10px 0 0}
.prose p{color:var(--slate);max-width:66ch}
.plans{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(250px,1fr))}
.plan{border:1px solid var(--line);border-radius:12px;padding:26px;background:var(--paper);
 display:flex;flex-direction:column;text-align:left}
.plan.featured{border-color:var(--amber);box-shadow:0 8px 30px rgb(239 161 60 / .16)}
.plan .name{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--slate);
 font-weight:650}
.plan .price{font-size:34px;font-weight:680;letter-spacing:-.02em;margin:10px 0 2px;
 font-variant-numeric:tabular-nums}
.plan .per{color:var(--slate);font-size:14px;margin-bottom:16px}
.plan ul{list-style:none;margin:0 0 22px;padding:0;color:var(--slate);font-size:14.5px}
.plan li{padding:6px 0 6px 22px;position:relative}
.plan li::before{content:"";position:absolute;left:0;top:13px;width:9px;height:9px;
 border-radius:50%;background:var(--amber)}
.plan .btn{margin-top:auto;text-align:center}
/* Wide content scrolls inside its own box. A table that widens the page makes
   every other section scroll sideways too, on the device most people read on. */
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:0 0 8px;
 border:1px solid var(--line);border-radius:12px;background:#fff}
table.compare{border-collapse:collapse;width:100%;min-width:640px;font-size:14.5px}
table.compare th,table.compare td{padding:13px 16px;text-align:left;
 border-bottom:1px solid var(--line);vertical-align:top}
table.compare thead th{font-size:11.5px;text-transform:uppercase;letter-spacing:.08em;
 color:var(--slate);font-weight:600;background:#F7F9FC;white-space:nowrap}
table.compare tbody th{font-weight:600;color:var(--ink);white-space:nowrap}
table.compare tbody tr:last-child th,table.compare tbody tr:last-child td{border-bottom:0}
table.compare .lead{background:#FFF8EC;font-weight:600;color:var(--ink)}
table.compare thead .lead{background:#FDEFD6;color:var(--ink)}
section.ink .table-scroll{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.14)}
section.ink table.compare th,section.ink table.compare td{border-color:rgba(255,255,255,.12)}
section.ink table.compare thead th{background:rgba(255,255,255,.06);color:var(--mute)}
section.ink table.compare tbody th{color:var(--paper)}
section.ink table.compare td{color:var(--mute)}
section.ink table.compare .lead{background:rgba(239,161,60,.16);color:var(--paper)}
figure.demo{margin:0 0 26px}
figure.demo video{width:100%;display:block;border-radius:14px;border:1px solid var(--line);
 background:var(--ink);box-shadow:0 18px 44px rgba(16,24,40,.14);
 /* The recordings' own shape. A ratio that disagrees with the file
    letterboxes it, and a ratio left unset shifts the page as each one loads. */
 aspect-ratio:1122/624}
figure.demo figcaption{color:var(--slate);font-size:15px;margin-top:14px;max-width:70ch}
figure.demo figcaption p{margin:0 0 10px}
figure.demo figcaption p:last-child{margin:0}
section.ink figure.demo video{border-color:rgba(255,255,255,.14)}
section.ink figure.demo figcaption{color:var(--mute)}
.demo-described{color:var(--slate);font-size:15.5px;max-width:70ch}
section.ink .demo-described{color:var(--mute)}
footer{background:var(--ink);color:var(--mute);padding:44px 0;font-size:14px}
footer .wrap{display:flex;gap:26px;flex-wrap:wrap;align-items:center}
footer a{color:var(--mute);text-decoration:none}
footer a:hover{color:var(--paper)}
footer .spacer{margin-left:auto}
.preview-bar{background:var(--amber);color:var(--ink);padding:10px 0;font-size:14px;
 font-weight:600;text-align:center}
@media(max-width:640px){.contrast{grid-template-columns:1fr}
 .contrast .no{border-right:0;border-bottom:1px solid var(--line)}}
`;

/** Pricing drawn from the live catalogue, not typed by an author. */
export function pricingHtml(plans: readonly PlanVersion[], appBaseUrl: string): string {
  if (plans.length === 0) return '';
  return `<div class="plans">${plans.map((plan, index) => `<div class="plan${index === 1 ? ' featured' : ''}">
    <div class="name">${escapeHtml(plan.name)}</div>
    <div class="price">${escapeHtml(format(plan.platformFee.monthly))}</div>
    <div class="per">per month${plan.activationFee.amount > 0
      ? `, plus ${escapeHtml(format(plan.activationFee))} to activate` : ''}</div>
    <ul>
      <li>${escapeHtml(format({ amount: plan.includedCreditsPence, currency: plan.currency }))} of credit each month</li>
      <li>${plan.connectorEntitlement.tier1 > 1 ? 'All Tier 1 CRMs' : 'One CRM connector'}</li>
      <li>Up to ${plan.maxConcurrentVoice} concurrent voice calls</li>
      <li>${escapeHtml(format(plan.outcomeFee))} per confirmed outcome</li>
    </ul>
    <a class="btn ${index === 1 ? 'primary' : 'ghost'}"
       href="${escapeHtml(appBaseUrl)}/signup?plan=${escapeHtml(plan.planCode)}">Start on ${escapeHtml(plan.name)}</a>
  </div>`).join('')}</div>`;
}

export function renderMarketingPage(input: ShellInput): string {
  const app = escapeHtml(input.appBaseUrl);
  const nav = input.navigation
    .map((item) => `<a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a>`)
    .join('');

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.page.title)}</title>
<meta name="description" content="${escapeHtml(input.page.description)}">
${input.canonicalOrigin
  ? seoTags({
      page: input.page,
      canonicalOrigin: input.canonicalOrigin,
      siteName: 'Detent',
      plans: input.plans,
      appBaseUrl: input.appBaseUrl,
      imageUrl: input.imageUrl,
      noindex: Boolean(input.previewOf),
    })
  : (input.previewOf ? '<meta name="robots" content="noindex">' : '')}
<style>${STYLES}</style>
</head>
<body>
${input.previewOf
  ? `<div class="preview-bar">Preview of an unpublished draft, visitors still see
     ${escapeHtml(input.previewOf)}. Not indexed.</div>`
  : ''}
<header><div class="wrap">
  <a class="brand" href="/">${brandMark()}Detent</a>
  <nav>
    ${nav}
    <a href="${app}/signin">Sign in</a>
    <a class="cta" href="${app}/signup">Start free</a>
  </nav>
</div></header>

${renderSections(input.page, { pricingHtml: pricingHtml(input.plans, input.appBaseUrl) })}

<footer><div class="wrap">
  <a class="brand" href="/" style="font-size:16px">${brandMark()}Detent</a>
  ${nav}
  <a href="${app}/signin">Sign in</a>
  <span class="spacer"></span>
  <a href="/privacy">Privacy</a>
  <a href="/terms">Terms</a>
  <a href="/cookies">Cookies</a>
  <span>&copy; ${new Date().getUTCFullYear()} Detent</span>
</div></footer>

${input.assistant ? `<!--
  Our own site loads the assistant by a relative URL, not by the absolute one a
  customer is given. A customer's page is on their domain and must point at
  ours; ours is already here, and an absolute URL naming a different spelling of
  this same host (localhost against 127.0.0.1, or the bare domain against www)
  is refused by our own script-src 'self'.
-->
<script
  type="module"
  src="/widget/loader.js"
  data-detent-assistant
  data-api="${escapeHtml(input.assistant.apiBaseUrl)}"
  data-key="${escapeHtml(input.assistant.publicKey)}"
  data-panel="${escapeHtml(input.assistant.panelUrl)}"
  data-org="Detent"
  data-label="Ask about Detent"
  data-jurisdiction="UK"
  defer></script>` : ''}
<script type="module" src="/assets/reduced-motion.js"></script>
</body>
</html>`;
}

/** The page shown when a slug does not exist. */
export function notFoundPage(appBaseUrl: string): string {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found, Detent</title><style>${STYLES}</style></head>
<body><header><div class="wrap">
  <a class="brand" href="/">${brandMark()}Detent</a>
</div></header>
<section class="hero"><div class="wrap">
  <h1>That page does not exist.</h1>
  <div class="lede"><p>It may have been moved or taken down.</p></div>
  <div class="actions">
    <a class="btn primary" href="/">Back to the home page</a>
    <a class="btn ghost" href="${escapeHtml(appBaseUrl)}/signin">Sign in</a>
  </div>
</div></section></body></html>`;
}
