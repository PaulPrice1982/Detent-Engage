import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { FixedClock } from '@detent/awa-core';
import { buildDevSites, entitlementOf, parseForm, type SiteRequest } from '@detent/awa-server';

/**
 * The two-site boundary.
 *
 * These tests exist to prove one property: **an end user cannot reach the back
 * office.** Both sites run in one process here, which is the hardest case , 
 * same host, same port, same cookie jar, so if the boundary holds here it
 * holds when they are split across hosts.
 */

const PASSWORD = 'correct horse battery staple';

async function sites() {
  const clock = new FixedClock(new Date('2026-03-01T09:00:00.000Z'));
  return {
    clock,
    ...(await buildDevSites({
      audit: new AuditLog(new InMemoryAuditStore(), clock),
      clock,
      sessionSecret: 'x'.repeat(48),
      operatorEmail: 'Paul.price@detentgtm.io',
      operatorPassword: PASSWORD,
      secureCookies: false,
    })),
  };
}

const get = (path: string, cookie?: string): SiteRequest => ({
  method: 'GET', path, query: {}, headers: cookie ? { cookie } : {},
});

const post = (path: string, body: Record<string, string>, cookie?: string): SiteRequest => ({
  method: 'POST', path, query: {},
  headers: cookie ? { cookie } : {},
  rawBody: new URLSearchParams(body).toString(),
});

/** Turns a Set-Cookie into a Cookie header. */
const jar = (response: { cookies?: readonly string[] }): string =>
  (response.cookies ?? []).map((cookie) => cookie.split(';')[0]).join('; ');

describe('the back office is closed', () => {
  it('sends an unauthenticated visitor to sign in, from every page', async () => {
    const { consoleRouter } = await sites();
    for (const path of ['/console', '/console/new', '/console/approvals', '/console/accounts/acc_1']) {
      const response = await consoleRouter.handle(get(path));
      expect(response?.status).toBe(303);
      expect(response?.redirect).toBe('/console/signin');
    }
  });

  it('offers no self-service registration into the back office', async () => {
    // Signing yourself up would be a way to grant yourself access to every
    // customer's money.
    const { consoleRouter } = await sites();
    expect((await consoleRouter.handle(get('/console/signup')))?.status).toBe(404);
    expect((await consoleRouter.handle(post('/console/signup', { email: 'a@b.co' })))?.status).toBe(404);
  });

  it('reveals nothing about what is behind it before sign-in', async () => {
    const { consoleRouter } = await sites();
    const response = await consoleRouter.handle(get('/console/signin'));
    const html = response?.html ?? '';
    expect(html).not.toMatch(/Northwind|account|credit|invoice/i);
    expect(html).toContain('Staff access');
  });
});

describe('signing in to the console', () => {
  it('accepts the configured operator', async () => {
    const { consoleRouter } = await sites();
    const response = await consoleRouter.handle(
      post('/console/signin', { email: 'Paul.price@detentgtm.io', password: PASSWORD }),
    );
    expect(response?.status).toBe(303);
    expect(response?.redirect).toBe('/console');
    expect(jar(response!)).toContain('detent_console=');
  });

  it('rejects the wrong password without saying the address exists', async () => {
    const { consoleRouter } = await sites();
    const wrong = await consoleRouter.handle(
      post('/console/signin', { email: 'Paul.price@detentgtm.io', password: 'nope nope nope' }),
    );
    const unknown = await consoleRouter.handle(
      post('/console/signin', { email: 'nobody@detentgtm.io', password: 'nope nope nope' }),
    );
    expect(wrong?.status).toBe(401);
    expect(unknown?.status).toBe(401);
    expect(wrong?.html).toBe(unknown?.html?.replace('nobody@detentgtm.io', 'Paul.price@detentgtm.io'));
  });

  it('lets a signed-in operator see the accounts page', async () => {
    const { consoleRouter } = await sites();
    const login = await consoleRouter.handle(
      post('/console/signin', { email: 'Paul.price@detentgtm.io', password: PASSWORD }),
    );
    const page = await consoleRouter.handle(get('/console', jar(login!)));
    expect(page?.status).toBe(200);
    expect(page?.html).toContain('Accounts');
  });

  it('ends the session on sign-out', async () => {
    const { consoleRouter } = await sites();
    const login = await consoleRouter.handle(
      post('/console/signin', { email: 'Paul.price@detentgtm.io', password: PASSWORD }),
    );
    const cookie = jar(login!);
    await consoleRouter.handle(get('/console/signout', cookie));
    expect((await consoleRouter.handle(get('/console', cookie)))?.redirect).toBe('/console/signin');
  });
});

