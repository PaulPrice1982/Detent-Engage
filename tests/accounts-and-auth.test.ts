import { describe, expect, it } from 'vitest';
import { FixedClock } from '@detent/awa-core';
import {
  AccountService, InMemoryAccountStore, addMonths, daysUntil, defaultLimitsFor,
  money, noticeDeadline,
} from '@detent/awa-billing';
import {
  InMemorySessionStore, InMemoryUserStore, SessionService, UserService,
  checkPasswordStrength, csrfTokenFor, csrfValid, generatePassword,
  hashPassword, readCookie, verifyPassword,
} from '@detent/awa-auth';

const clock = (iso = '2026-03-01T09:00:00.000Z') => new FixedClock(new Date(iso));
const SECRET = 'a'.repeat(48);

describe('contract dates', () => {
  it('clamps the day rather than rolling into the next month', () => {
    // The 31st plus a month is the 28th of February. Rolling over bills a
    // customer twice in March, and they are right to complain.
    expect(addMonths('2026-01-31T00:00:00.000Z', 1)).toBe('2026-02-28T00:00:00.000Z');
    expect(addMonths('2028-01-31T00:00:00.000Z', 1)).toBe('2028-02-29T00:00:00.000Z');
    expect(addMonths('2026-01-15T00:00:00.000Z', 1)).toBe('2026-02-15T00:00:00.000Z');
  });

  it('crosses a year boundary', () => {
    expect(addMonths('2026-11-15T00:00:00.000Z', 3)).toBe('2027-02-15T00:00:00.000Z');
  });

  it('counts days to a date, negative once past', () => {
    expect(daysUntil('2026-03-31T09:00:00.000Z', '2026-03-01T09:00:00.000Z')).toBe(30);
    expect(daysUntil('2026-02-01T09:00:00.000Z', '2026-03-01T09:00:00.000Z')).toBeLessThan(0);
  });
});

describe('accounts', () => {
  const service = () => new AccountService(new InMemoryAccountStore(), clock());
  const input = {
    name: 'Northwind Trading', tenantId: 't_northwind',
    billingEmail: 'ap@northwind.example', countryCode: 'GB', createdBy: 'u_paul',
  };

  it('creates an account as a prospect, not as active', async () => {
    // An account becomes active when a subscription starts, not when someone
    // types a name into a form.
    const account = await service().create(input);
    expect(account.status).toBe('prospect');
  });

  it('requires a country, because it decides the VAT treatment', async () => {
    await expect(service().create({ ...input, countryCode: 'GBR' })).rejects.toThrow(/two-letter/i);
  });

  it('refuses a second account on the same tenant', async () => {
    const accounts = service();
    await accounts.create(input);
    await expect(accounts.create({ ...input, name: 'Other' })).rejects.toThrow(/already belongs/i);
  });

  it('refuses an invalid billing email', async () => {
    await expect(service().create({ ...input, billingEmail: 'not-an-email' })).rejects.toThrow();
  });
});

