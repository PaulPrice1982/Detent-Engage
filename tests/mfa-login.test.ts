import { describe, expect, it } from 'vitest';
import { FixedClock } from '@detent/awa-core';
import {
  UserService, InMemoryUserStore, SessionService, InMemorySessionStore,
  MAX_FAILED_ATTEMPTS, LOCKOUT_MINUTES, stepAt, totpAt,
  type Realm,
} from '@detent/awa-auth';
import { SiteRouter } from '@detent/awa-server';

async function fixture(realm: Realm = 'console') {
  const clock = new FixedClock(new Date('2026-09-04T09:00:00Z'));
  const users = new UserService(new InMemoryUserStore(), clock);
  const sessions = new SessionService(new InMemorySessionStore(), 's'.repeat(48), clock);
  const email = 'reviewer@example.test';
  const password = 'correct horse battery staple';
  const user = await users.create({
    realm, email, password, name: 'Reviewer', roles: ['admin'],
    ...(realm === 'app' ? { tenantId: 't_review' } : {}),
  });
  const router = new SiteRouter({
    realm, prefix: `/${realm}`, users, sessions, secret: 's'.repeat(48), secureCookies: false,
    handler: async () => ({ status: 200, html: 'Protected content' }),
  });
  const login = (form: Record<string, string> = {}) => router.handle({
    method: 'POST', path: `/${realm}/signin`, query: {}, headers: {},
    rawBody: new URLSearchParams({ email, password, ...form }).toString(),
  });
  const get = (path: string, cookie = '') => router.handle({
    method: 'GET', path: `/${realm}${path}`, query: {}, headers: { cookie },
  });
  const enrol = async () => {
    const { secret } = await users.beginMfaEnrolment(user.userId);
    const recovery = await users.confirmMfaEnrolment(user.userId, totpAt(secret, stepAt(clock.nowMs())));
    clock.advance(30_000);
    return { ...recovery, code: () => totpAt(secret, stepAt(clock.nowMs())) };
  };
  return { clock, users, sessions, user, login, get, enrol, realm };
}

describe('MFA at browser sign-in', () => {
  for (const realm of ['console', 'app', 'reseller'] as const) {
    it(`requires both factors in the ${realm} realm and rejects replay`, async () => {
      const h = await fixture(realm);
      const mfa = await h.enrol();
      for (const form of [{}, { mfaCode: 'invalid', mfaVerified: 'true' }]) {
        const denied = await h.login(form);
        expect(denied?.status).toBe(401);
        expect(denied?.cookies).toBeUndefined();
      }
      expect((await h.get(''))?.status).toBe(303);
      const code = mfa.code();
      const accepted = await h.login({ mfaCode: code });
      expect(accepted?.status).toBe(303);
      const cookie = accepted?.cookies?.[0]?.split(';')[0] ?? '';
      expect(cookie).not.toBe('');
      expect((await h.get('', cookie))?.html).toBe('Protected content');
      const session = await h.sessions.resolve(realm, cookie.slice(cookie.indexOf('=') + 1));
      expect(session?.mfaVerified).toBe(true);
      expect((await h.login({ mfaCode: code }))?.status).toBe(401);
      expect((await h.get('/signin'))?.html).toContain('autocomplete="one-time-code"');
    });
  }

  it('requires a password for recovery and spends each recovery code once', async () => {
    const h = await fixture();
    const { recoveryCodes } = await h.enrol();
    const mfaCode = recoveryCodes[0]!;
    expect((await h.login({ password: 'wrong', mfaCode }))?.status).toBe(401);
    expect(await h.users.recoveryCodesRemaining(h.user.userId)).toBe(10);
    expect((await h.login({ mfaCode }))?.status).toBe(303);
    expect(await h.users.recoveryCodesRemaining(h.user.userId)).toBe(9);
    expect((await h.login({ mfaCode }))?.status).toBe(401);
  });

  it('does not reset failed MFA attempts when the password is correct', async () => {
    const h = await fixture();
    const mfa = await h.enrol();
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
      expect((await h.login({ mfaCode: 'invalid' }))?.status).toBe(401);
    }
    expect((await h.login({ mfaCode: mfa.code() }))?.html).toContain('locked');
    h.clock.advance(LOCKOUT_MINUTES * 60_000 + 1);
    expect((await h.login({ mfaCode: mfa.code() }))?.status).toBe(303);
    expect((await h.users.byId(h.user.userId))?.failedAttempts).toBe(0);
  });

  it('revokes password-only sessions after enrollment and shows login without a redirect loop', async () => {
    const h = await fixture();
    const signedIn = await h.login();
    expect(signedIn?.status).toBe(303);
    const cookie = signedIn?.cookies?.[0]?.split(';')[0] ?? '';
    expect((await h.get('', cookie))?.status).toBe(200);
    await h.enrol();
    expect((await h.get('', cookie))?.redirect).toBe('/console/signin');
    const legacy = await h.sessions.start({ userId: h.user.userId, realm: 'console' });
    const legacyCookie = h.sessions.cookie('console', legacy.token, { secure: false }).split(';')[0]!;
    expect((await h.get('/signin', legacyCookie))?.status).toBe(200);
    expect(await h.sessions.resolve('console', legacy.token)).toBeUndefined();
  });
});
