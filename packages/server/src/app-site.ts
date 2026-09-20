import type { AuthUser } from '@detent/awa-auth';
import { format, type Account, type AccountSubscription, type CreditBalance } from '@detent/awa-billing';
import { escape, page, pill, statCard } from './site-html.js';

/**
 * The customer's install-and-manage app.
 *
 * A separate site from the back office, sharing the billing domain and nothing
 * else. Everything here is scoped to one tenant, and the scoping is done by the
 * session rather than by a parameter in the URL: a customer cannot ask for
 * another tenant's page because they never name a tenant at all.
 *
 * What a customer sees of their own commercial terms is deliberately the same
 * information the operator sees, renewal date, term, notice period, limits,
 * credits. Hiding a customer's own contract from them creates the support call
 * that the console was built to avoid.
 */

const NAV = (current: string) => [
  { href: '/app', label: 'Overview', current: current === 'overview' },
  { href: '/app/knowledge', label: 'Knowledge', current: current === 'knowledge' },
  { href: '/app/install', label: 'Install', current: current === 'install' },
  { href: '/app/branding', label: 'Branding', current: current === 'branding' },
  { href: '/app/billing', label: 'Billing', current: current === 'billing' },
];

const day = (iso?: string): string => (iso ? iso.slice(0, 10) : ', ');

export interface AppOverviewInput {
  readonly user: AuthUser;
  readonly account?: Account;
  readonly subscription?: AccountSubscription;
  readonly credits?: CreditBalance;
  readonly usage?: {
    readonly conversations: number;
    readonly voiceMinutes: number;
    readonly textMessages: number;
  };
  readonly nowIso: string;
}

export function appOverviewPage(input: AppOverviewInput): string {
  const { subscription, credits, usage } = input;

  /**
   * Usage against a limit.
   *
   * An unmetered entitlement shows the number used and no bar. Drawing a bar
   * against an invented ceiling tells a customer they are near a limit that
   * does not exist, and they buy an upgrade they do not need.
   */
  const meter = (label: string, used: number, limit?: number) => {
    if (limit === undefined) {
      return statCard(label, String(used), 'Unmetered on your plan');
    }
    const fraction = limit === 0 ? 1 : Math.min(used / limit, 1);
    const tone = fraction >= 1 ? 'bad' : fraction >= 0.8 ? 'warn' : 'ok';
    return `<div class="card stat">
      <div class="label">${escape(label)}</div>
      <div class="value">${escape(String(used))}<span style="font-size:15px;color:#5B6B7F"> / ${escape(String(limit))}</span></div>
      <div class="bar"><span style="width:${(fraction * 100).toFixed(1)}%" class="${tone}"></span></div>
    </div>`;
  };

  return page(
    { title: 'Overview', site: 'app', nav: NAV('overview'), user: input.user.email },
    `<h1>${escape(input.account?.name ?? 'Your account')}</h1>
<p class="sub">Your assistant, your plan and what you have used this period.</p>

${subscription ? `<div class="grid">
  ${statCard('Plan', subscription.planCode, `${escape(format(subscription.contractedPlatformFee))} per ${subscription.terms.billingInterval === 'annual' ? 'year' : 'month'}`)}
  ${statCard('Renews', day(subscription.terms.renewalDate),
    `${subscription.terms.noticePeriodDays} days' notice required`)}
  ${statCard('Next invoice', day(subscription.terms.nextBillingDate), subscription.terms.billingInterval)}
  ${statCard('Credit balance', credits ? format(credits.total) : ', ',
    credits ? `${format(credits.expiringWithin30Days)} expires within 30 days` : '')}
</div>` : `<div class="empty">No subscription is active on this account yet.</div>`}

${usage && subscription ? `<h2>This period</h2>
<div class="grid">
  ${meter('Conversations', usage.conversations, subscription.limits.conversationsPerPeriod)}
  ${meter('Voice minutes', usage.voiceMinutes, subscription.limits.voiceMinutesPerPeriod)}
  ${meter('Text messages', usage.textMessages, subscription.limits.textMessagesPerPeriod)}
</div>` : ''}

<h2>Get started</h2>
<div class="grid">
  <a class="card" href="/app/install"><b>Install the assistant</b>
    <span>One script tag on your site.</span></a>
  <a class="card" href="/app/branding"><b>Your branding</b>
    <span>Upload your logo and set your accent colour.</span></a>
  <a class="card" href="/app/billing"><b>Billing</b>
    <span>Invoices, credits and payment method.</span></a>
</div>
`,
  );
}

/** The customer's own view of their contract. Same facts the operator sees. */
export function appBillingPage(input: {
  readonly user: AuthUser;
  readonly account?: Account;
  readonly subscription?: AccountSubscription;
  readonly credits?: CreditBalance;
}): string {
  const { subscription } = input;
  return page(
    { title: 'Billing', site: 'app', nav: NAV('billing'), user: input.user.email },
    `<h1>Billing</h1>
<p class="sub">Your plan, your terms and your credit. The same figures your account manager sees.</p>
${subscription ? `<div class="card"><table style="border:0"><tbody>
  <tr><td>Plan</td><td class="num">${escape(subscription.planCode)}</td></tr>
  <tr><td>Fee</td><td class="num">${escape(format(subscription.contractedPlatformFee))}
    per ${escape(subscription.terms.billingInterval === 'annual' ? 'year' : 'month')}</td></tr>
  <tr><td>Term started</td><td class="num">${escape(day(subscription.terms.startDate))}</td></tr>
  <tr><td>Renews</td><td class="num">${escape(day(subscription.terms.renewalDate))}</td></tr>
  <tr><td>Next invoice</td><td class="num">${escape(day(subscription.terms.nextBillingDate))}</td></tr>
  <tr><td>Notice period</td><td class="num">${escape(String(subscription.terms.noticePeriodDays))} days</td></tr>
  <tr><td>Auto-renew</td><td class="num">${subscription.terms.autoRenew ? pill('yes', 'ok') : pill('no', 'warn')}</td></tr>
  <tr><td>Credits each period</td><td class="num">${escape(format({ amount: subscription.monthlyCreditsPence, currency: 'GBP' }))}</td></tr>
</tbody></table></div>` : '<div class="empty">No subscription on this account.</div>'}
${input.credits ? `<h2>Credit</h2><div class="grid">
  ${statCard('Balance', format(input.credits.total))}
  ${statCard('Expiring within 30 days', format(input.credits.expiringWithin30Days))}
  ${statCard('Refundable', format(input.credits.refundable), 'Purchased credit only')}
</div>` : ''}`,
  );
}

export { NAV as appNav };