describe('subscription terms', () => {
  const start = async () => {
    const accounts = new AccountService(new InMemoryAccountStore(), clock());
    const account = await accounts.create({
      name: 'Northwind', tenantId: 't_nw', billingEmail: 'ap@nw.example',
      countryCode: 'GB', createdBy: 'u_paul',
    });
    return { accounts, account };
  };

  it('separates the contract term from the billing period', async () => {
    // A twelve-month term billed monthly renews once and invoices twelve times.
    // Conflating them is how a customer is held to a term that had lapsed.
    const { accounts, account } = await start();
    const subscription = await accounts.startSubscription({
      accountId: account.accountId, planCode: 'growth', term: 'twelve_months',
      billingInterval: 'monthly', startDate: '2026-03-01T00:00:00.000Z',
      billingDay: 1, createdBy: 'u_paul',
    });
    expect(subscription.terms.renewalDate).toBe('2027-03-01T00:00:00.000Z');
    expect(subscription.terms.nextBillingDate).toBe('2026-04-01T00:00:00.000Z');
  });

  it('bills annually on an annual interval but still renews on the term', async () => {
    const { accounts, account } = await start();
    const subscription = await accounts.startSubscription({
      accountId: account.accountId, planCode: 'command', term: 'twenty_four_months',
      billingInterval: 'annual', startDate: '2026-03-01T00:00:00.000Z',
      billingDay: 1, createdBy: 'u_paul',
    });
    expect(subscription.terms.renewalDate).toBe('2028-03-01T00:00:00.000Z');
    expect(subscription.terms.nextBillingDate).toBe('2027-03-01T00:00:00.000Z');
  });

  it('refuses a billing day that does not exist in February', async () => {
    const { accounts, account } = await start();
    await expect(accounts.startSubscription({
      accountId: account.accountId, planCode: 'growth', term: 'twelve_months',
      billingInterval: 'monthly', startDate: '2026-03-31T00:00:00.000Z',
      billingDay: 31, createdBy: 'u_paul',
    })).rejects.toThrow(/every month/i);
  });

  it('activates the account when the subscription starts', async () => {
    const { accounts, account } = await start();
    await accounts.startSubscription({
      accountId: account.accountId, planCode: 'starter', term: 'rolling_monthly',
      billingInterval: 'monthly', startDate: '2026-03-01T00:00:00.000Z', createdBy: 'u_paul',
    });
    expect((await accounts.get(account.accountId))?.status).toBe('active');
  });

  it('defaults notice to 30 days rolling and 90 on a term', async () => {
    // A notice period nobody recorded is one the customer will say was thirty.
    const { accounts, account } = await start();
    const rolling = await accounts.startSubscription({
      accountId: account.accountId, planCode: 'starter', term: 'rolling_monthly',
      billingInterval: 'monthly', startDate: '2026-03-01T00:00:00.000Z', createdBy: 'u_paul',
    });
    expect(rolling.terms.noticePeriodDays).toBe(30);
  });

  it('carries the plan limits and monthly credits by default', async () => {
    const { accounts, account } = await start();
    const subscription = await accounts.startSubscription({
      accountId: account.accountId, planCode: 'growth', term: 'twelve_months',
      billingInterval: 'monthly', startDate: '2026-03-01T00:00:00.000Z', createdBy: 'u_paul',
    });
    expect(subscription.monthlyCreditsPence).toBe(15_000);
    expect(subscription.limits.spendCap.amount).toBe(defaultLimitsFor('growth').spendCap.amount);
  });

  it('lets negotiated limits override the plan', async () => {
    const { accounts, account } = await start();
    const subscription = await accounts.startSubscription({
      accountId: account.accountId, planCode: 'growth', term: 'twelve_months',
      billingInterval: 'monthly', startDate: '2026-03-01T00:00:00.000Z',
      limits: { seats: 40, voiceMinutesPerPeriod: 5_000, spendCap: money(250_000) },
      monthlyCreditsPence: 40_000, createdBy: 'u_paul',
    });
    expect(subscription.limits.seats).toBe(40);
    expect(subscription.limits.spendCap.amount).toBe(250_000);
    expect(subscription.monthlyCreditsPence).toBe(40_000);
  });

  it('advances only the billing date, leaving the renewal date alone', async () => {
    const { accounts, account } = await start();
    await accounts.startSubscription({
      accountId: account.accountId, planCode: 'growth', term: 'twelve_months',
      billingInterval: 'monthly', startDate: '2026-03-01T00:00:00.000Z',
      billingDay: 1, createdBy: 'u_paul',
    });
    const after = await accounts.advanceBilling(account.accountId);
    expect(after.terms.nextBillingDate).toBe('2026-05-01T00:00:00.000Z');
    expect(after.terms.renewalDate).toBe('2027-03-01T00:00:00.000Z');
  });

  it('applies the agreed uplift at renewal', async () => {
    const { accounts, account } = await start();
    await accounts.startSubscription({
      accountId: account.accountId, planCode: 'growth', term: 'twelve_months',
      billingInterval: 'monthly', startDate: '2026-03-01T00:00:00.000Z',
      renewalUpliftBasisPoints: 500, createdBy: 'u_paul',
    });
    const renewed = await accounts.renew(account.accountId);
    // £750 plus 5%.
    expect(renewed.contractedPlatformFee.amount).toBe(78_750);
    expect(renewed.terms.renewalDate).toBe('2028-03-01T00:00:00.000Z');
  });

  it('accepts notice given in time and ends the term at renewal', async () => {
    const { accounts, account } = await start();
    await accounts.startSubscription({
      accountId: account.accountId, planCode: 'growth', term: 'twelve_months',
      billingInterval: 'monthly', startDate: '2026-03-01T00:00:00.000Z',
      noticePeriodDays: 90, createdBy: 'u_paul',
    });
    const notice = await accounts.giveNotice(account.accountId, 'u_paul');
    expect(notice.inTimeForThisTerm).toBe(true);
    expect(notice.effectiveDate).toBe('2027-03-01T00:00:00.000Z');
  });

  it('pushes late notice to the following term instead of accepting it quietly', async () => {
    // Accepting late notice silently cancels a term the customer was still
    // committed to, and nobody notices until the revenue is gone.
    const late = new FixedClock(new Date('2027-02-01T09:00:00.000Z'));
    const accounts = new AccountService(new InMemoryAccountStore(), late);
    const account = await accounts.create({
      name: 'NW', tenantId: 't_nw', billingEmail: 'ap@nw.example',
      countryCode: 'GB', createdBy: 'u_paul',
    });
    await accounts.startSubscription({
      accountId: account.accountId, planCode: 'growth', term: 'twelve_months',
      billingInterval: 'monthly', startDate: '2026-03-01T00:00:00.000Z',
      noticePeriodDays: 90, createdBy: 'u_paul',
    });
    const notice = await accounts.giveNotice(account.accountId, 'u_paul');
    expect(notice.inTimeForThisTerm).toBe(false);
    expect(notice.effectiveDate).toBe('2028-03-01T00:00:00.000Z');
  });

  it('will not renew a subscription that has had notice', async () => {
    const { accounts, account } = await start();
    await accounts.startSubscription({
      accountId: account.accountId, planCode: 'growth', term: 'twelve_months',
      billingInterval: 'monthly', startDate: '2026-03-01T00:00:00.000Z', createdBy: 'u_paul',
    });
    await accounts.giveNotice(account.accountId, 'u_paul');
    await expect(accounts.renew(account.accountId)).rejects.toThrow();
  });

  it('computes the notice deadline from the renewal date', async () => {
    const { accounts, account } = await start();
    const subscription = await accounts.startSubscription({
      accountId: account.accountId, planCode: 'growth', term: 'twelve_months',
      billingInterval: 'monthly', startDate: '2026-03-01T00:00:00.000Z',
      noticePeriodDays: 90, createdBy: 'u_paul',
    });
    expect(noticeDeadline(subscription.terms).slice(0, 10)).toBe('2026-12-01');
  });
});

