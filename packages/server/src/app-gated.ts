import type { AuthUser } from '@detent/awa-auth';
import type { Account, AccountSubscription } from '@detent/awa-billing';
import { escape, page, pill } from './site-html.js';

/**
 * The pages a paying subscriber gets.
 *
 * Installation, the API surface and the health endpoint used to be on the
 * public page. They belong here for two separate reasons, and both matter:
 *
 *  - **Commercially.** The snippet, the keys and the API are the product. A
 *    prospect who can read the integration guide and lift the endpoints has
 *    been given the evaluation for free, and the trial has no floor under it.
 *
 *  - **Operationally.** A public health endpoint tells anyone whether the
 *    service is up, which is the first thing an attacker checks and the last
 *    thing a competitor needs to know about your uptime.
 *
 * The gate is a paid, active subscription, not merely being signed in. Someone
 * on a lapsed account keeps their data and their knowledge; they lose the
 * ability to run the assistant, which is what they stopped paying for.
 */

export type EntitlementState =
  | 'entitled'
  /** Signed in, but the subscription is not paying. */
  | 'not_paying'
  /** No subscription at all. */
  | 'no_subscription'
  /** Past due, degraded or suspended. */
  | 'suspended';

export interface Entitlement {
  readonly state: EntitlementState;
  readonly reason: string;
}

/**
 * Decides whether an account may see the paid pages.
 *
 * Deliberately explicit about the middle cases. "Not entitled" covering a
 * lapsed customer, a trial and a suspension equally produces one unhelpful
 * screen for three different problems, each of which needs a different action
 * from the person reading it.
 */
export function entitlementOf(
  subscription: AccountSubscription | undefined,
  account: Account | undefined,
): Entitlement {
  if (!subscription) {
    return {
      state: 'no_subscription',
      reason: 'This account does not have a subscription yet.',
    };
  }
  if (account?.status === 'suspended') {
    return {
      state: 'suspended',
      reason: 'This account is suspended. Settle the outstanding balance to restore access.',
    };
  }
  if (account?.status === 'closed') {
    return { state: 'suspended', reason: 'This account is closed.' };
  }
  // A zero contracted fee is a trial or an unconfigured enterprise plan, and
  // neither is a paying subscription.
  if (subscription.contractedPlatformFee.amount <= 0) {
    return {
      state: 'not_paying',
      reason: 'These pages are part of a paid subscription. Choose a plan to unlock them.',
    };
  }
  return { state: 'entitled', reason: '' };
}

const NAV = (current: string) => [
  { href: '/app', label: 'Overview', current: current === 'overview' },
  { href: '/app/knowledge', label: 'Knowledge', current: current === 'knowledge' },
  { href: '/app/install', label: 'Install', current: current === 'install' },
  { href: '/app/api', label: 'API', current: current === 'api' },
  { href: '/app/status', label: 'Status', current: current === 'status' },
  { href: '/app/billing', label: 'Billing', current: current === 'billing' },
];

/** Shown in place of a paid page. Says what to do, not merely "no". */
export function upgradeRequiredPage(input: {
  readonly user: AuthUser;
  readonly entitlement: Entitlement;
  readonly what: string;
  readonly current: string;
}): string {
  return page(
    { title: input.what, site: 'app', nav: NAV(input.current), user: input.user.email },
    `<h1>${escape(input.what)}</h1>
<div class="card" style="border-left:3px solid #EFA13C">
  <p style="margin:0 0 6px"><b>${escape(input.entitlement.reason)}</b></p>
  <p class="sub" style="margin:0 0 14px">Your data, your knowledge and your settings are all
  still here. What a subscription adds is the ability to run the assistant on your site.</p>
  <div class="actions">
    <a class="btn primary" href="/app/billing">See plans and subscribe</a>
    <a class="btn" href="/app">Back to overview</a>
  </div>
</div>`,
  );
}

export interface InstallPageInput {
  readonly user: AuthUser;
  readonly account: Account;
  readonly subscription: AccountSubscription;
  readonly apiBaseUrl: string;
  readonly widgetKey: string;
  readonly panelUrl: string;
}

/** The snippet, with the customer's own key in it. */
export function installPage(input: InstallPageInput): string {
  const snippet = `<script
  type="module"
  src="${input.apiBaseUrl}/widget/loader.js"
  data-detent-assistant
  data-api="${input.apiBaseUrl}"
  data-key="${input.widgetKey}"
  data-panel="${input.panelUrl}"
  data-org="${input.account.name}"
  data-label="Ask a question"
  data-jurisdiction="${input.account.countryCode === 'GB' ? 'UK' : 'EU'}"
  defer></script>`;

  return page(
    { title: 'Install', site: 'app', nav: NAV('install'), user: input.user.email },
    `<h1>Install the assistant</h1>
<p class="sub">One script tag, before the closing <code>&lt;/body&gt;</code> on every page you want
the assistant on. It injects a Web Component with its own Shadow DOM, so it cannot inherit or
disturb your site's styles, and the conversation bundle only loads when somebody opens it.</p>

<h2>Your snippet</h2>
<div class="card">
  <pre class="snippet">${escape(snippet)}</pre>
  <p class="sub" style="margin:12px 0 0">
    <b>The key in this snippet is public by design.</b> It identifies your tenant and can only
    open a conversation: it cannot read your CRM, your knowledge or your billing. Your private
    keys are never in a web page.</p>
</div>

<h2>Branding</h2>
<p class="sub">Add your own logo and accent colour with these attributes. The assistant carries
your brand, not ours.</p>
<div class="card"><table style="border:0"><tbody>
  <tr><td><code>data-logo</code></td><td>A <code>data:</code> URI or HTTPS URL for your logo.</td></tr>
  <tr><td><code>data-logo-width</code> / <code>-height</code></td>
      <td>Its natural size, so the shape can be judged. Required with a logo.</td></tr>
  <tr><td><code>data-logo-dark</code></td><td>A light variant, for a dark launcher.</td></tr>
  <tr><td><code>data-accent</code></td><td>Launcher colour, e.g. <code>#1F4E9C</code>.</td></tr>
  <tr><td><code>data-label</code></td><td>The launcher text. Default "Ask a question".</td></tr>
</tbody></table></div>

<h2>Content Security Policy</h2>
<p class="sub">If your site sets a CSP, the assistant needs these. Nothing else.</p>
<div class="card"><pre class="snippet">script-src ${escape(input.apiBaseUrl)};
connect-src ${escape(input.apiBaseUrl)};
frame-src ${escape(input.panelUrl)};
img-src data:;</pre>
  <p class="sub" style="margin:12px 0 0">A logo supplied as a <code>data:</code> URI needs no
  extra host in your policy, which is why we recommend one.</p>
</div>

`,
  );
}