describe('the customer app', () => {
  const signUp = async () => {
    const built = await sites();
    const response = await built.appRouter.handle(post('/app/signup', {
      organisation: 'Vertex Systems', name: 'Sam Adler',
      email: 'sam@vertex.example', password: PASSWORD,
    }));
    return { ...built, cookie: jar(response!), response };
  };

  it('creates the tenant and the account together at sign-up', async () => {
    // A customer must never exist in one system and not the other.
    const { accounts, response } = await signUp();
    expect(response?.status).toBe(303);
    const account = await accounts.byTenant('t_vertex_systems');
    expect(account?.name).toBe('Vertex Systems');
  });

  it('shows the customer their own organisation', async () => {
    const { appRouter, cookie } = await signUp();
    const page = await appRouter.handle(get('/app', cookie));
    expect(page?.status).toBe(200);
    expect(page?.html).toContain('Vertex Systems');
  });

  it('shows the customer their own contract terms, not a summary of them', async () => {
    // Hiding a customer's own contract creates the support call the console
    // was built to avoid.
    const { appRouter, cookie } = await signUp();
    const page = await appRouter.handle(get('/app/billing', cookie));
    expect(page?.html).toContain('Notice period');
    expect(page?.html).toContain('Renews');
  });

  it('refuses a weak password at sign-up', async () => {
    const { appRouter } = await sites();
    const response = await appRouter.handle(post('/app/signup', {
      organisation: 'Weak Ltd', name: 'A', email: 'a@weak.example', password: 'short',
    }));
    expect(response?.status).toBe(400);
    expect(response?.html).toMatch(/12 characters/i);
  });
});

describe('the boundary between the two sites', () => {
  const both = async () => {
    const built = await sites();
    const operator = await built.consoleRouter.handle(
      post('/console/signin', { email: 'Paul.price@detentgtm.io', password: PASSWORD }),
    );
    const customer = await built.appRouter.handle(post('/app/signup', {
      organisation: 'Vertex Systems', name: 'Sam', email: 'sam@vertex.example', password: PASSWORD,
    }));
    return { ...built, operatorCookie: jar(operator!), customerCookie: jar(customer!) };
  };

  it('will not let a customer session open the back office', async () => {
    // The property the whole realm design exists for.
    const { consoleRouter, customerCookie } = await both();
    for (const path of ['/console', '/console/new', '/console/approvals']) {
      const response = await consoleRouter.handle(get(path, customerCookie));
      expect(response?.redirect).toBe('/console/signin');
    }
  });

  it('will not let an operator session open the customer app', async () => {
    const { appRouter, operatorCookie } = await both();
    expect((await appRouter.handle(get('/app', operatorCookie)))?.redirect).toBe('/app/signin');
  });

  it('will not authenticate a console credential at the customer app', async () => {
    const { appRouter } = await both();
    const response = await appRouter.handle(
      post('/app/signin', { email: 'Paul.price@detentgtm.io', password: PASSWORD }),
    );
    expect(response?.status).toBe(401);
  });

  it('will not authenticate a customer credential at the console', async () => {
    const { consoleRouter } = await both();
    const response = await consoleRouter.handle(
      post('/console/signin', { email: 'sam@vertex.example', password: PASSWORD }),
    );
    expect(response?.status).toBe(401);
  });

  it('does not leak another customer into a customer page', async () => {
    const { consoleRouter, appRouter, operatorCookie, customerCookie } = await both();
    const csrfPage = await consoleRouter.handle(get('/console/new', operatorCookie));
    const csrf = /name="csrf" value="([^"]+)"/.exec(csrfPage?.html ?? '')?.[1] ?? '';
    await consoleRouter.handle(post('/console/new', {
      csrf, name: 'Northwind Trading', tenantId: 't_northwind',
      billingEmail: 'ap@northwind.example', countryCode: 'GB', planCode: 'growth',
      term: 'twelve_months', billingInterval: 'monthly', startDate: '2026-03-01',
      billingDay: '1', noticePeriodDays: '90',
    }, operatorCookie));

    const page = await appRouter.handle(get('/app', customerCookie));
    expect(page?.html).not.toContain('Northwind');
  });
});

