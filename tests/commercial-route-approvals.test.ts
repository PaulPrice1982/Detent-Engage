import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { csrfTokenFor, stepAt, totpAt } from '@detent/awa-auth';
import { FixedClock } from '@detent/awa-core';
import { buildDevSites } from '@detent/awa-server';
import type { ConsoleUser } from '@detent/awa-console';

async function fixture() {
  const clock = new FixedClock(new Date('2026-09-04T09:00:00Z'));
  const secret = 's'.repeat(48);
  const audit = new AuditLog(new InMemoryAuditStore(), clock);
  const sites = await buildDevSites({ clock, audit, sessionSecret: secret, secureCookies: false });
  const operator = async (name: string, role: 'admin' | 'support') => {
    const email = `${name}@example.test`;
    const password = 'correct horse battery staple';
    const user = await sites.users.create({ realm: 'console', email, name, password, roles: [role] });
    const pending = await sites.users.beginMfaEnrolment(user.userId);
    const { recoveryCodes } = await sites.users.confirmMfaEnrolment(user.userId, totpAt(pending.secret, stepAt(clock.nowMs())));
    const login = await sites.consoleRouter.handle({
      method: 'POST', path: '/console/signin', query: {}, headers: {},
      rawBody: new URLSearchParams({ email, password, mfaCode: recoveryCodes[0]! }).toString(),
    });
    const cookie = login?.cookies?.[0]?.split(';')[0] ?? '';
    expect(cookie).not.toBe('');
    const csrf = csrfTokenFor(cookie.slice(cookie.indexOf('=') + 1).split('.')[0]!, secret);
    const post = (path: string, form: Record<string, string> = {}) => sites.consoleRouter.handle({
      method: 'POST', path: `/console/${path}`, query: {}, headers: { cookie },
      rawBody: new URLSearchParams({ csrf, ...form }).toString(),
    });
    const get = (path: string) => sites.consoleRouter.handle({
      method: 'GET', path: `/console/${path}`, query: {}, headers: { cookie },
    });
    return { post, get, user: { ...user, roles: [role], mfaEnrolled: true } as ConsoleUser };
  };
  const requester = await operator('requester', 'admin');
  const approver = await operator('approver', 'admin');
  const account = await sites.accounts.create({ name: 'Customer', tenantId: 't_customer', billingEmail: 'billing@example.test', countryCode: 'GB' });
  const balance = async () => (await sites.consoleService.summary(requester.user, account.accountId, account.tenantId)).credits.total.amount;
  const pending = () => sites.consoleService.pendingApprovals(requester.user);
  const requestPrice = async (monthly = '999') => {
    expect((await requester.post('pricing/draft', {
      planCode: 'starter', platformFeeMonthly: monthly, changeNote: 'Reviewed commercial terms', selfServiceAvailable: 'true',
    }))?.status).toBe(200);
    expect((await requester.post('pricing/publish', { planCode: 'starter', version: '2' }))?.html).toContain('second authorized operator');
    return (await pending())[0]!;
  };
  return { sites, clock, audit, operator, requester, approver, account, balance, pending, requestPrice };
}

describe('commercial console routes require approval', () => {
  it('holds large bundles, refuses self/underprivileged approvals, and grants only the stored amount once', async () => {
    const h = await fixture();
    const response = await h.requester.post('bundles/grant', {
      bundle: 'bundle_10000', accountId: h.account.accountId, reason: 'Purchased replies',
    });
    expect(response?.html).toContain('second authorized operator');
    expect(await h.balance()).toBe(0);
    const action = (await h.pending())[0]!;
    expect(action.amount?.amount).toBe(500_000);
    expect((await h.requester.post(`approvals/${action.actionId}/approve`))?.status).toBe(403);
    const support = await h.operator('support', 'support');
    expect((await support.post(`approvals/${action.actionId}/approve`))?.status).toBe(403);
    expect(await h.balance()).toBe(0);
    expect((await h.approver.post(`approvals/${action.actionId}/approve`, {
      amount: '999999999', accountId: 'attacker', bundle: 'bundle_100',
    }))?.status).toBe(303);
    expect(await h.balance()).toBe(500_000);
    expect((await h.approver.post(`approvals/${action.actionId}/approve`))?.status).toBe(403);
    expect(await h.balance()).toBe(500_000);
    const entries = (await h.audit.export(h.account.tenantId)).entries;
    expect(entries.some(entry => entry.type === 'credit_granted' && entry.correlationId === action.actionId)).toBe(true);
  });

  it('executes a below-threshold bundle through the same workflow without a second person', async () => {
    const h = await fixture();
    expect((await h.requester.post('bundles/grant', {
      bundle: 'bundle_100', accountId: h.account.accountId, reason: 'Small purchase',
    }))?.html).toContain('Granted');
    expect(await h.balance()).toBe(5_000);
    expect(await h.pending()).toHaveLength(0);
  });

  it('leaves prices unchanged until another operator approves the exact version', async () => {
    const h = await fixture();
    const before = (await h.sites.marketing('/')).html;
    const action = await h.requestPrice();
    expect(action.arguments['operation']).toBe('catalogue.publish');
    expect((await h.sites.marketing('/')).html).toBe(before);
    expect((await h.approver.get('approvals'))?.html).toContain('Review exact pricing terms');
    await expect(h.sites.consoleService.executeCataloguePublication(h.requester.user, action.actionId)).rejects.toThrow();
    expect((await h.requester.post(`approvals/${action.actionId}/approve`))?.status).toBe(403);
    expect((await h.approver.post(`approvals/${action.actionId}/approve`, { planCode: 'growth', version: '999' }))?.status).toBe(303);
    expect((await h.sites.marketing('/')).html).not.toBe(before);
    expect((await h.approver.post(`approvals/${action.actionId}/approve`))?.status).toBe(403);
  });

  it('does not publish discarded drafts or execute expired credit requests', async () => {
    const h = await fixture();
    const before = (await h.sites.marketing('/')).html;
    const price = await h.requestPrice();
    expect((await h.requester.post('pricing/discard', { planCode: 'starter', version: '2' }))?.status).toBe(200);
    expect((await h.approver.post(`approvals/${price.actionId}/approve`))?.status).toBe(403);
    expect((await h.sites.marketing('/')).html).toBe(before);
    await h.requester.post('bundles/grant', { bundle: 'bundle_10000', accountId: h.account.accountId, reason: 'Purchase' });
    const credit = (await h.pending())[0]!;
    h.clock.advance(25 * 60 * 60 * 1000);
    await expect(h.sites.consoleService.approve(h.approver.user, credit.actionId)).rejects.toThrow(/expired/);
    expect(await h.balance()).toBe(0);
  });
});