/** The API surface, for a customer building against it. */
export function apiPage(input: {
  readonly user: AuthUser;
  readonly account: Account;
  readonly apiBaseUrl: string;
}): string {
  const route = (method: string, path: string, purpose: string, key: string) => `<tr>
    <td><span class="method">${escape(method)}</span> <code>${escape(path)}</code></td>
    <td>${escape(purpose)}</td><td>${pill(key)}</td></tr>`;

  return page(
    { title: 'API', site: 'app', nav: NAV('api'), user: input.user.email },
    `<h1>API</h1>
<p class="sub">Everything the widget does, your own systems can do. Base URL
<code>${escape(input.apiBaseUrl)}</code>. Every route needs a bearer key, and the key decides what
it may touch: a widget key can open a conversation and nothing else.</p>

<h2>Conversation</h2>
<table><thead><tr><th>Route</th><th>Purpose</th><th>Key</th></tr></thead><tbody>
${route('POST', '/v1/sessions', 'Open a conversation', 'widget')}
${route('POST', '/v1/sessions/{id}/messages', 'Send a turn', 'widget')}
${route('POST', '/v1/sessions/{id}/consent', 'Record consent', 'widget')}
</tbody></table>

<h2>Administration</h2>
<table><thead><tr><th>Route</th><th>Purpose</th><th>Key</th></tr></thead><tbody>
${route('GET', '/v1/admin/usage', 'Usage this period', 'admin')}
${route('GET', '/v1/admin/audit', 'Hash-chained audit log', 'admin')}
${route('GET', '/v1/admin/analytics', 'Conversation analytics', 'admin')}
${route('GET', '/v1/admin/handoffs', 'Escalations to your team', 'admin')}
${route('POST', '/v1/admin/kill-switch', 'Stop the assistant immediately', 'admin')}
${route('POST', '/v1/outcomes/{correlationId}/confirm', 'Confirm a billable outcome', 'admin')}
</tbody></table>

<h2>Webhooks</h2>
<table><thead><tr><th>Route</th><th>Purpose</th><th>Key</th></tr></thead><tbody>
${route('POST', '/v1/webhooks/{connector}', 'CRM callbacks', 'signature')}
</tbody></table>

<h2>Your keys</h2>
<div class="card">
  <p class="sub" style="margin:0">Keys are shown once, when issued, and stored only as hashes , 
  we cannot show you an existing key, only replace it. Ask your account manager to issue an admin
  key; the widget key is in your <a class="link" href="/app/install">install snippet</a>.</p>
</div>

`,
  );
}

/** Service status, for the customer's own account. */
export function statusPage(input: {
  readonly user: AuthUser;
  readonly account: Account;
  readonly subscription: AccountSubscription;
  readonly apiBaseUrl: string;
  readonly killSwitch: string;
}): string {
  const healthy = input.killSwitch === 'OFF';
  return page(
    { title: 'Status', site: 'app', nav: NAV('status'), user: input.user.email },
    `<h1>Service status</h1>
<p class="sub">The assistant's state on your account. This page is here rather than on a public
URL: whether your service is up is your information, not everyone's.</p>

<div class="card">
  <table style="border:0"><tbody>
    <tr><td>Assistant</td><td class="num">${healthy
      ? pill('running', 'ok') : pill('stopped by kill switch', 'bad')}</td></tr>
    <tr><td>Tenant</td><td class="num"><code>${escape(input.account.tenantId)}</code></td></tr>
    <tr><td>Plan</td><td class="num">${escape(input.subscription.planCode)}</td></tr>
    <tr><td>Endpoint</td><td class="num"><code>${escape(input.apiBaseUrl)}</code></td></tr>
  </tbody></table>
</div>

<h2>Checking it yourself</h2>
<div class="card">
  <p class="sub" style="margin:0 0 10px">Your monitoring can poll this with your admin key. It
  returns 200 while the assistant is answering.</p>
  <pre class="snippet">curl -s ${escape(input.apiBaseUrl)}/v1/admin/health \\
  -H "authorization: Bearer YOUR_ADMIN_KEY"</pre>
</div>
`,
  );
}

export { NAV as appGatedNav };