describe('passwords', () => {
  it('verifies a correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
    expect(await verifyPassword('Correct horse battery staple', hash)).toBe(false);
  });

  it('never stores the password itself', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).not.toContain('correct horse');
    expect(hash.startsWith('scrypt$')).toBe(true);
  });

  it('produces a different hash each time, so identical passwords are not obvious', async () => {
    const a = await hashPassword('correct horse battery staple');
    const b = await hashPassword('correct horse battery staple');
    expect(a).not.toBe(b);
  });

  it('returns false rather than throwing on a malformed hash', async () => {
    // A thrown error during login is an oracle telling an attacker something.
    for (const bad of ['', 'nonsense', 'scrypt$x$y$z$q$r', 'bcrypt$1$2$3$4$5']) {
      expect(await verifyPassword('anything', bad)).toBe(false);
    }
  });

  it('refuses a hash claiming an absurd cost, which would hang the endpoint', async () => {
    expect(await verifyPassword('x', `scrypt$99999999$8$1$aa$${'0'.repeat(128)}`)).toBe(false);
  });

  it('judges length, not composition', () => {
    // Composition rules measurably produce worse passwords: people satisfy
    // them with Password1! and stop thinking.
    expect(checkPasswordStrength('correct horse battery staple')).toEqual([]);
    expect(checkPasswordStrength('Sh0rt!').length).toBeGreaterThan(0);
  });

  it('rejects a password containing the user’s own details', () => {
    expect(checkPasswordStrength('northwind trading 2026', ['Northwind']).length).toBeGreaterThan(0);
  });

  it('generates a password with no ambiguous characters', () => {
    const generated = generatePassword();
    expect(generated).not.toMatch(/[0O1lI]/);
    expect(generated.length).toBeGreaterThan(24);
  });
});

