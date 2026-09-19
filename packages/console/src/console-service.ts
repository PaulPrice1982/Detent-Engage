import type { AuditLog } from '@detent/awa-audit';
import { AwaError, type Clock, systemClock } from '@detent/awa-core';
import {
  CreditLedger, DunningService, InvoiceService, SubscriptionService,
  format, money, type CreditBalance, type Money, type PlanCode, type PlanOverride,
} from '@detent/awa-billing';
import type { PaymentService, ProviderRef } from '@detent/awa-payments';
import { ApprovalService, type OperatorAction } from './approvals.js';
import { ForbiddenError, require as requireCapability, type ConsoleUser } from './rbac.js';

/**
 * The operator console's domain service.
 *
 * Every commercial action in Detent goes through here, and every one of them
 * follows the same three steps without exception:
 *
 *   1. **Check the capability.** Role and MFA.
 *   2. **Request approval.** Which is a formality below the threshold and a
 *      second human above it, but always happens, so the path cannot be
 *      skipped for small amounts and then quietly reused for large ones.
 *   3. **Claim the approval, then act.** The claim re-fingerprints what is
 *      about to happen against what was approved.
 *
 * If an action is added later that does not follow this shape, that is the bug.
 */

export interface ConsoleDeps {
  readonly approvals: ApprovalService;
  readonly credits: CreditLedger;
  readonly invoices: InvoiceService;
  readonly subscriptions: SubscriptionService;
  readonly dunning: DunningService;
  readonly payments: PaymentService;
  readonly audit: AuditLog;
  readonly clock?: Clock;
}

export interface AccountSummary {
  readonly accountId: string;
  readonly tenantId: string;
  readonly planCode?: PlanCode;
  readonly subscriptionStatus?: string;
  readonly credits: CreditBalance;
  readonly overdueCount: number;
  readonly overdueAmount: Money;
  readonly dunningStage: string;
  readonly pendingApprovals: number;
}

export class ConsoleService {
  private readonly clock: Clock;

