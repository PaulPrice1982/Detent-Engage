/**
 * Multi-factor authentication, which the RBAC layer has always required and
 * which nothing could ever satisfy.
 *
 * `mfaEnrolled` was written false at user creation and set true by nothing.
 * RBAC refuses all nine money capabilities without it. So granting a credit,
 * taking a payment, refunding, voiding an invoice, writing one off, overriding
 * a plan and changing a spend cap were not protected, they were impossible,
 * for every user including the owner. The one place it read true was a
 * hard-coded literal in the console adapter, whose comment said the value came
 * from the identity provider in production while being the production path, so
 * in practice every gate was bypassed instead.
 */
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@detent/awa-core';
import {
  InMemoryUserStore, TOTP_STEP_SECONDS, UserService,
  base32Decode, generateRecoveryCodes, otpauthUri, stepAt, totpAt, useRecoveryCode, verifyTotp,
} from '@detent/awa-auth';
import { can } from '@detent/awa-console';

const PASSWORD = 'correct horse battery staple';

async function operator() {
  const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
  const users = new UserService(new InMemoryUserStore(), clock);
  const user = await users.create({
    realm: 'console', email: 'ops@example.test', name: 'Ops', password: PASSWORD, roles: ['billing'],
  });
  return { clock, users, user };
}

describe('generating a code', () => {
  it('matches the RFC 6238 test vector', () => {
    // The published vector for the all-ASCII "12345678901234567890" seed at
    // T=59, which is step 1. A TOTP implementation that agrees only with
    // itself agrees with no authenticator app.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(base32Decode(secret).toString('utf8')).toBe('12345678901234567890');
    expect(totpAt(secret, 1)).toBe('287082');
    expect(totpAt(secret, 37037036)).toBe('081804');
  });

  it('changes every thirty seconds and not within one', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(stepAt(0)).toBe(0);
    expect(stepAt((TOTP_STEP_SECONDS - 1) * 1000)).toBe(0);
    expect(stepAt(TOTP_STEP_SECONDS * 1000)).toBe(1);
    expect(totpAt(secret, 5)).not.toBe(totpAt(secret, 6));
  });

  it('builds a URI an authenticator app can read', () => {
    const uri = otpauthUri({ secret: 'ABCDEFGH', account: 'ops@example.test' });
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=ABCDEFGH');
    expect(uri).toContain('issuer=Detent');
    // The issuer in the label too, or an operator with several accounts sees
    // six entries named by their email address and cannot tell them apart.
    expect(uri).toContain(encodeURIComponent('Detent:ops@example.test'));
  });
});

describe('verifying a code', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const atMs = 1_700_000_000_000;
  const now = stepAt(atMs);

  it('accepts the current code', () => {
    expect(verifyTotp({ secret, code: totpAt(secret, now), atMs, lastUsedStep: undefined }).ok)
      .toBe(true);
  });

  it('accepts one step either side, for a phone whose clock drifts', () => {
    expect(verifyTotp({ secret, code: totpAt(secret, now - 1), atMs, lastUsedStep: undefined }).ok)
      .toBe(true);
    expect(verifyTotp({ secret, code: totpAt(secret, now + 1), atMs, lastUsedStep: undefined }).ok)
      .toBe(true);
  });

  it('refuses two steps away', () => {
    expect(verifyTotp({ secret, code: totpAt(secret, now - 2), atMs, lastUsedStep: undefined }).ok)
      .toBe(false);
  });

  it('refuses a code already used, though the arithmetic is right', () => {
    // Replay is the obvious attack on a code that stays valid for ninety
    // seconds: read it over a shoulder or off a screen share and use it.
    const first = verifyTotp({ secret, code: totpAt(secret, now), atMs, lastUsedStep: undefined });
    expect(first.ok).toBe(true);
    expect(verifyTotp({ secret, code: totpAt(secret, now), atMs, lastUsedStep: first.step }).ok)
      .toBe(false);
  });

  it('refuses anything that is not six digits', () => {
    for (const code of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect(verifyTotp({ secret, code, atMs, lastUsedStep: undefined }).ok, code).toBe(false);
    }
  });
});

describe('recovery codes', () => {
  it('are stored hashed and spent when used', async () => {
    const recovery = await generateRecoveryCodes(3);
    expect(recovery.plain).toHaveLength(3);
    // A readable list of them in the database is a list of ways to skip MFA
    // for every member of staff.
    for (const code of recovery.plain) {
      expect(recovery.hashes.join(' ')).not.toContain(code);
    }

    const used = await useRecoveryCode(recovery.plain[1]!, recovery.hashes);
    expect(used.ok).toBe(true);
    expect(used.remaining).toHaveLength(2);

    // Single use: the same code again is refused.
    expect((await useRecoveryCode(recovery.plain[1]!, used.remaining)).ok).toBe(false);
  });
});