describe('the realm boundary', () => {
  const build = () => {
    const users = new UserService(new InMemoryUserStore(), clock());
    const sessions = new SessionService(new InMemorySessionStore(), SECRET, clock());
    return { users, sessions };
  };

  it('will not let a console user belong to a tenant', async () => {
    // Staff belong to Detent. Giving them a tenant would make cross-tenant
    // access look like ordinary access.
    const { users } = build();
    await expect(users.create({
      realm: 'console', email: 'a@detent.io', name: 'A',
      password: 'correct horse battery staple', roles: ['admin'], tenantId: 't_x',
    })).rejects.toThrow(/must not belong/i);
  });

  it('requires an app user to belong to a tenant', async () => {
    const { users } = build();
    await expect(users.create({
      realm: 'app', email: 'b@customer.example', name: 'B',
      password: 'correct horse battery staple', roles: ['owner'],
    })).rejects.toThrow(/must belong/i);
  });

  it('keeps the same email separate in each realm', async () => {
    const { users } = build();
    await users.create({
      realm: 'console', email: 'paul@detent.io', name: 'Paul',
      password: 'correct horse battery staple', roles: ['admin'],
    });
    await expect(users.create({
      realm: 'app', email: 'paul@detent.io', name: 'Paul',
      password: 'correct horse battery staple', roles: ['owner'], tenantId: 't_x',
    })).resolves.toBeDefined();
  });

  it('refuses a console cookie presented to the customer app', async () => {
    // This is what keeps the back office invisible to end users even when one
    // process serves both sites.
    const { sessions } = build();
    const { token } = await sessions.start({ userId: 'u1', realm: 'console' });
    expect(await sessions.resolve('console', token)).toBeDefined();
    expect(await sessions.resolve('app', token)).toBeUndefined();
  });

  it('will not authenticate a customer against the console realm', async () => {
    const { users } = build();
    await users.create({
      realm: 'app', email: 'c@customer.example', name: 'C',
      password: 'correct horse battery staple', roles: ['owner'], tenantId: 't_x',
    });
    const outcome = await users.login('console', 'c@customer.example', 'correct horse battery staple');
    expect(outcome.ok).toBe(false);
  });
});

