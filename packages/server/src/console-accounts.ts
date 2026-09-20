import {
  TERM_MONTHS, daysUntil, format, noticeDeadline,
  type Account, type AccountService, type AccountSubscription, type ContractTerm,
} from '@detent/awa-billing';
import { escape, page, pill, statCard } from './site-html.js';

/**
 * The commercial pages of the back office.
 *
 * These answer the questions an operator is actually asked on a support call:
 * when does this renew, when is the next invoice, how long is the term, how
 * much notice do they owe, what are they entitled to use, and how many credits
 * do they get each period. If the console cannot answer them the operator opens
 * the signed PDF, and the system has stopped being the source of truth for its
 * own commercial terms.
 */

const NAV = (current: string) => [
  { href: '/console', label: 'Accounts', current: current === 'accounts' },
  { href: '/console/new', label: 'New account', current: current === 'new' },
  { href: '/console/pricing', label: 'Pricing', current: current === 'pricing' },
  { href: '/console/approvals', label: 'Approvals', current: current === 'approvals' },
  { href: '/', label: 'Service' },
];

const TERM_LABELS: Readonly<Record<ContractTerm, string>> = {
  rolling_monthly: 'Rolling monthly',
  twelve_months: '12 months',
  twenty_four_months: '24 months',
  thirty_six_months: '36 months',
};

const day = (iso?: string): string => (iso ? iso.slice(0, 10) : ', ');

/** The accounts list: every account, with what an operator scans for. */
export function accountsListPage(input: {
  readonly accounts: readonly Account[];
  readonly subscriptions: ReadonlyMap<string, AccountSubscription>;
  readonly nowIso: string;
  readonly userEmail: string;
  readonly pendingCount: number;
}): string {
  const banner = input.pendingCount > 0
    ? `${input.pendingCount} action${input.pendingCount === 1 ? '' : 's'} awaiting a second approver.`
    : undefined;

  const rows = input.accounts.map((account) => {
    const subscription = input.subscriptions.get(account.accountId);
    const renewal = subscription?.terms.renewalDate;
    const days = renewal ? daysUntil(renewal, input.nowIso) : undefined;
    // Ninety days is where a renewal stops being a date and becomes a task.
    const renewalTone = days === undefined ? 'neutral' : days < 0 ? 'bad' : days <= 90 ? 'warn' : 'ok';
    return `<tr>
      <td><a class="link" href="/console/accounts/${encodeURIComponent(account.accountId)}">${escape(account.name)}</a>
        <div style="color:#5B6B7F;font-size:12px"><code>${escape(account.tenantId)}</code></div></td>
      <td>${pill(account.status, account.status === 'active' ? 'ok' : account.status === 'closed' ? 'bad' : 'neutral')}</td>
      <td>${escape(subscription ? subscription.planCode : ', ')}</td>
      <td>${escape(subscription ? TERM_LABELS[subscription.terms.term] : ', ')}</td>
      <td>${escape(day(renewal))}${days === undefined ? '' : ` ${pill(`${days}d`, renewalTone)}`}</td>
      <td>${escape(day(subscription?.terms.nextBillingDate))}</td>
      <td class="num">${escape(subscription ? format(subscription.contractedPlatformFee) : ', ')}</td>
    </tr>`;
  }).join('');

  return page(
    { title: 'Accounts', site: 'console', nav: NAV('accounts'), user: input.userEmail, banner },
    `<h1>Accounts</h1>
<p class="sub">Every account, its term and what happens next.</p>
${input.accounts.length === 0
  ? '<div class="empty">No accounts yet. <a class="link" href="/console/new">Create the first one</a>.</div>'
  : `<table><thead><tr>
<th>Account</th><th>Status</th><th>Plan</th><th>Term</th><th>Renews</th>
<th>Next invoice</th><th class="num">Fee</th></tr></thead>
<tbody>${rows}</tbody></table>`}
<div class="actions"><a class="btn primary" href="/console/new">Create an account</a></div>`,
  );
}

