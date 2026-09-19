import { format, type Money } from '@detent/awa-billing';
import { nextBand, type CommissionStatement, type Reseller } from '@detent/awa-reseller';
import type { AuthUser } from '@detent/awa-auth';
import { escape, page } from './site-html.js';

/**
 * The reseller portal.
 *
 * A reseller sees their own book and nothing else: their customers, what those
 * customers have spent, and what that earns them. They do not see another
 * reseller's customers, and they do not see the inside of a customer's account
 *: a reseller is owed a commercial relationship, not their customer's
 * conversations, knowledge or visitors.
 *
 * The figures here come from the same calculator the back office pays against.
 * A portal that computes commission its own way is a monthly argument.
 */

const NAV = (current: string) => [
  { href: '/reseller', label: 'Overview', current: current === 'overview' },
  { href: '/reseller/customers', label: 'Customers', current: current === 'customers' },
  { href: '/reseller/statements', label: 'Statements', current: current === 'statements' },
];

const STYLES = `<style>
  .figures{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;
   margin:0 0 22px}
  .figure{border:1px solid #E3E8EF;border-radius:11px;padding:16px 18px;background:#fff}
  .figure .n{font-size:26px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .figure .l{color:#5B6B7F;font-size:12.5px;text-transform:uppercase;letter-spacing:.07em;
   margin-bottom:6px}
  .figure .h{color:#5B6B7F;font-size:12.5px;margin-top:6px}
  table{width:100%;border-collapse:collapse;font-size:14.5px}
  th{text-align:left;font-size:12px;text-transform:uppercase;letter-spacing:.07em;
   color:#5B6B7F;padding:0 10px 8px 0;font-weight:600}
  td{padding:10px 10px 10px 0;border-top:1px solid #EEF2F6;font-variant-numeric:tabular-nums}
  td.n,th.n{text-align:right}
  .pill{display:inline-block;font-size:11.5px;padding:2px 8px;border-radius:20px;
   text-transform:uppercase;letter-spacing:.05em}
  .pill.earned{background:#E7F3EC;color:#1E6C3B}
  .pill.pending{background:#FDF3E3;color:#8A5A12}
</style>`;

function figure(label: string, value: string, hint?: string): string {
  return `<div class="figure"><div class="l">${escape(label)}</div>
    <div class="n">${escape(value)}</div>
    ${hint ? `<div class="h">${escape(hint)}</div>` : ''}</div>`;
}

export interface ResellerOverviewInput {
  readonly user: AuthUser;
  readonly reseller: Reseller;
  readonly statements: readonly CommissionStatement[];
  readonly lifetime: {
    readonly collectedSpend: Money;
    readonly commissionEarned: Money;
    readonly commissionPending: Money;
  };
  readonly customerCount: number;
  readonly territories: readonly string[];
}

export function resellerOverviewPage(input: ResellerOverviewInput): string {
  const latest = input.statements[0];
  return page(
    { title: 'Overview', site: 'app', nav: NAV('overview'), user: input.user.email },
    `${STYLES}
<h1>${escape(input.reseller.name)}</h1>
${(() => {
    const band = input.statements[0]?.band;
    if (!band) {
      return `<p class="sub">Your margin is ${(input.reseller.marginBasisPoints / 100).toFixed(2)}%
        of what your customers spend, net of VAT.</p>`;
    }
    const upcoming = nextBand(input.lifetime.collectedSpend);
    return `<p class="sub">You are on <b>${escape(band.label)}</b> , 
      ${(band.basisPoints / 100).toFixed(0)}% of what your customers spend, net of VAT.${
      upcoming
        ? ` ${escape(format({ ...input.lifetime.collectedSpend, amount: upcoming.shortfall }))}
            more collected takes you to ${escape(upcoming.band.label)} at
            ${(upcoming.band.basisPoints / 100).toFixed(0)}%.`
        : ' This is the top band.'}</p>`;
  })()}
${input.territories.length > 0
  ? `<p class="sub">Your exclusive territory:
     ${input.territories.map((area) => escape(area)).join(', ')}. Enquiries from these postcode
     areas come to you.</p>`
  : ''}

<div class="figures">
  ${figure('Commission earned', format(input.lifetime.commissionEarned),
    'On invoices your customers have paid')}
  ${figure('Commission pending', format(input.lifetime.commissionPending),
    'Invoiced, not yet paid by the customer')}
  ${figure('Customer spend', format(input.lifetime.collectedSpend), 'Collected, net of VAT')}
  ${figure('Customers', String(input.customerCount))}
</div>

${latest ? `<h2>${escape(latest.period)}</h2>
${statementTable(latest)}` : `<div class="card"><p class="sub" style="margin:0">
Nothing has been invoiced yet. Commission appears here as your customers are billed.</p></div>`}

<div class="card">
  <h2 style="margin:0 0 6px">How this is worked out</h2>
  <p class="sub" style="margin:0 0 8px">Commission is earned when your customer pays, not
  when they are invoiced. An unpaid invoice shows as pending so you can see what is coming.</p>
  <p class="sub" style="margin:0">It is calculated on the net amount. VAT is collected for
  HMRC and is not revenue, so it is not commissionable.</p>
</div>`,
  );
}