describe('enrolling an operator', () => {
  it('cannot move money until enrolment is complete', async () => {
    const { users, user, clock } = await operator();

    const asConsoleUser = (mfaEnrolled: boolean) => ({
      userId: user.userId, email: user.email, name: user.name,
      roles: ['billing'] as const, active: true, mfaEnrolled, createdAt: user.createdAt,
    });

    // The state every user was permanently in.
    expect(can(asConsoleUser(false), 'payment.refund')).toBe(false);
    // A capability that is not about money is unaffected, so this is a gate
    // rather than a disabled account.
    expect(can(asConsoleUser(false), 'invoice.read')).toBe(true);

    const { secret, uri } = await users.beginMfaEnrolment(user.userId);
    expect(uri).toContain(secret);
    // A secret alone grants nothing: it is stored, and the flag is still false
    // until a code proves the person holds it.
    expect((await users.byId(user.userId))?.mfaEnrolled).toBe(false);

    const { recoveryCodes } = await users.confirmMfaEnrolment(
      user.userId, totpAt(secret, stepAt(clock.nowMs())),
    );
    expect(recoveryCodes).toHaveLength(10);
    expect((await users.byId(user.userId))?.mfaEnrolled).toBe(true);
    expect(can(asConsoleUser(true), 'payment.refund')).toBe(true);
  });

  it('refuses to confirm with the wrong code', async () => {
    const { users, user } = await operator();
    await users.beginMfaEnrolment(user.userId);
    await expect(users.confirmMfaEnrolment(user.userId, '000000')).rejects.toThrow(/not right/i);
    expect((await users.byId(user.userId))?.mfaEnrolled).toBe(false);
  });

  it('refuses to confirm before enrolment was started', async () => {
    const { users, user } = await operator();
    await expect(users.confirmMfaEnrolment(user.userId, '123456')).rejects.toThrow(/Start setting up/i);
  });

  it('verifies a code once, and refuses the same one again', async () => {
    const { users, user, clock } = await operator();
    const { secret } = await users.beginMfaEnrolment(user.userId);
    await users.confirmMfaEnrolment(user.userId, totpAt(secret, stepAt(clock.nowMs())));

    // The confirming code is spent by the confirmation itself.
    expect(await users.verifyMfa(user.userId, totpAt(secret, stepAt(clock.nowMs())))).toBe(false);
    // The next step's code is accepted.
    expect(await users.verifyMfa(user.userId, totpAt(secret, stepAt(clock.nowMs()) + 1))).toBe(true);
  });

  it('accepts a recovery code in place of the authenticator, once', async () => {
    const { users, user, clock } = await operator();
    const { secret } = await users.beginMfaEnrolment(user.userId);
    const { recoveryCodes } = await users.confirmMfaEnrolment(
      user.userId, totpAt(secret, stepAt(clock.nowMs())),
    );

    expect(await users.recoveryCodesRemaining(user.userId)).toBe(10);
    expect(await users.verifyMfa(user.userId, recoveryCodes[0]!)).toBe(true);
    expect(await users.recoveryCodesRemaining(user.userId)).toBe(9);
    // Spent, so a code read off a printed list cannot be used twice.
    expect(await users.verifyMfa(user.userId, recoveryCodes[0]!)).toBe(false);
  });

  it('will not turn itself off without a code', async () => {
    // Otherwise anybody reaching an unlocked laptop removes the second factor
    // and the password is all that ever protected the money.
    const { users, user, clock } = await operator();
    const { secret } = await users.beginMfaEnrolment(user.userId);
    await users.confirmMfaEnrolment(user.userId, totpAt(secret, stepAt(clock.nowMs())));

    await expect(users.disableMfa(user.userId, '000000')).rejects.toThrow(/Confirm a code/i);
    expect((await users.byId(user.userId))?.mfaEnrolled).toBe(true);

    await users.disableMfa(user.userId, totpAt(secret, stepAt(clock.nowMs()) + 1));
    const after = await users.byId(user.userId);
    expect(after?.mfaEnrolled).toBe(false);
    // The secret goes with it, so turning it back on issues a new one.
    expect(after?.totpSecret).toBeUndefined();
  });

  it('refuses to start again while already enrolled', async () => {
    const { users, user, clock } = await operator();
    const { secret } = await users.beginMfaEnrolment(user.userId);
    await users.confirmMfaEnrolment(user.userId, totpAt(secret, stepAt(clock.nowMs())));
    await expect(users.beginMfaEnrolment(user.userId)).rejects.toThrow(/already set up/i);
  });
});