/** The account creation form. */
export function newAccountPage(input: {
  readonly userEmail: string;
  readonly error?: string;
  readonly values?: Readonly<Record<string, string>>;
  readonly csrf: string;
}): string {
  const value = (key: string) => escape(input.values?.[key] ?? '');
  return page(
    { title: 'New account', site: 'console', nav: NAV('new'), user: input.userEmail },
    `<h1>Create an account</h1>
<p class="sub">The account and its subscription are created together, so an account can never
sit in the system without commercial terms against it.</p>
${input.error ? `<div class="banner" style="background:#FCEBEB;border-color:#F3C9C9;color:#A32A2A">${escape(input.error)}</div>` : ''}
<form method="post" action="/console/new" class="card">
  <input type="hidden" name="csrf" value="${escape(input.csrf)}">
  <h2 style="margin-top:0">Customer</h2>
  <div class="grid">
    <div><label for="name">Organisation name</label>
      <input class="field" id="name" name="name" required value="${value('name')}"></div>
    <div><label for="tenantId">Tenant id</label>
      <input class="field" id="tenantId" name="tenantId" required placeholder="t_northwind" value="${value('tenantId')}"></div>
    <div><label for="billingEmail">Billing email</label>
      <input class="field" id="billingEmail" name="billingEmail" type="email" required value="${value('billingEmail')}"></div>
    <div><label for="countryCode">Country (ISO 2)</label>
      <input class="field" id="countryCode" name="countryCode" required maxlength="2" placeholder="GB" value="${value('countryCode') || 'GB'}"></div>
    <div><label for="vatNumber">VAT number (optional)</label>
      <input class="field" id="vatNumber" name="vatNumber" value="${value('vatNumber')}"></div>
    <div><label for="accountManager">Account manager</label>
      <input class="field" id="accountManager" name="accountManager" value="${value('accountManager')}"></div>
  </div>

  <h2>Commercial terms</h2>
  <div class="grid">
    <div><label for="planCode">Plan</label>
      <select class="field" id="planCode" name="planCode">
        <option value="starter">Starter</option>
        <option value="growth" selected>Growth</option>
        <option value="command">Command</option>
        <option value="enterprise">Enterprise</option>
      </select></div>
    <div><label for="term">Term</label>
      <select class="field" id="term" name="term">
        <option value="rolling_monthly">Rolling monthly</option>
        <option value="twelve_months" selected>12 months</option>
        <option value="twenty_four_months">24 months</option>
        <option value="thirty_six_months">36 months</option>
      </select></div>
    <div><label for="billingInterval">Billing</label>
      <select class="field" id="billingInterval" name="billingInterval">
        <option value="monthly" selected>Monthly</option>
        <option value="annual">Annual</option>
      </select></div>
    <div><label for="startDate">Start date</label>
      <input class="field" id="startDate" name="startDate" type="date" required value="${value('startDate')}"></div>
    <div><label for="billingDay">Billing day (1 to 28)</label>
      <input class="field" id="billingDay" name="billingDay" type="number" min="1" max="28" value="${value('billingDay') || '1'}"></div>
    <div><label for="noticePeriodDays">Notice period (days)</label>
      <input class="field" id="noticePeriodDays" name="noticePeriodDays" type="number" min="0" value="${value('noticePeriodDays') || '90'}"></div>
    <div><label for="renewalUplift">Renewal uplift (%)</label>
      <input class="field" id="renewalUplift" name="renewalUplift" type="number" step="0.1" min="0" value="${value('renewalUplift') || '0'}"></div>
    <div><label for="monthlyCredits">Monthly credits (&pound;)</label>
      <input class="field" id="monthlyCredits" name="monthlyCredits" type="number" step="0.01" min="0"
             placeholder="plan default" value="${value('monthlyCredits')}"></div>
  </div>

  <h2>Limits</h2>
  <p class="sub" style="margin:0 0 10px">Blank means the plan default. Zero means none, which is
  not the same thing. A customer who bought unmetered voice must not be cut off on day one.</p>
  <div class="grid">
    <div><label for="seats">Seats</label>
      <input class="field" id="seats" name="seats" type="number" min="0" value="${value('seats')}"></div>
    <div><label for="conversations">Conversations / period</label>
      <input class="field" id="conversations" name="conversations" type="number" min="0" value="${value('conversations')}"></div>
    <div><label for="voiceMinutes">Voice minutes / period</label>
      <input class="field" id="voiceMinutes" name="voiceMinutes" type="number" min="0" value="${value('voiceMinutes')}"></div>
    <div><label for="spendCap">Spend cap (&pound;)</label>
      <input class="field" id="spendCap" name="spendCap" type="number" step="0.01" min="0"
             placeholder="plan default" value="${value('spendCap')}"></div>
  </div>

  <div class="actions">
    <button class="btn primary" type="submit">Create account and subscription</button>
    <a class="btn" href="/console">Cancel</a>
  </div>
</form>
`,
  );
}

