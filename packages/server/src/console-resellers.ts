import { format, type Money } from '@detent/awa-billing';
import type { CommissionStatement, Reseller } from '@detent/awa-reseller';
import { escape, page } from './site-html.js';

/**
 * Managing the channel from the back office.
 *
 * Two things happen here that happen nowhere else: a customer is attached to a
 * reseller, and a margin is set. Both are commercial commitments, so both
 * record who made them.
 */

const NAV = (current: string) => [
  { href: '/console', label: 'Overview', current: current === 'overview' },
  { href: '/console/accounts', label: 'Accounts', current: current === 'accounts' },
  { href: '/console/resellers', label: 'Resellers', current: current === 'resellers' },
  { href: '/console/pricing', label: 'Pricing', current: current === 'pricing' },
  { href: '/console/website', label: 'Website', current: current === 'website' },
];

const STYLES = `<style>
  table{width:100%;border-collapse:collapse;font-size:14.5px}
  th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.07em;
   color:#5B6B7F;padding:0 10px 8px 0;font-weight:600}
  td{padding:10px 10px 10px 0;border-top:1px solid #EEF2F6;font-variant-numeric:tabular-nums}
  td.n,th.n{text-align:right}
  .field{width:100%;padding:9px 11px;font-size:14px;border:1px solid #E3E8EF;
   border-radius:7px;font-family:inherit;margin:0 0 12px}
  label{display:block;font-size:12.5px;color:#5B6B7F;margin:0 0 5px;font-weight:600}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
  .pill{display:inline-block;font-size:11.5px;padding:2px 8px;border-radius:20px;
   text-transform:uppercase;letter-spacing:.05em;background:#EEF2F6;color:#42536B}
  .pill.active{background:#E7F3EC;color:#1E6C3B}
  .pill.terminated{background:#FBE9E8;color:#93302B}
  .hint{color:#5B6B7F;font-size:12.5px;margin:-6px 0 14px}
</style>`;

export function resellerListPage(input: {
  readonly userEmail: string;
  readonly csrf: string;
  readonly resellers: readonly {
    readonly reseller: Reseller;
    readonly customerCount: number;
    readonly commissionEarned: Money;
    readonly commissionPending: Money;
  }[];
  readonly notice?: string;
}): string {
  return page(
    {
      title: 'Resellers', site: 'console', nav: NAV('resellers'),
      user: input.userEmail, banner: input.notice,
    },
    `${STYLES}
<h1>Resellers</h1>
<p class="sub">Who sells Detent on your behalf, on what margin, and what they are owed.</p>

${input.resellers.length === 0
  ? `<div class="card"><p class="sub" style="margin:0">No resellers yet.</p></div>`
  : `<div class="card"><table>
  <thead><tr><th>Reseller</th><th>Status</th><th class="n">Margin</th>
    <th class="n">Customers</th><th class="n">Earned</th><th class="n">Pending</th></tr></thead>
  <tbody>${input.resellers.map((row) => `<tr>
    <td><a href="/console/resellers/${escape(row.reseller.resellerId)}">${escape(row.reseller.name)}</a>
      <div class="sub">${escape(row.reseller.contactEmail)}</div></td>
    <td><span class="pill ${escape(row.reseller.status)}">${escape(row.reseller.status.replace(/_/g, ' '))}</span></td>
    <td class="n">${(row.reseller.marginBasisPoints / 100).toFixed(2)}%</td>
    <td class="n">${row.customerCount}</td>
    <td class="n">${escape(format(row.commissionEarned))}</td>
    <td class="n">${escape(format(row.commissionPending))}</td>
  </tr>`).join('')}</tbody></table></div>`}

<div class="card">
  <h2 style="margin:0 0 12px">Add a reseller</h2>
  <form method="post" action="/console/resellers">
    <input type="hidden" name="csrf" value="${escape(input.csrf)}">
    <div class="grid">
      <div><label for="name">Name</label>
        <input class="field" id="name" name="name" required></div>
      <div><label for="contactEmail">Contact email</label>
        <input class="field" id="contactEmail" name="contactEmail" type="email" required></div>
      <div><label for="margin">Margin %</label>
        <input class="field" id="margin" name="margin" required
               inputmode="decimal" placeholder="15"></div>
      <div><label for="agreementStart">Agreement starts</label>
        <input class="field" id="agreementStart" name="agreementStart" type="date" required></div>
    </div>
    <p class="hint">The margin applies to what their customers spend, net of VAT. It can be
    overridden per customer without changing this standard rate.</p>
    <div class="actions"><button class="btn primary" type="submit">Add reseller</button></div>
  </form>
</div>`,
  );
}