  constructor(private readonly deps: ConsoleDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** The account overview an operator opens first. Read-only. */
  async summary(user: ConsoleUser, accountId: string, tenantId: string): Promise<AccountSummary> {
    requireCapability(user, 'account.read');
    const subscription = await this.deps.subscriptions.byTenant(tenantId);
    const credits = await this.deps.credits.balance(accountId);
    const overdue = await this.deps.invoices.overdue(accountId, this.clock.iso());
    const dunning = await this.deps.dunning.assess(accountId, overdue);
    const pending = await this.deps.approvals.forAccount(accountId);

    return {
      accountId,
      tenantId,
      planCode: subscription?.planCode,
      subscriptionStatus: subscription?.status,
      credits,
      overdueCount: overdue.length,
      overdueAmount: money(
        overdue.reduce((total, invoice) => total + invoice.amountDue.amount, 0),
        credits.total.currency,
      ),
      dunningStage: dunning.stage,
      pendingApprovals: pending.filter((action) => action.state === 'pending').length,
    };
  }

  /**
   * Grants credit.
   *
   * The commonest console action and the easiest to abuse: credit is money the
   * customer can spend, granted by typing a number. Above £500 it needs a
   * second person.
   */
  async grantCredit(user: ConsoleUser, input: {
    readonly actionId: string;
    readonly accountId: string;
    readonly tenantId: string;
    readonly amount: Money;
    readonly kind: 'grant_goodwill' | 'grant_promotional' | 'grant_purchased';
    readonly expiresAt: string;
    readonly reason: string;
  }): Promise<OperatorAction> {
    requireCapability(user, 'credit.grant');
    return this.deps.approvals.request({
      actionId: input.actionId,
      capability: 'credit.grant',
      accountId: input.accountId,
      tenantId: input.tenantId,
      summary: `Grant ${format(input.amount)} of ${input.kind.replace('grant_', '')} credit`,
      amount: input.amount,
      arguments: {
        accountId: input.accountId, amount: input.amount.amount,
        currency: input.amount.currency, kind: input.kind, expiresAt: input.expiresAt,
      },
      reason: input.reason,
      requestedBy: user,
    });
  }

  /** Executes an approved credit grant. */
  async executeCreditGrant(user: ConsoleUser, actionId: string): Promise<void> {
    requireCapability(user, 'credit.grant');
    const action = await this.deps.approvals.forAction(actionId);
    const args = action.arguments;
    await this.deps.approvals.claim(actionId, {
      capability: 'credit.grant',
      accountId: action.accountId,
      amount: action.amount,
      arguments: args,
    });
    await this.deps.credits.grant({
      accountId: action.accountId,
      kind: args['kind'] as 'grant_goodwill',
      amount: money(args['amount'] as number, (args['currency'] as 'GBP') ?? 'GBP'),
      expiresAt: args['expiresAt'] as string,
      reason: action.reason,
      grantedBy: user.userId,
      // The action id correlates the grant to the approval that authorised it,
      // so the ledger entry and the two-person record replay together.
      correlationId: actionId,
    });
    await this.deps.audit.write({
      tenantId: action.tenantId, type: 'credit_granted', actor: 'platform_admin',
      correlationId: actionId,
      payload: {
        accountId: action.accountId, amount: args['amount'], currency: args['currency'],
        kind: args['kind'], reason: action.reason,
        requestedBy: action.requestedBy, approvedBy: action.approvedBy, executedBy: user.userId,
      },
    });
  }

  /**
   * Takes a payment with the customer present.
   *
   * `offSession: false` because an operator taking a payment is on the phone to
   * the customer, so a 3-D Secure challenge can actually be answered. Marking it
   * off-session would fail every challenged card and look like a decline.
   */
  async takePayment(user: ConsoleUser, input: {
    readonly actionId: string;
    readonly paymentId: string;
    readonly accountId: string;
    readonly tenantId: string;
    readonly amount: Money;
    readonly paymentMethodRef: ProviderRef;
    readonly description: string;
    readonly reference?: string;
    readonly reason: string;
  }): Promise<OperatorAction> {
    requireCapability(user, 'payment.take');
    return this.deps.approvals.request({
      actionId: input.actionId,
      capability: 'payment.take',
      accountId: input.accountId,
      tenantId: input.tenantId,
      summary: `Take ${format(input.amount)}, ${input.description}`,
      amount: input.amount,
      arguments: {
        paymentId: input.paymentId, amount: input.amount.amount,
        currency: input.amount.currency, paymentMethodRef: input.paymentMethodRef,
        description: input.description, reference: input.reference,
      },
      reason: input.reason,
      requestedBy: user,
    });
  }

  async executePayment(user: ConsoleUser, actionId: string): Promise<void> {
    requireCapability(user, 'payment.take');
    const action = await this.deps.approvals.forAction(actionId);
    const args = action.arguments;
    await this.deps.approvals.claim(actionId, {
      capability: 'payment.take', accountId: action.accountId,
      amount: action.amount, arguments: args,
    });
    await this.deps.payments.take({
      paymentId: args['paymentId'] as string,
      accountId: action.accountId,
      tenantId: action.tenantId,
      amount: money(args['amount'] as number, (args['currency'] as 'GBP') ?? 'GBP'),
      paymentMethodRef: args['paymentMethodRef'] as ProviderRef,
      description: args['description'] as string,
      reference: args['reference'] as string | undefined,
      // The operator is with the customer, so a challenge can be answered.
      offSession: false,
      // The action id is the idempotency key: one approved action, one charge,
      // however many times the button is pressed.
      idempotencyKey: actionId,
      actor: user.userId,
    });
  }

  /** Refunds. Always a decision, never automatic. */
  async refund(user: ConsoleUser, input: {
    readonly actionId: string;
    readonly paymentId: string;
    readonly accountId: string;
    readonly tenantId: string;
    readonly amount?: Money;
    readonly reason: string;
  }): Promise<OperatorAction> {
    requireCapability(user, 'payment.refund');
    return this.deps.approvals.request({
      actionId: input.actionId,
      capability: 'payment.refund',
      accountId: input.accountId,
      tenantId: input.tenantId,
      summary: `Refund ${input.amount ? format(input.amount) : 'in full'} on ${input.paymentId}`,
      amount: input.amount,
      arguments: {
        paymentId: input.paymentId,
        amount: input.amount?.amount ?? null,
        currency: input.amount?.currency ?? null,
      },
      reason: input.reason,
      requestedBy: user,
    });
  }

  async executeRefund(user: ConsoleUser, actionId: string): Promise<void> {
    requireCapability(user, 'payment.refund');
    const action = await this.deps.approvals.forAction(actionId);
    const args = action.arguments;
    await this.deps.approvals.claim(actionId, {
      capability: 'payment.refund', accountId: action.accountId,
      amount: action.amount, arguments: args,
    });
    const amount = args['amount'] === null
      ? undefined
      : money(args['amount'] as number, (args['currency'] as 'GBP') ?? 'GBP');
    await this.deps.payments.refund({
      paymentId: args['paymentId'] as string,
      tenantId: action.tenantId,
      amount,
      reason: action.reason,
      idempotencyKey: actionId,
      actor: user.userId,
    });
  }

  /**
   * Overrides a plan.
   *
   * Always dual control regardless of amount: an override changes what a
   * customer pays every month until someone changes it back, so its value is
   * unbounded and a threshold cannot express the risk.
   */
  async overridePlan(user: ConsoleUser, input: {
    readonly actionId: string;
    readonly accountId: string;
    readonly tenantId: string;
    readonly subscriptionId: string;
    readonly override: Omit<PlanOverride, 'approvedBy' | 'approvedAt'>;
    readonly reason: string;
  }): Promise<OperatorAction> {
    requireCapability(user, 'plan.override');
    return this.deps.approvals.request({
      actionId: input.actionId,
      capability: 'plan.override',
      accountId: input.accountId,
      tenantId: input.tenantId,
      summary: `Override plan terms on ${input.subscriptionId}`,
      arguments: {
        subscriptionId: input.subscriptionId,
        override: input.override as unknown as Record<string, unknown>,
      },
      reason: input.reason,
      requestedBy: user,
    });
  }

  /** Raises or lowers a tenant's spend cap. */
  async changeSpendCap(user: ConsoleUser, input: {
    readonly actionId: string;
    readonly accountId: string;
    readonly tenantId: string;
    readonly newCap: Money;
    readonly reason: string;
  }): Promise<OperatorAction> {
    requireCapability(user, 'spend_cap.change');
    return this.deps.approvals.request({
      actionId: input.actionId,
      capability: 'spend_cap.change',
      accountId: input.accountId,
      tenantId: input.tenantId,
      summary: `Set spend cap to ${format(input.newCap)}`,
      amount: input.newCap,
      arguments: { newCapPence: input.newCap.amount, currency: input.newCap.currency },
      reason: input.reason,
      requestedBy: user,
    });
  }

  /** Pauses the dunning ladder. Support may do this alone: it only helps. */
  async holdDunning(user: ConsoleUser, input: {
    readonly accountId: string;
    readonly tenantId: string;
    readonly untilIso: string;
    readonly reason: string;
  }): Promise<void> {
    requireCapability(user, 'dunning.hold');
    await this.deps.dunning.hold(input.accountId, input.untilIso, input.reason);
    await this.deps.audit.write({
      tenantId: input.tenantId, type: 'operator_action_executed', actor: 'platform_admin',
      correlationId: `hold_${input.accountId}`,
      payload: {
        capability: 'dunning.hold', accountId: input.accountId,
        untilIso: input.untilIso, reason: input.reason, executedBy: user.userId,
      },
    });
  }

  async pendingApprovals(user: ConsoleUser): Promise<readonly OperatorAction[]> {
    requireCapability(user, 'account.list');
    return this.deps.approvals.pending();
  }

  /** Approve on behalf of a second person. */
  async approve(user: ConsoleUser, actionId: string): Promise<OperatorAction> {
    return this.deps.approvals.approve(actionId, user);
  }

  async reject(user: ConsoleUser, actionId: string, reason: string): Promise<OperatorAction> {
    return this.deps.approvals.reject(actionId, user, reason);
  }
}

export { ForbiddenError, AwaError };
