/**
 * A second person can actually approve.
 *
 * Dual control is the control the console's whole design rests on: above a
 * threshold no single person moves money, whatever their role. Every piece of
 * it was built and tested, the threshold, the fingerprint, the refusal to
 * approve your own request, and none of it could be reached, because the
 * Approve and Reject buttons posted to `/v1/console/approvals/{id}/...`.
 *
 * `/v1/*` is reserved by the transport for the API, the API authenticates a
 * bearer key, and a browser on the console carries a session cookie and no
 * key. So every Approve in the back office answered POLICY_DENIED, and no
 * action held for a second person could ever be released by one. The tests on
 * the approval service all passed throughout: they called the service.
 *
 * These tests go through the console the way an operator does, over its own
 * session and its own CSRF token, because that is the path that was broken.
 */
import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { FixedClock } from '@detent/awa-core';
import { money } from '@detent/awa-billing';
import { buildDevSites } from '@detent/awa-server';
import type { SiteRequest } from '@detent/awa-server';

const PASSWORD = 'correct horse battery staple';
const APPROVER = 'approver@example.test';
const REQUESTER = 'requester@example.test';
const REQUESTER_PASSWORD = 'thicket marina ozone seventy';

async function harness() {
  const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
  const sites = await buildDevSites({
    audit: new AuditLog(new InMemoryAuditStore(), clock),
    clock,
    sessionSecret: 'x'.repeat(48),
    operatorEmail: APPROVER,
    operatorPassword: PASSWORD,
    secureCookies: false,
  });

  const enrol = async (userId: string): Promise<void> => {
    const { secret } = await sites.users.beginMfaEnrolment(userId);
    const { totpAt, stepAt } = await import('@detent/awa-auth');
    await sites.users.confirmMfaEnrolment(userId, totpAt(secret, stepAt(clock.nowMs())));
  };

  const approver = await sites.users.byEmail('console', APPROVER);
  if (!approver) throw new Error('the operator was not seeded');
  await enrol(approver.userId);

  // A second person, because an approver may not approve their own request.
  const requester = await sites.users.create({
    realm: 'console', email: REQUESTER, name: 'A Requester',
    password: REQUESTER_PASSWORD, roles: ['billing'],
  });
  await enrol(requester.userId);

  const asConsoleUser = (user: NonNullable<typeof approver>) => ({
    userId: user.userId, email: user.email, name: user.name,
    roles: user.roles as ('admin' | 'billing')[], active: user.active,
    mfaEnrolled: true, createdAt: user.createdAt,
  });

  const account = await sites.accounts.create({
    tenantId: 't_test', name: 'Test Ltd', billingEmail: 'ap@test.example', countryCode: 'GB',
  });

  // Over the £500 threshold, so it is held rather than applied.
  const held = await sites.consoleService.grantCredit(
    asConsoleUser(await sites.users.byId(requester.userId) ?? requester),
    {
      actionId: 'act_held', accountId: account.accountId, tenantId: 't_test',
      amount: money(250_000), kind: 'grant_promotional',
      expiresAt: '2027-01-01T00:00:00.000Z', reason: 'Agreed at the business review.',
    },
  );
  expect(held.state, 'the fixture must be held, or it proves nothing').not.toBe('approved');

  const signIn = await sites.consoleRouter.handle({
    method: 'POST', path: '/console/signin', query: {}, headers: {},
    rawBody: new URLSearchParams({ email: APPROVER, password: PASSWORD }).toString(),
  });
  const cookie = (signIn?.cookies ?? []).map((one) => one.split(';')[0]).join('; ');

  const get = (path: string) => sites.consoleRouter.handle({
    method: 'GET', path, query: {}, headers: { cookie },
  } as SiteRequest);

  const post = async (path: string, form: Record<string, string> = {}) => {
    const page = await get('/console/approvals');
    const csrf = /name="csrf" value="([^"]*)"/.exec(page?.html ?? '')?.[1] ?? '';
    expect(csrf, 'the approvals page rendered no CSRF token').not.toBe('');
    return sites.consoleRouter.handle({
      method: 'POST', path, query: {}, headers: { cookie },
      rawBody: new URLSearchParams({ ...form, csrf }).toString(),
    } as SiteRequest);
  };

  return { sites, get, post, account };
}

describe('the approvals page', () => {
  it('posts its buttons to the console, not to the API', async () => {
    const { get } = await harness();
    const html = (await get('/console/approvals'))?.html ?? '';
    expect(html).toContain('action="/console/approvals/act_held/approve"');
    // `/v1/*` never reaches a site. A button pointing there is a button that
    // answers POLICY_DENIED to the person who presses it.
    expect(html).not.toContain('/v1/console/approvals');
  });

  it('carries the session’s CSRF token on each button', async () => {
    const { get } = await harness();
    const html = (await get('/console/approvals'))?.html ?? '';
    expect(html).toMatch(/action="\/console\/approvals\/act_held\/approve"[\s\S]{0,200}name="csrf"/);
  });
});

describe('a second person approving', () => {
  it('releases the action and applies it', async () => {
    const { post, get, sites, account } = await harness();
    const response = await post('/console/approvals/act_held/approve');
    expect(response?.status).toBe(303);

    // Approval is a decision; the credit only exists once it is carried out.
    // Asserting on the queue alone would pass with nothing applied.
    const html = (await get(`/console/accounts/${account.accountId}`))?.html ?? '';
    expect(html).toContain('£2,500.00');
    expect((await sites.consoleService.pendingApprovals({
      userId: 'x', email: 'x@x.test', name: 'x', roles: ['admin'],
      active: true, mfaEnrolled: true, createdAt: '2026-09-04T09:00:00.000Z',
    })).length).toBe(0);
  });

  it('can reject instead, with the reason recorded', async () => {
    const { post, sites } = await harness();
    const response = await post('/console/approvals/act_held/reject', {
      reason: 'Not agreed at the review. Ask the account manager.',
    });
    expect(response?.status).toBe(303);
    expect((await sites.consoleService.pendingApprovals({
      userId: 'x', email: 'x@x.test', name: 'x', roles: ['admin'],
      active: true, mfaEnrolled: true, createdAt: '2026-09-04T09:00:00.000Z',
    })).length).toBe(0);
  });

  it('is refused without the CSRF token, like every other console write', async () => {
    const { sites } = await harness();
    const signIn = await sites.consoleRouter.handle({
      method: 'POST', path: '/console/signin', query: {}, headers: {},
      rawBody: new URLSearchParams({ email: APPROVER, password: PASSWORD }).toString(),
    });
    const cookie = (signIn?.cookies ?? []).map((one) => one.split(';')[0]).join('; ');
    const response = await sites.consoleRouter.handle({
      method: 'POST', path: '/console/approvals/act_held/approve', query: {}, headers: { cookie },
      rawBody: '',
    } as SiteRequest);
    expect(response?.status).toBe(403);
  });
});