export function statementTable(statement: CommissionStatement): string {
  if (statement.lines.length === 0) {
    return `<div class="card"><p class="sub" style="margin:0">Nothing invoiced in this period.</p></div>`;
  }
  return `<div class="card"><table>
  <thead><tr>
    <th>Invoice</th><th>Customer</th><th class="n">Net spend</th>
    <th class="n">Margin</th><th class="n">Commission</th><th>State</th>
  </tr></thead>
  <tbody>${statement.lines.map((line) => `<tr>
    <td>${escape(line.invoiceNumber ?? line.invoiceId)}</td>
    <td>${escape(line.accountId)}</td>
    <td class="n">${escape(format(line.netAmount))}</td>
    <td class="n">${(line.marginBasisPoints / 100).toFixed(2)}%</td>
    <td class="n">${escape(format(line.commission))}</td>
    <td><span class="pill ${line.state}">${escape(line.state)}</span></td>
  </tr>`).join('')}</tbody>
  <tfoot><tr>
    <td colspan="2"><b>Earned this period</b></td>
    <td class="n"><b>${escape(format(statement.collectedSpend))}</b></td>
    <td></td>
    <td class="n"><b>${escape(format(statement.commissionEarned))}</b></td>
    <td></td>
  </tr></tfoot>
</table></div>`;
}

export function resellerStatementsPage(input: {
  readonly user: AuthUser;
  readonly reseller: Reseller;
  readonly statements: readonly CommissionStatement[];
}): string {
  return page(
    { title: 'Statements', site: 'app', nav: NAV('statements'), user: input.user.email },
    `${STYLES}
<h1>Statements</h1>
<p class="sub">One per month, newest first.</p>
${input.statements.length === 0
  ? `<div class="card"><p class="sub" style="margin:0">No statements yet.</p></div>`
  : input.statements.map((statement) => `<h2>${escape(statement.period)}</h2>
      ${statementTable(statement)}`).join('')}`,
  );
}

export function resellerCustomersPage(input: {
  readonly user: AuthUser;
  readonly reseller: Reseller;
  readonly customers: readonly {
    readonly accountId: string;
    readonly name: string;
    readonly since: string;
    readonly marginBasisPoints: number;
    readonly lifetimeSpend: Money;
    readonly lifetimeCommission: Money;
  }[];
}): string {
  return page(
    { title: 'Customers', site: 'app', nav: NAV('customers'), user: input.user.email },
    `${STYLES}
<h1>Your customers</h1>
<p class="sub">What each has spent and what it has earned you. You cannot see inside a
customer's account: their conversations, knowledge and visitors are theirs.</p>
${input.customers.length === 0
  ? `<div class="card"><p class="sub" style="margin:0">No customers linked to you yet.</p></div>`
  : `<div class="card"><table>
  <thead><tr><th>Customer</th><th>Since</th><th class="n">Margin</th>
    <th class="n">Spend</th><th class="n">Commission</th></tr></thead>
  <tbody>${input.customers.map((customer) => `<tr>
    <td>${escape(customer.name)}</td>
    <td>${escape(customer.since.slice(0, 10))}</td>
    <td class="n">${(customer.marginBasisPoints / 100).toFixed(2)}%</td>
    <td class="n">${escape(format(customer.lifetimeSpend))}</td>
    <td class="n">${escape(format(customer.lifetimeCommission))}</td>
  </tr>`).join('')}</tbody></table></div>`}`,
  );
}
