import type { ConsoleService, ConsoleUser, OperatorAction } from '@detent/awa-console';
import { can } from '@detent/awa-console';
import { format, type Money } from '@detent/awa-billing';
import { escape, page, pill, statCard } from './site-html.js';

/**
 * The Detent operator back office, as a site.
 *
 * It is a **separate site** from the customer's install-and-manage app, not a
 * privileged corner of it. They share the billing domain and nothing else: a
 * different host, a different session, a different identity provider, and no
 * route on the customer app can ever escalate into this one. The two audiences
 * are Detent staff and Detent customers, and a bug that lets one see the other
 * is the worst bug this system could have.
 *
 * Pages are read-mostly by design. Anything that moves money is a form that
 * submits to the console API, which runs the request-approve-claim sequence in
 * `ConsoleService`. There is no way to act from this site that skips it.
 */

export interface ConsolePageRequest {
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly user: ConsoleUser;
}

const NAV = (current: string) => [
  { href: '/console', label: 'Accounts', current: current === 'accounts' },
  { href: '/console/approvals', label: 'Approvals', current: current === 'approvals' },
  { href: '/console/audit', label: 'Audit', current: current === 'audit' },
  // The two sites are separate, but a development server hosts both, and an
  // operator who cannot get back to the service page has to retype a URL.
  { href: '/', label: 'Service' },
];

export class ConsoleSite {
  constructor(private readonly service: ConsoleService) {}

  async render(request: ConsolePageRequest): Promise<{ status: number; html: string }> {
    const path = request.path.replace(/^\/console\/?/, '');
    try {
      if (path === '' || path === 'accounts') return { status: 200, html: await this.accounts(request) };
      if (path === 'approvals') return { status: 200, html: await this.approvals(request) };
      if (path.startsWith('accounts/')) {
        return { status: 200, html: await this.account(request, decodeURIComponent(path.slice(9))) };
      }
      return { status: 404, html: this.problem(request, 'Not found', 'No such page in the back office.') };
    } catch (error) {
      // A forbidden action is a normal outcome in a console, not a crash. It is
      // shown as a page so the operator learns which capability they lack
      // rather than seeing a stack trace.
      const message = error instanceof Error ? error.message : 'Something went wrong.';
      return { status: 403, html: this.problem(request, 'Not permitted', message) };
    }
  }

  private problem(request: ConsolePageRequest, title: string, detail: string): string {
    return page(
      { title, site: 'console', nav: NAV(''), user: request.user.email },
      `<h1>${escape(title)}</h1><p class="sub">${escape(detail)}</p>`,
    );
  }

  /**
   * The accounts list.
   *
   * Deliberately shows commercial state first, overdue, dunning stage, credit
   *, rather than usage. An operator opening this page is answering "who needs
   * attention", and sorting by anything else buries the answer.
   */
  private async accounts(request: ConsolePageRequest): Promise<string> {
    const pending = await this.service.pendingApprovals(request.user);
    const banner = pending.length > 0
      ? `${pending.length} action${pending.length === 1 ? '' : 's'} awaiting a second approver.`
      : undefined;

    const rows = pending.length === 0
      ? ''
      : pending.map((action) => `<tr>
          <td><a class="link" href="/console/accounts/${encodeURIComponent(action.accountId)}">${escape(action.accountId)}</a></td>
          <td>${escape(action.summary)}</td>
          <td>${escape(action.requestedBy)}</td>
          <td class="num">${escape(action.amount ? format(action.amount) : ', ')}</td>
        </tr>`).join('');

    return page(
      { title: 'Accounts', site: 'console', nav: NAV('accounts'), user: request.user.email, banner },
      `<h1>Accounts</h1>
<p class="sub">Commercial state across every tenant. Accounts needing attention first.</p>
${rows
  ? `<h2>Awaiting approval</h2><table>
<thead><tr><th>Account</th><th>Action</th><th>Requested by</th><th class="num">Amount</th></tr></thead>
<tbody>${rows}</tbody></table>`
  : '<div class="empty">Nothing is waiting for a second approver.</div>'}
<h2>Find an account</h2>
<form class="card" method="get" action="/console/accounts">
  <label for="q">Account or tenant id</label>
  <div class="actions">
    <input id="q" name="q" class="btn" style="min-width:280px" placeholder="acc_… or t_…">
    <button class="btn primary" type="submit">Open</button>
  </div>
</form>`,
    );
  }