/** The commercial detail for one account. */
export function accountTermsSection(
  subscription: AccountSubscription | undefined,
  nowIso: string,
): string {
  if (!subscription) {
    return `<h2>Subscription</h2>
<div class="empty">No subscription. This account is a prospect and cannot be invoiced.</div>`;
  }
  const { terms, limits } = subscription;
  const toRenewal = daysUntil(terms.renewalDate, nowIso);
  const deadline = noticeDeadline(terms);
  const noticePassed = deadline <= nowIso;

  const limitRow = (label: string, value: number | undefined, suffix = '') =>
    `<tr><td>${escape(label)}</td><td class="num">${
      // Undefined and zero are different, and showing both as 0 is how an
      // unmetered customer gets cut off.
      value === undefined ? '<span class="pill">unmetered</span>' : escape(`${value}${suffix}`)
    }</td></tr>`;

  return `<h2>Contract</h2>
<div class="grid">
  ${statCard('Term', TERM_LABELS[terms.term], `${TERM_MONTHS[terms.term]} months from ${day(terms.startDate)}`)}
  ${statCard('Renews', day(terms.renewalDate),
    toRenewal < 0 ? 'Renewal date has passed' : `in ${toRenewal} days`)}
  ${statCard('Next invoice', day(terms.nextBillingDate),
    `${terms.billingInterval}, day ${terms.billingDay}`)}
  ${statCard('Monthly credits', format({ amount: subscription.monthlyCreditsPence, currency: 'GBP' }),
    'Granted each billing period')}
</div>
<div class="card">
  <table style="border:0">
    <tbody>
      <tr><td>Contracted fee</td><td class="num">${escape(format(subscription.contractedPlatformFee))} per ${escape(terms.billingInterval === 'annual' ? 'year' : 'month')}</td></tr>
      <tr><td>Notice period</td><td class="num">${escape(String(terms.noticePeriodDays))} days</td></tr>
      <tr><td>Notice deadline</td><td class="num">${escape(day(deadline))} ${
        noticePassed ? pill('passed', 'warn') : pill('open', 'ok')}</td></tr>
      <tr><td>Auto-renew</td><td class="num">${terms.autoRenew ? pill('yes', 'ok') : pill('no', 'warn')}</td></tr>
      ${terms.renewalUpliftBasisPoints
        ? `<tr><td>Renewal uplift</td><td class="num">${escape((terms.renewalUpliftBasisPoints / 100).toFixed(2))}%</td></tr>`
        : ''}
      ${terms.noticeGivenAt
        ? `<tr><td>Notice given</td><td class="num">${escape(day(terms.noticeGivenAt))} by ${escape(terms.noticeGivenBy ?? '')}</td></tr>`
        : ''}
    </tbody>
  </table>
</div>

<h2>Limits per period</h2>
<div class="card">
  <table style="border:0"><tbody>
    ${limitRow('Seats', limits.seats)}
    ${limitRow('Conversations', limits.conversationsPerPeriod)}
    ${limitRow('Voice minutes', limits.voiceMinutesPerPeriod)}
    ${limitRow('Text messages', limits.textMessagesPerPeriod)}
    ${limitRow('Enrichment records', limits.enrichmentRecordsPerPeriod)}
    ${limitRow('Concurrent voice', limits.maxConcurrentVoice)}
    ${limitRow('Tier 1 connectors', limits.connectorsTier1)}
    ${limitRow('Tier 2 connectors', limits.connectorsTier2)}
    <tr><td>Spend cap</td><td class="num">${escape(format(limits.spendCap))}</td></tr>
  </tbody></table>
</div>`;
}

export { NAV as consoleNav, TERM_LABELS };
export type { AccountService };