describe('CSRF', () => {
  it('refuses a POST without a matching token', async () => {
    const { consoleRouter } = await sites();
    const login = await consoleRouter.handle(
      post('/console/signin', { email: 'Paul.price@detentgtm.io', password: PASSWORD }),
    );
    const response = await consoleRouter.handle(
      post('/console/new', { name: 'Sneaky', tenantId: 't_x' }, jar(login!)),
    );
    expect(response?.status).toBe(403);
  });
});

describe('account creation through the console', () => {
  const signedIn = async () => {
    const built = await sites();
    const login = await built.consoleRouter.handle(
      post('/console/signin', { email: 'Paul.price@detentgtm.io', password: PASSWORD }),
    );
    const cookie = jar(login!);
    const form = await built.consoleRouter.handle(get('/console/new', cookie));
    const csrf = /name="csrf" value="([^"]+)"/.exec(form?.html ?? '')?.[1] ?? '';
    return { ...built, cookie, csrf };
  };

  it('creates the account and its subscription in one action', async () => {
    // An account must never sit in the system without commercial terms.
    const { consoleRouter, accounts, cookie, csrf } = await signedIn();
    const response = await consoleRouter.handle(post('/console/new', {
      csrf, name: 'Northwind Trading', tenantId: 't_northwind',
      billingEmail: 'ap@northwind.example', countryCode: 'GB', planCode: 'growth',
      term: 'twelve_months', billingInterval: 'monthly', startDate: '2026-03-01',
      billingDay: '1', noticePeriodDays: '90', renewalUplift: '5',
      monthlyCredits: '200', seats: '40', spendCap: '2500',
    }, cookie));
    expect(response?.status).toBe(303);

    const account = await accounts.byTenant('t_northwind');
    expect(account?.status).toBe('active');
    const subscription = await accounts.subscription(account!.accountId);
    expect(subscription?.terms.renewalDate).toBe('2027-03-01T00:00:00.000Z');
    expect(subscription?.terms.nextBillingDate).toBe('2026-04-01T00:00:00.000Z');
    expect(subscription?.terms.noticePeriodDays).toBe(90);
    expect(subscription?.terms.renewalUpliftBasisPoints).toBe(500);
    expect(subscription?.monthlyCreditsPence).toBe(20_000);
    expect(subscription?.limits.seats).toBe(40);
    expect(subscription?.limits.spendCap.amount).toBe(250_000);
  });

  it('redisplays the form with the reason when creation fails', async () => {
    const { consoleRouter, cookie, csrf } = await signedIn();
    const response = await consoleRouter.handle(post('/console/new', {
      csrf, name: 'Bad', tenantId: 't_bad', billingEmail: 'not-an-email', countryCode: 'GB',
    }, cookie));
    expect(response?.status).toBe(400);
    expect(response?.html).toMatch(/billing email/i);
  });

  it('shows the term, dates and limits on the account page', async () => {
    const { consoleRouter, accounts, cookie, csrf } = await signedIn();
    await consoleRouter.handle(post('/console/new', {
      csrf, name: 'Northwind', tenantId: 't_northwind',
      billingEmail: 'ap@northwind.example', countryCode: 'GB', planCode: 'growth',
      term: 'twelve_months', billingInterval: 'monthly', startDate: '2026-03-01',
      billingDay: '1', noticePeriodDays: '90',
    }, cookie));
    const account = await accounts.byTenant('t_northwind');
    const page = await consoleRouter.handle(
      get(`/console/accounts/${account!.accountId}`, cookie),
    );
    const html = page?.html ?? '';
    for (const expected of ['Term', 'Renews', 'Next invoice', 'Monthly credits',
                            'Notice deadline', 'Auto-renew', 'Limits per period', 'Spend cap']) {
      expect(html).toContain(expected);
    }
  });
});

describe('form parsing', () => {
  it('reads a urlencoded body', () => {
    expect(parseForm('a=1&b=two+words')).toEqual({ a: '1', b: 'two words' });
    expect(parseForm(undefined)).toEqual({});
  });
});