  /** One account: money first, then what an operator can do about it. */
  private async account(request: ConsolePageRequest, accountId: string): Promise<string> {
    const tenantId = request.query['tenant'] ?? accountId;
    const summary = await this.service.summary(request.user, accountId, tenantId);
    const actions = await this.service.pendingApprovals(request.user);
    const mine = actions.filter((action) => action.accountId === accountId);

    const dunningTone = summary.dunningStage === 'current' ? 'ok'
      : summary.dunningStage === 'suspended' || summary.dunningStage === 'terminated' ? 'bad' : 'warn';

    const money_ = (value: Money) => format(value);
    const permitted = (capability: Parameters<typeof can>[1]) => can(request.user, capability);

    return page(
      { title: accountId, site: 'console', nav: NAV('accounts'), user: request.user.email },
      `<h1>${escape(accountId)}</h1>
<p class="sub">Tenant <code>${escape(tenantId)}</code> · plan ${escape(summary.planCode ?? 'none')}
 · subscription ${escape(summary.subscriptionStatus ?? 'none')} · ${pill(summary.dunningStage, dunningTone)}</p>

<div class="grid">
  ${statCard('Credit balance', money_(summary.credits.total),
    `${money_(summary.credits.expiringWithin30Days)} expires within 30 days`)}
  ${statCard('Refundable', money_(summary.credits.refundable), 'Purchased credit only')}
  ${statCard('Overdue', money_(summary.overdueAmount),
    `${summary.overdueCount} invoice${summary.overdueCount === 1 ? '' : 's'}`)}
  ${statCard('Awaiting approval', String(summary.pendingApprovals), 'On this account')}
</div>

<h2>Actions</h2>
<div class="card">
  <p class="sub" style="margin:0 0 10px">Every action below is recorded against your name.
  Above the dual-control threshold a second person must approve before it takes effect.</p>
  <div class="actions">
    ${this.actionButton('Grant credit', `/console/accounts/${encodeURIComponent(accountId)}/credit`, permitted('credit.grant'))}
    ${this.actionButton('Take payment', `/console/accounts/${encodeURIComponent(accountId)}/payment`, permitted('payment.take'))}
    ${this.actionButton('Refund', `/console/accounts/${encodeURIComponent(accountId)}/refund`, permitted('payment.refund'))}
    ${this.actionButton('Change spend cap', `/console/accounts/${encodeURIComponent(accountId)}/spend-cap`, permitted('spend_cap.change'))}
    ${this.actionButton('Override plan', `/console/accounts/${encodeURIComponent(accountId)}/plan`, permitted('plan.override'))}
    ${this.actionButton('Hold dunning', `/console/accounts/${encodeURIComponent(accountId)}/hold`, permitted('dunning.hold'))}
  </div>
</div>

<h2>Credit lots</h2>
${summary.credits.lots.length === 0
  ? '<div class="empty">No credit has been granted to this account.</div>'
  : `<table><thead><tr><th>Lot</th><th>Kind</th><th class="num">Remaining</th><th>Expires</th></tr></thead>
<tbody>${summary.credits.lots.map((lot) => `<tr>
  <td><code>${escape(lot.lotId)}</code></td>
  <td>${escape(lot.kind.replace('grant_', ''))}</td>
  <td class="num">${escape(money_(lot.remaining))}</td>
  <td>${escape(lot.expiresAt ? lot.expiresAt.slice(0, 10) : 'never')}</td>
</tr>`).join('')}</tbody></table>`}

${mine.length === 0 ? '' : `<h2>Pending on this account</h2>
<table><thead><tr><th>Action</th><th>Requested by</th><th class="num">Amount</th><th></th></tr></thead>
<tbody>${mine.map((action) => this.pendingRow(action, request.user)).join('')}</tbody></table>`}`,
    );
  }

  /** The approvals queue: the second pair of eyes, as a worklist. */
  private async approvals(request: ConsolePageRequest): Promise<string> {
    const pending = await this.service.pendingApprovals(request.user);
    return page(
      { title: 'Approvals', site: 'console', nav: NAV('approvals'), user: request.user.email },
      `<h1>Approvals</h1>
<p class="sub">Actions held for a second person. You cannot approve your own request,
or an action you would not be permitted to carry out yourself.</p>
${pending.length === 0
  ? '<div class="empty">Nothing is waiting.</div>'
  : `<table><thead><tr><th>Account</th><th>Action</th><th>Requested by</th>
<th class="num">Amount</th><th>Reason</th><th></th></tr></thead>
<tbody>${pending.map((action) => `<tr class="dual">
  <td><a class="link" href="/console/accounts/${encodeURIComponent(action.accountId)}">${escape(action.accountId)}</a></td>
  <td>${escape(action.summary)}</td>
  <td>${escape(action.requestedBy)}</td>
  <td class="num">${escape(action.amount ? format(action.amount) : ', ')}</td>
  <td>${escape(action.reason)}</td>
  <td>${this.approveControls(action, request.user)}</td>
</tr>`).join('')}</tbody></table>`}`,
    );
  }

  private pendingRow(action: OperatorAction, user: ConsoleUser): string {
    return `<tr class="dual">
  <td>${escape(action.summary)}</td>
  <td>${escape(action.requestedBy)}</td>
  <td class="num">${escape(action.amount ? format(action.amount) : ', ')}</td>
  <td>${this.approveControls(action, user)}</td>
</tr>`;
  }

  /**
   * Approve controls, or the reason they are absent.
   *
   * Showing a disabled button with the reason beats hiding it: an operator who
   * cannot see the control assumes the system is broken and asks someone to do
   * it for them, which is precisely the behaviour dual control exists to stop.
   */
  private approveControls(action: OperatorAction, user: ConsoleUser): string {
    if (action.requestedBy === user.userId) {
      return `<span class="pill">You requested this</span>`;
    }
    if (!can(user, 'approval.grant') || !can(user, action.capability)) {
      return `<span class="pill">Needs ${escape(action.capability)}</span>`;
    }
    const id = encodeURIComponent(action.actionId);
    return `<form method="post" action="/v1/console/approvals/${id}/approve" style="display:inline">
  <button class="btn primary" type="submit">Approve</button></form>
<form method="post" action="/v1/console/approvals/${id}/reject" style="display:inline">
  <button class="btn danger" type="submit">Reject</button></form>`;
  }

  private actionButton(label: string, href: string, permitted: boolean): string {
    return permitted
      ? `<a class="btn" href="${escape(href)}">${escape(label)}</a>`
      : `<span class="btn" style="opacity:.45;cursor:not-allowed" title="Your role does not permit this">${escape(label)}</span>`;
  }
}