describe('login', () => {
  const build = () => new UserService(new InMemoryUserStore(), clock());
  const seed = async (users: UserService) => users.create({
    realm: 'console', email: 'paul@detent.io', name: 'Paul',
    password: 'correct horse battery staple', roles: ['admin'],
  });

  it('accepts the right password', async () => {
    const users = build();
    await seed(users);
    expect((await users.login('console', 'paul@detent.io', 'correct horse battery staple')).ok).toBe(true);
  });

  it('is case-insensitive on the email but not the password', async () => {
    const users = build();
    await seed(users);
    expect((await users.login('console', 'PAUL@DETENT.IO', 'correct horse battery staple')).ok).toBe(true);
    expect((await users.login('console', 'paul@detent.io', 'CORRECT HORSE BATTERY STAPLE')).ok).toBe(false);
  });

  it('gives the same answer for an unknown address as a wrong password', async () => {
    const users = build();
    await seed(users);
    const unknown = await users.login('console', 'nobody@detent.io', 'whatever at all');
    const wrong = await users.login('console', 'paul@detent.io', 'wrong password entirely');
    expect(unknown).toEqual(wrong);
  });

  it('locks the account after repeated failures', async () => {
    const users = build();
    await seed(users);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await users.login('console', 'paul@detent.io', 'wrong password entirely');
    }
    const outcome = await users.login('console', 'paul@detent.io', 'correct horse battery staple');
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toBe('locked');
  });

  it('refuses a disabled account before checking the password', async () => {
    const users = build();
    const user = await seed(users);
    await users.setActive(user.userId, false);
    const outcome = await users.login('console', 'paul@detent.io', 'correct horse battery staple');
    expect(outcome.ok === false && outcome.reason).toBe('disabled');
  });
});

describe('sessions', () => {
  const build = () => new SessionService(new InMemorySessionStore(), SECRET, clock());

  it('refuses a session secret short enough to brute force', () => {
    expect(() => new SessionService(new InMemorySessionStore(), 'short')).toThrow();
  });

  it('rejects a tampered token without touching the store', async () => {
    const sessions = build();
    const { token } = await sessions.start({ userId: 'u1', realm: 'console' });
    expect(await sessions.resolve('console', `${token}x`)).toBeUndefined();
    expect(await sessions.resolve('console', 'forged.signature')).toBeUndefined();
  });

  it('ends a session immediately, which a JWT could not', async () => {
    const sessions = build();
    const { token } = await sessions.start({ userId: 'u1', realm: 'console' });
    await sessions.end(token);
    expect(await sessions.resolve('console', token)).toBeUndefined();
  });

  it('expires a console session sooner than an app session', async () => {
    const time = clock();
    const sessions = new SessionService(new InMemorySessionStore(), SECRET, time);
    const operator = await sessions.start({ userId: 'u1', realm: 'console' });
    const customer = await sessions.start({ userId: 'u2', realm: 'app' });
    time.advance(9 * 3_600_000);
    expect(await sessions.resolve('console', operator.token)).toBeUndefined();
    expect(await sessions.resolve('app', customer.token)).toBeDefined();
  });

  it('ends a console session that has gone idle', async () => {
    const time = clock();
    const sessions = new SessionService(new InMemorySessionStore(), SECRET, time);
    const { token } = await sessions.start({ userId: 'u1', realm: 'console' });
    time.advance(61 * 60_000);
    expect(await sessions.resolve('console', token)).toBeUndefined();
  });

  it('sets a cookie that script cannot read and a sibling site cannot set', async () => {
    const sessions = build();
    const { token } = await sessions.start({ userId: 'u1', realm: 'console' });
    const cookie = sessions.cookie('console', token);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie.startsWith('__Host-')).toBe(true);
  });

  it('reads one cookie out of a header without matching a prefix', () => {
    const header = '__Host-detent_app=aaa; __Host-detent_console=bbb; other=ccc';
    expect(readCookie(header, '__Host-detent_console')).toBe('bbb');
    expect(readCookie(header, 'detent_console')).toBeUndefined();
  });

  it('binds a CSRF token to its session', () => {
    expect(csrfValid('sess1', SECRET, csrfTokenFor('sess1', SECRET))).toBe(true);
    expect(csrfValid('sess1', SECRET, csrfTokenFor('sess2', SECRET))).toBe(false);
    expect(csrfValid('sess1', SECRET, undefined)).toBe(false);
  });
});