describe('the configured operator credential', () => {
  const built = (password?: string, email = 'Paul.price@detentgtm.io') => {
    const clock = new FixedClock(new Date('2026-03-01T09:00:00.000Z'));
    return buildDevSites({
      audit: new AuditLog(new InMemoryAuditStore(), clock),
      clock,
      sessionSecret: 'x'.repeat(48),
      operatorEmail: email,
      operatorPassword: password,
      secureCookies: false,
    });
  };

  it('signs in with the password from the environment', async () => {
    const sites = await built(PASSWORD);
    expect(sites.operatorConfigured).toBe(true);
    const response = await sites.consoleRouter.handle(
      post('/console/signin', { email: 'Paul.price@detentgtm.io', password: PASSWORD }),
    );
    expect(response?.status).toBe(303);
  });

  it('tolerates a secret pasted with surrounding whitespace', async () => {
    // A value pasted into a hosting provider's secret UI very often carries a
    // trailing newline, and an untrimmed password fails with exactly the
    // message a wrong password gives, sending somebody hunting in the wrong
    // place entirely.
    const sites = await built(`  ${PASSWORD}\n`);
    const response = await sites.consoleRouter.handle(
      post('/console/signin', { email: 'Paul.price@detentgtm.io', password: PASSWORD }),
    );
    expect(response?.status).toBe(303);
  });

  it('tolerates whitespace around the configured email too', async () => {
    const sites = await built(PASSWORD, ' Paul.price@detentgtm.io ');
    expect(sites.operatorEmail).toBe('paul.price@detentgtm.io');
    const response = await sites.consoleRouter.handle(
      post('/console/signin', { email: 'paul.price@detentgtm.io', password: PASSWORD }),
    );
    expect(response?.status).toBe(303);
  });

  it('creates no operator at all when no password is configured', async () => {
    // Nothing generated, nothing written to disk: the secret is the only place
    // the password exists, which is the only arrangement that survives a
    // deployment security scan.
    const sites = await built(undefined);
    expect(sites.operatorConfigured).toBe(false);
    const response = await sites.consoleRouter.handle(post('/console/signin', {
      email: 'Paul.price@detentgtm.io', password: PASSWORD,
    }));
    expect(response?.status).toBe(401);
  });

  it('says which secret to set rather than refusing silently', async () => {
    const sites = await built(undefined);
    const page = await sites.consoleRouter.handle(get('/console/signin'));
    expect(page?.html).toMatch(/DETENT_CONSOLE_PASSWORD/);
    expect(page?.html).toMatch(/no password is written anywhere|only place it exists/i);
  });

  it('keeps the customer app working when the console is unconfigured', async () => {
    // Refusing to start would take the customer app down with it, and the
    // customer app has no need of that secret.
    const sites = await built(undefined);
    expect((await sites.appRouter.handle(get('/app/signin')))?.status).toBe(200);
  });

  it('treats an empty secret as unset rather than as a blank password', async () => {
    expect((await built('   ')).operatorConfigured).toBe(false);
  });
});