export function resellerDetailPage(input: {
  readonly userEmail: string;
  readonly csrf: string;
  readonly reseller: Reseller;
  readonly statements: readonly CommissionStatement[];
  readonly customers: readonly {
    readonly accountId: string;
    readonly name: string;
    readonly since: string;
    readonly marginBasisPoints: number;
    readonly isOverride: boolean;
  }[];
  readonly portalUserExists: boolean;
  readonly territories: readonly string[];
  readonly notice?: string;
}): string {
  return page(
    {
      title: input.reseller.name, site: 'console', nav: NAV('resellers'),
      user: input.userEmail, banner: input.notice,
    },
    `${STYLES}
<p class="sub"><a href="/console/resellers">Resellers</a></p>
<h1>${escape(input.reseller.name)}</h1>

<div class="card">
  <h2 style="margin:0 0 12px">Terms</h2>
  <form method="post" action="/console/resellers/${escape(input.reseller.resellerId)}">
    <input type="hidden" name="csrf" value="${escape(input.csrf)}">
    <div class="grid">
      <div><label for="name">Name</label>
        <input class="field" id="name" name="name" value="${escape(input.reseller.name)}"></div>
      <div><label for="contactEmail">Contact email</label>
        <input class="field" id="contactEmail" name="contactEmail" type="email"
               value="${escape(input.reseller.contactEmail)}"></div>
      <div><label for="margin">Standard margin %</label>
        <input class="field" id="margin" name="margin"
               value="${(input.reseller.marginBasisPoints / 100).toFixed(2)}"></div>
      <div><label for="status">Status</label>
        <select class="field" id="status" name="status">
          ${(['active', 'closed_to_new', 'terminated'] as const).map((state) =>
            `<option value="${state}"${input.reseller.status === state ? ' selected' : ''}>${
              state === 'active' ? 'Active' : state === 'closed_to_new'
                ? 'Closed to new business' : 'Terminated'}</option>`).join('')}
      </select></div>
    </div>
    <label for="banded">Commission model</label>
    <select class="field" id="banded" name="banded">
      <option value="banded"${input.reseller.banded !== false ? ' selected' : ''}>
        Volume programme, 20% to 50% by book size</option>
      <option value="flat"${input.reseller.banded === false ? ' selected' : ''}>
        Flat rate: the standard margin above, whatever they sell</option>
    </select>
    <p class="hint">Changing the standard margin does not restate past statements, and does
    not change any customer who was given their own rate. On the volume programme the standard
    margin is used only if the reseller is later moved off it.</p>
    <div class="actions"><button class="btn primary" type="submit">Save terms</button></div>
  </form>
</div>

<div class="card">
  <h2 style="margin:0 0 6px">Exclusive territory</h2>
  <p class="sub" style="margin:0 0 12px">Postcode areas this reseller holds alone. An enquiry
  from one of them is routed to them. An area already held by somebody else is refused rather
  than granted twice.</p>
  ${input.territories.length === 0
    ? `<p class="sub" style="margin:0 0 12px">No territory granted yet.</p>`
    : `<p style="margin:0 0 12px">${input.territories.map((area) =>
        `<span class="pill active" style="margin-right:6px">${escape(area)}</span>`).join('')}</p>`}
  <form method="post" action="/console/resellers/${escape(input.reseller.resellerId)}/territory">
    <input type="hidden" name="csrf" value="${escape(input.csrf)}">
    <div class="grid">
      <div><label for="area">Grant a postcode area</label>
        <input class="field" id="area" name="area" placeholder="M, EH, SW1"></div>
      <div><label for="withdraw">Withdraw an area</label>
        <input class="field" id="withdraw" name="withdraw" placeholder="M"></div>
    </div>
    <div class="actions"><button class="btn primary" type="submit">Update territory</button></div>
  </form>
</div>

<div class="card">
  <h2 style="margin:0 0 6px">Portal access</h2>
  ${input.portalUserExists
    ? `<p class="sub" style="margin:0">${escape(input.reseller.contactEmail)} can sign in to
       the reseller portal. If they have forgotten their password they can reset it there.</p>`
    : `<p class="sub" style="margin:0 0 12px">No portal sign-in exists for this reseller yet.
       Creating one invites ${escape(input.reseller.contactEmail)} to set a password. They will
       see their own customers, spend and commission. Nothing else, and never the inside of a
       customer's account.</p>
      <form method="post" action="/console/resellers/${escape(input.reseller.resellerId)}/portal">
        <input type="hidden" name="csrf" value="${escape(input.csrf)}">
        <button class="btn" type="submit">Create portal sign-in</button>
      </form>`}
</div>

<div class="card">
  <h2 style="margin:0 0 12px">Customers</h2>
  ${input.customers.length === 0
    ? `<p class="sub" style="margin:0 0 14px">No customers are attached to this reseller.</p>`
    : `<table>
    <thead><tr><th>Customer</th><th>Since</th><th class="n">Margin</th><th></th></tr></thead>
    <tbody>${input.customers.map((customer) => `<tr>
      <td>${escape(customer.name)}</td>
      <td>${escape(customer.since.slice(0, 10))}</td>
      <td class="n">${(customer.marginBasisPoints / 100).toFixed(2)}%${
        customer.isOverride ? ' <span class="pill">override</span>' : ''}</td>
      <td class="n"><form method="post"
        action="/console/resellers/${escape(input.reseller.resellerId)}/unlink">
        <input type="hidden" name="csrf" value="${escape(input.csrf)}">
        <input type="hidden" name="accountId" value="${escape(customer.accountId)}">
        <button class="btn" type="submit">Detach</button></form></td>
    </tr>`).join('')}</tbody></table>`}
</div>

<h2>Statements</h2>
${input.statements.length === 0
  ? `<div class="card"><p class="sub" style="margin:0">Nothing invoiced yet.</p></div>`
  : input.statements.map((statement) => `<h3>${escape(statement.period)}</h3>
    <div class="card"><table>
      <thead><tr><th>Invoice</th><th>Customer</th><th class="n">Net</th>
        <th class="n">Margin</th><th class="n">Commission</th><th>State</th></tr></thead>
      <tbody>${statement.lines.map((line) => `<tr>
        <td>${escape(line.invoiceNumber ?? line.invoiceId)}</td>
        <td>${escape(line.accountId)}</td>
        <td class="n">${escape(format(line.netAmount))}</td>
        <td class="n">${(line.marginBasisPoints / 100).toFixed(2)}%</td>
        <td class="n">${escape(format(line.commission))}</td>
        <td>${escape(line.state)}</td></tr>`).join('')}</tbody>
      <tfoot><tr><td colspan="4"><b>Payable</b></td>
        <td class="n"><b>${escape(format(statement.commissionEarned))}</b></td><td></td></tr></tfoot>
    </table></div>`).join('')}`,
  );
}

