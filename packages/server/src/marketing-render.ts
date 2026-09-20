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
<link rel="stylesheet" href="/marketing.css">
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
<title>Not found, Detent</title><link rel="stylesheet" href="/marketing.css"></head>
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