describe('the paid pages', () => {
  const account = (over: Record<string, unknown> = {}) => ({
    accountId: 'a1', name: 'Vertex', tenantId: 't_vertex', status: 'active' as const,
    billingEmail: 'ap@vertex.example', countryCode: 'GB',
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'u1', ...over,
  });
  const subscription = (feePence: number) => ({
    subscriptionId: 's1', accountId: 'a1', tenantId: 't_vertex',
    planCode: 'starter' as const, planVersion: 1,
    terms: {
      term: 'rolling_monthly' as const, startDate: '2026-01-01T00:00:00.000Z',
      renewalDate: '2026-02-01T00:00:00.000Z', billingInterval: 'monthly' as const,
      billingDay: 1, nextBillingDate: '2026-02-01T00:00:00.000Z',
      noticePeriodDays: 30, autoRenew: true,
    },
    limits: { spendCap: { amount: 25_000, currency: 'GBP' as const } },
    monthlyCreditsPence: 5_000,
    contractedPlatformFee: { amount: feePence, currency: 'GBP' as const },
    createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'u1',
  });

  it('lets a paying subscriber in', async () => {
    expect(entitlementOf(subscription(35_000), account()).state).toBe('entitled');
  });

  it('keeps out an account with no subscription', async () => {
    expect(entitlementOf(undefined, account()).state).toBe('no_subscription');
  });

  it('keeps out a zero-fee subscription, which is a trial not a plan', async () => {
    expect(entitlementOf(subscription(0), account()).state).toBe('not_paying');
  });

  it('keeps out a suspended account even though it pays', async () => {
    const result = entitlementOf(subscription(35_000), account({ status: 'suspended' }));
    expect(result.state).toBe('suspended');
    expect(result.reason).toMatch(/settle/i);
  });

  it('gives a different reason for each case, not one unhelpful screen', async () => {
    // A lapsed customer, a trial and a suspension each need a different action
    // from the person reading it.
    const reasons = new Set([
      entitlementOf(undefined, account()).reason,
      entitlementOf(subscription(0), account()).reason,
      entitlementOf(subscription(35_000), account({ status: 'suspended' })).reason,
    ]);
    expect(reasons.size).toBe(3);
  });

  it('sends an unauthenticated visitor to sign in, not to an upgrade page', async () => {
    const { appRouter } = await sites();
    for (const path of ['/app/install', '/app/api', '/app/status']) {
      expect((await appRouter.handle(get(path)))?.redirect).toBe('/app/signin');
    }
  });
});

describe('provider sign-in buttons', () => {
  it('offers Google and Apple on both sign-in and sign-up', async () => {
    const { appRouter } = await sites();
    const signIn = await appRouter.handle(get('/app/signin'));
    const signUp = await appRouter.handle(get('/app/signup'));
    for (const html of [signIn?.html ?? '', signUp?.html ?? '']) {
      expect(html).toMatch(/Google/);
      expect(html).toMatch(/Apple/);
    }
  });

  it('says which secrets are missing rather than doing nothing', async () => {
    // A button that silently fails is the hardest kind of failure to diagnose.
    const { appRouter } = await sites();
    const response = await appRouter.handle(get('/app/auth/google'));
    expect(response?.status).toBe(503);
    expect(response?.html).toMatch(/GOOGLE_CLIENT_ID/);
    expect(response?.html).toMatch(/redirect URI/i);
  });

  it('offers no provider sign-in on the back office', async () => {
    // Staff accounts are provisioned, never self-claimed through a consumer
    // identity provider.
    const { consoleRouter } = await sites();
    expect((await consoleRouter.handle(get('/console/auth/google')))?.status).toBe(404);
    expect((await consoleRouter.handle(get('/console/signin')))?.html).not.toMatch(/Continue with/);
  });
});

describe('the deployment posture', () => {
  const deploy = (over: Record<string, unknown> = {}) => {
    const clock = new FixedClock(new Date('2026-03-01T09:00:00.000Z'));
    return buildDevSites({
      audit: new AuditLog(new InMemoryAuditStore(), clock),
      clock,
      sessionSecret: 'x'.repeat(48),
      operatorEmail: 'Paul.price@detentgtm.io',
      deployed: true,
      ...over,
    });
  };

  it('serves deployed without a console password, but nobody can sign in', async () => {
    // Refusing to start would take the customer app down for a secret it does
    // not need. There is no credential to leak either way, because nothing is
    // generated and nothing is written to disk.
    const sites = await deploy();
    expect(sites.operatorConfigured).toBe(false);
    expect((await sites.appRouter.handle(get('/app/signin')))?.status).toBe(200);
    expect((await sites.consoleRouter.handle(post('/console/signin', {
      email: 'Paul.price@detentgtm.io', password: PASSWORD,
    })))?.status).toBe(401);
  });

  it('starts deployed when the password is configured', async () => {
    expect((await deploy({ operatorPassword: PASSWORD })).operatorConfigured).toBe(true);
  });

  it('generates nothing anywhere, deployed or not', async () => {
    const deployedSites = await deploy({ operatorPassword: PASSWORD });
    expect(deployedSites.operatorConfigured).toBe(true);

    const clock = new FixedClock(new Date('2026-03-01T09:00:00.000Z'));
    const dev = await buildDevSites({
      audit: new AuditLog(new InMemoryAuditStore(), clock),
      clock, sessionSecret: 'x'.repeat(48), secureCookies: false,
    });
    expect(dev.operatorConfigured).toBe(false);
  });
});
