import { CREDIT_BUNDLES, LIST_PENCE_PER_REPLY, checkBundles, format } from '@detent/awa-billing';
import { escape, page } from './site-html.js';

/**
 * Credit bundles, in the back office.
 *
 * Two things happen here: an operator sees what is on sale and what each
 * bundle actually costs per reply, and grants one to an account, which is how
 * a bundle bought over the phone, or given as a goodwill gesture, reaches the
 * customer's balance.
 *
 * The per-reply figure is computed rather than typed. A pricing page where the
 * discount is a claim rather than arithmetic is a pricing page that eventually
 * disagrees with the invoice.
 */

const NAV = (current: string) => [
  { href: '/console', label: 'Overview', current: current === 'overview' },
  { href: '/console/accounts', label: 'Accounts', current: current === 'accounts' },
  { href: '/console/resellers', label: 'Resellers', current: current === 'resellers' },
  { href: '/console/pricing', label: 'Pricing', current: current === 'pricing' },
  { href: '/console/bundles', label: 'Bundles', current: current === 'bundles' },
  { href: '/console/website', label: 'Website', current: current === 'website' },
];

export function bundlesPage(input: {
  readonly userEmail: string;
  readonly accounts: readonly { readonly accountId: string; readonly name: string }[];
  readonly csrf: string;
  readonly notice?: string;
}): string {
  const problems = checkBundles(CREDIT_BUNDLES);

  return page(
    {
      title: 'Credit bundles', site: 'console', nav: NAV('bundles'),
      user: input.userEmail, banner: input.notice,
    },
    `
<h1>Credit bundles</h1>
<p class="sub">On the per-reply plan, credits are what replies are paid for out of. List price
is ${LIST_PENCE_PER_REPLY}p a reply; a bundle is cheaper the larger it is.</p>

${problems.length > 0 ? `<div class="warn">
  <b>These bundles should not be on sale.</b>
  <ul style="margin:8px 0 0">${problems.map((one) => `<li>${escape(one)}</li>`).join('')}</ul>
</div>` : ''}

<div class="card"><table>
  <thead><tr><th>Bundle</th><th class="n">Replies</th><th class="n">Price</th>
    <th class="n">Per reply</th><th class="n">Saving</th></tr></thead>
  <tbody>${CREDIT_BUNDLES.map((bundle) => `<tr>
    <td>${escape(bundle.name)}</td>
    <td class="n">${bundle.replies.toLocaleString('en-GB')}</td>
    <td class="n">${escape(format(bundle.price))}</td>
    <td class="n">${bundle.effectivePencePerReply}p</td>
    <td class="n">${bundle.savingPercent}%</td>
  </tr>`).join('')}</tbody>
</table></div>

<div class="card">
  <h2 style="margin:0 0 6px">Grant a bundle</h2>
  <p class="sub" style="margin:0 0 12px">For a bundle bought outside the app, or given as a
  goodwill gesture. The credit is granted at list value, not at what was paid: that is what
  the discount is: the customer gets what they were sold rather than what it cost them.</p>
  <form method="post" action="/console/bundles/grant">
    <input type="hidden" name="csrf" value="${escape(input.csrf)}">
    <div class="grid">
      <div><label for="accountId">Account</label>
        <select class="field" id="accountId" name="accountId" required>
          ${input.accounts.map((account) =>
            `<option value="${escape(account.accountId)}">${escape(account.name)}</option>`).join('')}
        </select></div>
      <div><label for="bundle">Bundle</label>
        <select class="field" id="bundle" name="bundle" required>
          ${CREDIT_BUNDLES.map((bundle) =>
            `<option value="${escape(bundle.code)}">${escape(bundle.name)}, ${
              escape(format(bundle.price))}</option>`).join('')}
        </select></div>
    </div>
    <label for="reason">Why</label>
    <input class="field" id="reason" name="reason" required
           placeholder="Paid by invoice INV-1042 / goodwill after the outage on the 3rd">
    <p class="sub">Recorded against the account. A credit with no reason is one nobody can
    explain at the year end.</p>
    <div class="actions"><button class="btn primary" type="submit">Grant it</button></div>
  </form>
</div>`,
  );
}
