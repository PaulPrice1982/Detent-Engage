/**
 * The console refuses a write the signed-in user may not make.
 *
 * `can()` was already being asked which buttons to draw, and that is
 * presentation, not a control: a hidden button is a button somebody can still
 * POST to with curl. Nothing on the way to actually granting a credit,
 * publishing a price or attaching a customer to a reseller consulted it, so
 * every console user could do everything regardless of role, and the MFA gate
 * on the nine money capabilities was never reached at all.
 */
import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { FixedClock } from '@detent/awa-core';
import { buildDevSites } from '@detent/awa-server';
import type { SiteRequest } from '@detent/awa-server';

const PASSWORD = 'correct horse battery staple';
const OPERATOR = 'ops@example.test';

async function consoleWith(roles: readonly string[], enrolMfa: boolean) {
  const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
  const sites = await buildDevSites({
    audit: new AuditLog(new InMemoryAuditStore(), clock),
    clock,
    sessionSecret: 'x'.repeat(48),
    operatorEmail: OPERATOR,
    operatorPassword: PASSWORD,
    secureCookies: false,
  });

  const user = await sites.users.byEmail('console', OPERATOR);
  if (!user) throw new Error('the operator was not seeded');
  // The seed gives 'admin'. Rewriting the roles here is how a console user
  // with a lesser role is represented, since there is no screen that assigns
  // one (see the handover note on user management).
  await sites.users.setRoles(user.userId, roles);

  if (enrolMfa) {
    const { secret } = await sites.users.beginMfaEnrolment(user.userId);
    const { totpAt, stepAt } = await import('@detent/awa-auth');
    await sites.users.confirmMfaEnrolment(user.userId, totpAt(secret, stepAt(clock.nowMs())));
  }

  const signIn = await sites.consoleRouter.handle({
    method: 'POST', path: '/console/signin', query: {}, headers: {},
    rawBody: new URLSearchParams({ email: OPERATOR, password: PASSWORD }).toString(),
  });
  const cookie = (signIn?.cookies ?? []).map((one) => one.split(';')[0]).join('; ');
  expect(cookie, 'sign-in did not produce a session').toMatch(/detent_console=/);

  const post = async (path: string, form: Record<string, string> = {}, formPage = '/console/bundles') => {
    // The CSRF token belongs to the session and is rendered into each form, so
    // it is read from the page that carries the form, exactly as a browser
    // would. The console index has no form and therefore no token.
    const page = await sites.consoleRouter.handle({
      method: 'GET', path: formPage, query: {}, headers: { cookie },
    } as SiteRequest);
    const csrf = /name="csrf" value="([^"]*)"/.exec(page?.html ?? '')?.[1] ?? '';
    expect(csrf, `no csrf token on ${formPage}`).not.toBe('');
    return sites.consoleRouter.handle({
      method: 'POST', path, query: {}, headers: { cookie },
      rawBody: new URLSearchParams({ ...form, csrf }).toString(),
    } as SiteRequest);
  };

  return { sites, post };
}

describe('a console user with no money capability', () => {
  it('is refused a credit grant, and told what is missing', async () => {
    const { post } = await consoleWith(['support'], false);
    const response = await post('/console/bundles/grant', {
      bundle: 'bundle_100', accountId: 'acc_1',
    });
    expect(response?.status).toBe(403);
    expect(response?.html).toContain('credit.grant');
  });

  it('is refused publishing a price', async () => {
    const { post } = await consoleWith(['support'], false);
    const response = await post(
      '/console/pricing/publish', { plan: 'starter', version: '1' }, '/console/pricing',
    );
    expect(response?.status).toBe(403);
    expect(response?.html).toContain('plan.override');
  });
});

describe('a billing user who has not enrolled in MFA', () => {
  it('is refused a credit grant, and told that is the reason', async () => {
    // The gate that could never be satisfied and was then bypassed by a
    // hard-coded true. It is now reached, and reachable.
    const { post } = await consoleWith(['billing'], false);
    const response = await post('/console/bundles/grant', {
      bundle: 'bundle_100', accountId: 'acc_1',
    });
    expect(response?.status).toBe(403);
    expect(response?.html).toMatch(/multi-factor/i);
  });

  it('is allowed once enrolled', async () => {
    const { post } = await consoleWith(['billing'], true);
    const response = await post('/console/bundles/grant', {
      bundle: 'bundle_100', accountId: 'acc_1',
    });
    // Not a 403. It may still fail on the account not existing, which is a
    // different answer and the point: authorisation no longer refuses it.
    expect(response?.status).not.toBe(403);
  });
});

describe('an admin', () => {
  it('may publish a price once enrolled', async () => {
    const { post } = await consoleWith(['admin'], true);
    const response = await post(
      '/console/pricing/publish', { plan: 'starter', version: '1' }, '/console/pricing',
    );
    expect(response?.status).not.toBe(403);
  });
});
