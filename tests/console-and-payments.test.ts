import { describe, expect, it } from 'vitest';
import { buildDevSites } from '../packages/server/src/dev-sites.js';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { FixedClock } from '@detent/awa-core';
import {
  CreditLedger, DunningService, InMemoryDunningStore, InMemoryInvoiceStore,
  InMemoryLedgerStore, InMemorySubscriptionStore, InvoiceService,
  SubscriptionService, money,
} from '@detent/awa-billing';
import {
  CardDataError, InMemoryPaymentStore, PaymentService, SandboxPaymentProvider,
  assertNoCardData,
} from '@detent/awa-payments';
import {
  ApprovalService, ConsoleService, ForbiddenError, InMemoryApprovalStore,
  ROLE_CAPABILITIES, can, fingerprintOf, needsSecondPerson, type ConsoleUser,
} from '@detent/awa-console';
import { ConsoleSite, escape, html } from '@detent/awa-server';

const at = (iso = '2026-03-01T09:00:00.000Z') => new FixedClock(new Date(iso));

const user = (over: Partial<ConsoleUser> = {}): ConsoleUser => ({
  userId: 'u_alex', email: 'alex@detent', name: 'Alex', roles: ['billing'],
  active: true, mfaEnrolled: true, createdAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

function build(clock = at()) {
  const audit = new AuditLog(new InMemoryAuditStore(), clock);
  const provider = new SandboxPaymentProvider('sandbox-webhook-secret', () => clock.iso());
  const payments = new PaymentService(provider, new InMemoryPaymentStore(), audit, clock);
  const approvals = new ApprovalService(new InMemoryApprovalStore(), audit, clock);
  const console_ = new ConsoleService({
    approvals,
    credits: new CreditLedger(new InMemoryLedgerStore(), audit, clock),
    invoices: new InvoiceService(new InMemoryInvoiceStore(), clock),
    subscriptions: new SubscriptionService(new InMemorySubscriptionStore(), audit, clock),
    dunning: new DunningService(new InMemoryDunningStore(), clock),
    payments, audit, clock,
  });
  return { audit, provider, payments, approvals, console: console_, clock };
}

describe('never holding card data', () => {
  it('refuses a card number wherever one is passed', () => {
    // 4242 4242 4242 4242 is a Luhn-valid test PAN.
    expect(() => assertNoCardData('4242424242424242', 'test')).toThrow(CardDataError);
    expect(() => assertNoCardData('4242 4242 4242 4242', 'test')).toThrow(CardDataError);
  });

  it('refuses a field named like a security code, whatever it holds', () => {
    expect(() => assertNoCardData({ cvv: '123' }, 'test')).toThrow(CardDataError);
    expect(() => assertNoCardData({ card_number: 'redacted' }, 'test')).toThrow(CardDataError);
  });

  it('does not trip on ordinary long numbers', () => {
    // A false positive here is an outage, so the guard checks Luhn as well.
    expect(() => assertNoCardData('INV-2026-00042 for 1234567890123', 'test')).not.toThrow();
    expect(() => assertNoCardData({ reference: 'DETENT-GB-2026-00001' }, 'test')).not.toThrow();
  });

  it('blocks a card number reaching the payment service', async () => {
    const { payments, provider } = build();
    const method = provider.attachTestMethod('a1');
    await expect(payments.take({
      paymentId: 'p1', accountId: 'a1', tenantId: 't1', amount: money(1_000),
      paymentMethodRef: method.ref, description: 'card 4242424242424242',
      idempotencyKey: 'k1', actor: 'u_alex',
    })).rejects.toThrow(CardDataError);
  });

  it('keeps only the last four digits of a stored method', async () => {
    const { provider } = build();
    const method = provider.attachTestMethod('a1');
    expect(method.last4).toBe('4242');
    expect(JSON.stringify(method)).not.toMatch(/4242424242424242/);
  });
});

describe('payments', () => {
  it('never charges twice for the same idempotency key', async () => {
    const { payments, provider } = build();
    const method = provider.attachTestMethod('a1');
    const input = {
      paymentId: 'p1', accountId: 'a1', tenantId: 't1', amount: money(42_000),
      paymentMethodRef: method.ref, description: 'Invoice 42',
      idempotencyKey: 'k1', actor: 'u_alex',
    };
    const first = await payments.take(input);
    const second = await payments.take({ ...input, paymentId: 'p2' });
    // A double charge is the one billing error a customer never forgets.
    expect(second.paymentId).toBe(first.paymentId);
    expect((await payments.listByAccount('a1')).length).toBe(1);
  });

  it('records a decline rather than throwing it away', async () => {
    const { payments, provider } = build();
    const method = provider.attachTestMethod('a1');
    const record = await payments.take({
      paymentId: 'p1', accountId: 'a1', tenantId: 't1', amount: money(1_001),
      paymentMethodRef: method.ref, description: 'Invoice 1',
      idempotencyKey: 'k1', actor: 'u_alex',
    });
    expect(record.status).toBe('failed');
    expect(record.failureCode).toBe('insufficient_funds');
  });

  it('leaves a record when the provider is unreachable, so a retry is recognised', async () => {
    const { payments, provider } = build();
    const method = provider.attachTestMethod('a1');
    const input = {
      paymentId: 'p1', accountId: 'a1', tenantId: 't1', amount: money(1_003),
      paymentMethodRef: method.ref, description: 'Invoice 1',
      idempotencyKey: 'k1', actor: 'u_alex',
    };
    const first = await payments.take(input);
    expect(first.failureCode).toBe('provider_unavailable');
    const retry = await payments.take({ ...input, paymentId: 'p2' });
    expect(retry.paymentId).toBe('p1');
  });

  it('fails an off-session charge that needs authentication instead of retrying', async () => {
    const { payments, provider } = build();
    const method = provider.attachTestMethod('a1');
    const record = await payments.take({
      paymentId: 'p1', accountId: 'a1', tenantId: 't1', amount: money(1_002),
      paymentMethodRef: method.ref, description: 'Renewal',
      idempotencyKey: 'k1', offSession: true, actor: 'system',
    });
    expect(record.failureCode).toBe('authentication_required');
  });

  it('refuses to refund more than was paid', async () => {
    const { payments, provider } = build();
    const method = provider.attachTestMethod('a1');
    await payments.take({
      paymentId: 'p1', accountId: 'a1', tenantId: 't1', amount: money(10_000),
      paymentMethodRef: method.ref, description: 'Invoice', idempotencyKey: 'k1', actor: 'u',
    });
    await payments.refund({
      paymentId: 'p1', tenantId: 't1', amount: money(6_000),
      reason: 'partial', idempotencyKey: 'r1', actor: 'u',
    });
    await expect(payments.refund({
      paymentId: 'p1', tenantId: 't1', amount: money(6_000),
      reason: 'again', idempotencyKey: 'r2', actor: 'u',
    })).rejects.toThrow(/cannot exceed/i);
  });

  it('refuses a refund without a reason', async () => {
    const { payments, provider } = build();
    const method = provider.attachTestMethod('a1');
    await payments.take({
      paymentId: 'p1', accountId: 'a1', tenantId: 't1', amount: money(10_000),
      paymentMethodRef: method.ref, description: 'Invoice', idempotencyKey: 'k1', actor: 'u',
    });
    await expect(payments.refund({
      paymentId: 'p1', tenantId: 't1', reason: '  ', idempotencyKey: 'r1', actor: 'u',
    })).rejects.toThrow();
  });

  it('rejects a webhook whose signature does not verify', async () => {
    const { payments } = build();
    const body = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', data: {} });
    await expect(payments.handleWebhook(body, 'not-a-signature', 't1')).rejects.toThrow(/signature/i);
  });

  it('ignores a replayed webhook, because providers retry as a matter of course', async () => {
    const { payments, provider } = build();
    const body = JSON.stringify({ id: 'evt_1', type: 'payment.succeeded', data: {} });
    const signature = provider.sign(body);
    expect((await payments.handleWebhook(body, signature, 't1')).handled).toBe(true);
    expect((await payments.handleWebhook(body, signature, 't1')).handled).toBe(false);
  });
});

describe('console roles', () => {
  it('does not let support move money', () => {
    const support = user({ roles: ['support'] });
    expect(can(support, 'account.read')).toBe(true);
    expect(can(support, 'credit.grant')).toBe(false);
    expect(can(support, 'payment.refund')).toBe(false);
  });

  it('does not let the owner move money, only manage people', () => {
    // Whoever can add a console user must not also be able to pay themselves,
    // or adding a user becomes a way to launder an action through an account
    // they control.
    const owner = user({ roles: ['owner'] });
    expect(can(owner, 'user.manage')).toBe(true);
    expect(can(owner, 'payment.refund')).toBe(false);
    expect(can(owner, 'credit.grant')).toBe(false);
  });

  it('refuses a money capability without MFA, whatever the role', () => {
    const admin = user({ roles: ['admin'], mfaEnrolled: false });
    expect(can(admin, 'account.read')).toBe(true);
    expect(can(admin, 'credit.grant')).toBe(false);
  });

  it('gives a disabled account nothing at all', () => {
    expect(can(user({ active: false }), 'account.read')).toBe(false);
  });

  it('never grants user.manage through a money role', () => {
    for (const role of ['viewer', 'support', 'billing', 'admin'] as const) {
      expect(ROLE_CAPABILITIES[role]).not.toContain('user.manage');
    }
  });
});

describe('two-person control', () => {
  it('lets a small grant through on one pair of hands', async () => {
    const { console: service } = build();
    const action = await service.grantCredit(user(), {
      actionId: 'act1', accountId: 'a1', tenantId: 't1', amount: money(1_000),
      kind: 'grant_goodwill', expiresAt: '2026-12-31T00:00:00.000Z', reason: 'outage',
    });
    expect(action.state).toBe('approved');
  });

  it('holds a large grant for a second person', async () => {
    const { console: service } = build();
    const action = await service.grantCredit(user(), {
      actionId: 'act1', accountId: 'a1', tenantId: 't1', amount: money(100_000),
      kind: 'grant_goodwill', expiresAt: '2026-12-31T00:00:00.000Z', reason: 'goodwill',
    });
    expect(action.state).toBe('pending');
    await expect(service.executeCreditGrant(user(), 'act1')).rejects.toThrow(/not approved/i);
  });

  it('will not let the requester approve their own action', async () => {
    const { console: service } = build();
    const alex = user({ roles: ['admin'] });
    await service.grantCredit(alex, {
      actionId: 'act1', accountId: 'a1', tenantId: 't1', amount: money(100_000),
      kind: 'grant_goodwill', expiresAt: '2026-12-31T00:00:00.000Z', reason: 'goodwill',
    });
    await expect(service.approve(alex, 'act1')).rejects.toThrow(ForbiddenError);
  });

  it('will not let someone approve what they could not do themselves', async () => {
    // Approving beyond your own authority is rubber-stamping.
    const { console: service } = build();
    await service.grantCredit(user({ roles: ['admin'] }), {
      actionId: 'act1', accountId: 'a1', tenantId: 't1', amount: money(100_000),
      kind: 'grant_goodwill', expiresAt: '2026-12-31T00:00:00.000Z', reason: 'goodwill',
    });
    const supporter = user({ userId: 'u_sam', roles: ['support'] });
    await expect(service.approve(supporter, 'act1')).rejects.toThrow(ForbiddenError);
  });

  it('executes once a second person has approved', async () => {
    const { console: service } = build();
    await service.grantCredit(user({ roles: ['admin'] }), {
      actionId: 'act1', accountId: 'a1', tenantId: 't1', amount: money(100_000),
      kind: 'grant_goodwill', expiresAt: '2026-12-31T00:00:00.000Z', reason: 'goodwill',
    });
    const second = user({ userId: 'u_sam', roles: ['admin'] });
    await service.approve(second, 'act1');
    await expect(service.executeCreditGrant(user({ roles: ['admin'] }), 'act1')).resolves.toBeUndefined();
  });

  it('refuses to execute an approved action twice', async () => {
    const { console: service } = build();
    const alex = user({ roles: ['admin'] });
    await service.grantCredit(alex, {
      actionId: 'act1', accountId: 'a1', tenantId: 't1', amount: money(100_000),
      kind: 'grant_goodwill', expiresAt: '2026-12-31T00:00:00.000Z', reason: 'goodwill',
    });
    await service.approve(user({ userId: 'u_sam', roles: ['admin'] }), 'act1');
    await service.executeCreditGrant(alex, 'act1');
    await expect(service.executeCreditGrant(alex, 'act1')).rejects.toThrow(/already been executed/i);
  });

  it('invalidates an approval if the amount is changed afterwards', () => {
    // Approve £100, execute £10,000 is the attack this defends against.
    const approved = fingerprintOf({
      capability: 'credit.grant', accountId: 'a1',
      amount: money(10_000), arguments: { kind: 'grant_goodwill' },
    });
    const executed = fingerprintOf({
      capability: 'credit.grant', accountId: 'a1',
      amount: money(1_000_000), arguments: { kind: 'grant_goodwill' },
    });
    expect(executed).not.toBe(approved);
  });

  it('fingerprints identically regardless of property order', () => {
    const a = fingerprintOf({ capability: 'c', accountId: 'a1', arguments: { x: 1, y: 2 } });
    const b = fingerprintOf({ capability: 'c', accountId: 'a1', arguments: { y: 2, x: 1 } });
    expect(a).toBe(b);
  });

  it('always requires two people for a plan override, whatever the value', () => {
    // An override changes what a customer pays every month until someone
    // changes it back, so a threshold cannot express the risk.
    expect(needsSecondPerson('plan.override')).toBe(true);
    expect(needsSecondPerson('tenant.kill_switch')).toBe(true);
    expect(needsSecondPerson('dunning.suspend')).toBe(true);
  });

  it('requires approval when a capped capability is given no amount to check', () => {
    expect(needsSecondPerson('credit.grant', undefined)).toBe(true);
    expect(needsSecondPerson('credit.grant', money(1_000))).toBe(false);
  });

  it('expires an approval rather than leaving it standing', async () => {
    const clock = at();
    const { console: service } = build(clock);
    await service.grantCredit(user({ roles: ['admin'] }), {
      actionId: 'act1', accountId: 'a1', tenantId: 't1', amount: money(100_000),
      kind: 'grant_goodwill', expiresAt: '2026-12-31T00:00:00.000Z', reason: 'goodwill',
    });
    await service.approve(user({ userId: 'u_sam', roles: ['admin'] }), 'act1');
    clock.advance(25 * 3_600_000);
    await expect(service.executeCreditGrant(user({ roles: ['admin'] }), 'act1'))
      .rejects.toThrow(/expired/i);
  });

  it('refuses an action with no reason', async () => {
    const { console: service } = build();
    await expect(service.grantCredit(user(), {
      actionId: 'act1', accountId: 'a1', tenantId: 't1', amount: money(1_000),
      kind: 'grant_goodwill', expiresAt: '2026-12-31T00:00:00.000Z', reason: '   ',
    })).rejects.toThrow();
  });
});

describe('the console audit trail', () => {
  it('records who asked, who approved and who executed', async () => {
    const { console: service, audit } = build();
    const alex = user({ roles: ['admin'] });
    await service.grantCredit(alex, {
      actionId: 'act1', accountId: 'a1', tenantId: 't1', amount: money(100_000),
      kind: 'grant_goodwill', expiresAt: '2026-12-31T00:00:00.000Z', reason: 'service credit',
    });
    await service.approve(user({ userId: 'u_sam', roles: ['admin'] }), 'act1');
    await service.executeCreditGrant(alex, 'act1');

    const entries = await audit.replay('t1', 'act1');
    const types = entries.map((entry) => entry.type);
    expect(types).toContain('operator_action_requested');
    expect(types).toContain('operator_action_approved');
    expect(types).toContain('operator_action_executed');
    const granted = entries.find((entry) => entry.type === 'credit_granted');
    expect(granted?.payload?.['requestedBy']).toBe('u_alex');
    expect(granted?.payload?.['approvedBy']).toBe('u_sam');
  });

  it('never writes a payment method reference that could charge a card', async () => {
    const { payments, provider, audit } = build();
    const method = provider.attachTestMethod('a1');
    await payments.take({
      paymentId: 'p1', accountId: 'a1', tenantId: 't1', amount: money(10_000),
      paymentMethodRef: method.ref, description: 'Invoice', idempotencyKey: 'k1', actor: 'u',
    });
    const entries = (await audit.export('t1')).entries;
    expect(JSON.stringify(entries)).not.toMatch(/4242424242424242/);
  });
});

describe('the console site', () => {
  const site = () => {
    const { console: service } = build();
    return { site: new ConsoleSite(service), service };
  };

  it('escapes anything interpolated into a page', () => {
    // An account name, an operator's reason and a tenant's own configuration
    // all arrive from outside. None of them is trusted.
    expect(escape('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html`<p>${'<img onerror=x>'}</p>`).toBe('<p>&lt;img onerror=x&gt;</p>');
  });

  it('renders an account id safely even when it carries markup', async () => {
    const { site: rendered } = site();
    const result = await rendered.render({
      path: '/console/accounts/<script>bad</script>',
      query: { tenant: 't1' },
      user: user({ roles: ['admin'] }),
    });
    expect(result.status).toBe(200);
    expect(result.html).not.toContain('<script>bad');
    expect(result.html).toContain('&lt;script&gt;bad');
  });

  it('shows an operator only the actions their role permits', async () => {
    const { site: rendered } = site();
    const supportView = await rendered.render({
      path: '/console/accounts/a1', query: { tenant: 't1' },
      user: user({ roles: ['support'] }),
    });
    // The control is shown disabled rather than hidden: an operator who cannot
    // see it assumes the system is broken and asks a colleague to do it, which
    // is the behaviour dual control exists to stop.
    expect(supportView.html).toContain('cursor:not-allowed');
    expect(supportView.html).toContain('Grant credit');
  });

  it('will not let an operator approve their own request from the queue', async () => {
    const { site: rendered, service } = site();
    const alex = user({ roles: ['admin'] });
    await service.grantCredit(alex, {
      actionId: 'act1', accountId: 'a1', tenantId: 't1', amount: money(100_000),
      kind: 'grant_goodwill', expiresAt: '2026-12-31T00:00:00.000Z', reason: 'goodwill',
    });
    const result = await rendered.render({
      path: '/console/approvals', query: {}, user: alex,
    });
    expect(result.html).toContain('You requested this');
    expect(result.html).not.toContain('>Approve<');
  });

  it('offers approval to a different operator with the same authority', async () => {
    const { site: rendered, service } = site();
    await service.grantCredit(user({ roles: ['admin'] }), {
      actionId: 'act1', accountId: 'a1', tenantId: 't1', amount: money(100_000),
      kind: 'grant_goodwill', expiresAt: '2026-12-31T00:00:00.000Z', reason: 'goodwill',
    });
    // The CSRF token is supplied because a real request always carries one:
    // the router derives it from the session before it calls the renderer.
    // Without it the buttons are deliberately not drawn, since a form that
    // will be rejected on submission is worse than no form at all.
    const result = await rendered.render({
      path: '/console/approvals', query: {},
      user: user({ userId: 'u_sam', roles: ['admin'] }),
      csrf: 'csrf-token-for-this-session',
    });
    expect(result.html).toContain('>Approve<');
    expect(result.html).toContain('action="/console/approvals/act1/approve"');
  });

  it('shows a permission failure as a page, not a stack trace', async () => {
    const { site: rendered } = site();
    const result = await rendered.render({
      path: '/console/accounts/a1', query: { tenant: 't1' },
      user: user({ active: false }),
    });
    expect(result.status).toBe(403);
    expect(result.html).toContain('Not permitted');
  });
});

/**
 * Which payment provider the platform actually uses.
 *
 * The sandbox was wired unconditionally, so setting STRIPE_SECRET_KEY changed
 * nothing and the product could not take a payment. That is not a gap in a
 * feature, it is the thing standing between the build and revenue, and nothing
 * in the suite noticed because every test asserted the sandbox's behaviour.
 */
describe('choosing a payment provider', () => {
  const base = {
    audit: new AuditLog(new InMemoryAuditStore()),
    clock: new FixedClock(new Date('2026-09-05T09:00:00.000Z')),
    sessionSecret: 'a-secret-long-enough-for-the-check',
  };

  it('takes real cards only when both Stripe secrets are set', async () => {
    const both = await buildDevSites({
      ...base,
      stripeSecretKey: 'a-key-shaped-value-for-a-test',
      stripeWebhookSecret: 'a-webhook-secret-for-a-test',
    });
    expect(both.paymentProviderName).toBe('stripe');
  });

  it('stays in the sandbox when only one of them is set', async () => {
    // A key that can take money but cannot verify what the provider says
    // happened to it is worse than not taking money at all.
    const half = await buildDevSites({
      ...base,
      stripeSecretKey: 'a-key-shaped-value-for-a-test',
    });
    expect(half.paymentProviderName).toBe('sandbox');
  });

  it('stays in the sandbox when neither is set', async () => {
    const none = await buildDevSites({ ...base });
    expect(none.paymentProviderName).toBe('sandbox');
  });
});