/**
 * The reseller picker shown on an account.
 *
 * Rendered as part of the account page rather than as a page of its own: which
 * reseller a customer belongs to is a fact about the customer.
 */
export function accountResellerControl(input: {
  readonly csrf: string;
  readonly accountId: string;
  readonly resellers: readonly Reseller[];
  readonly currentResellerId?: string;
  readonly currentMarginBasisPoints?: number;
  readonly isOverride: boolean;
}): string {
  return `<div class="card">
  <h2 style="margin:0 0 6px">Reseller</h2>
  <p class="sub" style="margin:0 0 12px">Who sold this customer, and what they earn on it.
  Detaching or reassigning does not alter commission already earned.</p>
  <form method="post" action="/console/accounts/${escape(input.accountId)}/reseller">
    <input type="hidden" name="csrf" value="${escape(input.csrf)}">
    <label for="resellerId">Sold by</label>
    <select class="field" id="resellerId" name="resellerId">
      <option value="">Direct: no reseller</option>
      ${input.resellers.map((reseller) => `<option value="${escape(reseller.resellerId)}"${
        input.currentResellerId === reseller.resellerId ? ' selected' : ''
      }>${escape(reseller.name)} (${(reseller.marginBasisPoints / 100).toFixed(2)}%)</option>`).join('')}
    </select>
    <label for="overrideMargin">Margin for this customer only, %</label>
    <input class="field" id="overrideMargin" name="overrideMargin"
           value="${input.isOverride && input.currentMarginBasisPoints !== undefined
             ? (input.currentMarginBasisPoints / 100).toFixed(2) : ''}"
           placeholder="Leave blank to use the reseller's standard rate">
    <div class="actions"><button class="btn primary" type="submit">Save</button></div>
  </form>
</div>`;
}
