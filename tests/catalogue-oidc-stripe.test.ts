import { describe, expect, it } from 'vitest';
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { FixedClock } from '@detent/awa-core';
import {
  InMemoryPlanCatalogueStore, PlanCatalogueService, money,
} from '@detent/awa-billing';
import {
  APPLE_ISSUER, GOOGLE_ISSUER, InMemoryOidcFlowStore, appleProvider, googleProvider,
  pkcePair, refusalMessage, safeReturnTo, startFlow, toIdentity, verifyIdToken,
  type Jwk,
} from '@detent/awa-auth';
import { StripeProvider, encodeForm, type HttpClient } from '@detent/awa-payments';

const clock = () => new FixedClock(new Date('2026-03-01T09:00:00.000Z'));

describe('the plan catalogue', () => {
  const service = async () => {
    const catalogue = new PlanCatalogueService(new InMemoryPlanCatalogueStore(), clock());
    await catalogue.seed('system');
    return catalogue;
  };

  it('seeds the plans that are in code', async () => {
    const catalogue = await service();
    const growth = await catalogue.current('growth');
    expect(growth?.platformFee.monthly.amount).toBe(75_000);
    expect(growth?.includedCreditsPence).toBe(15_000);
  });

  it('drafts a new version rather than editing the published one', async () => {
    // Editing in place would silently change what a signed contract referred to.
    const catalogue = await service();
    const draft = await catalogue.draft('growth', { platformFeeMonthly: money(85_000) }, {
      createdBy: 'u_paul', changeNote: '2026 uplift',
    });
    expect(draft.version).toBe(2);
    expect(draft.state).toBe('draft');
    expect((await catalogue.current('growth'))?.platformFee.monthly.amount).toBe(75_000);
  });

  it('requires a note saying why the version exists', async () => {
    const catalogue = await service();
    await expect(catalogue.draft('growth', { platformFeeMonthly: money(85_000) }, {
      createdBy: 'u_paul', changeNote: '   ',
    })).rejects.toThrow(/why/i);
  });

  it('refuses an annual price above twelve monthly payments', async () => {
    // Almost always a typo, and one a customer finds before we do.
    const catalogue = await service();
    await expect(catalogue.draft('growth', {
      platformFeeMonthly: money(75_000), platformFeeAnnual: money(999_000),
    }, { createdBy: 'u_paul', changeNote: 'oops' })).rejects.toThrow(/twelve monthly/i);
  });

  it('publishes a draft and withdraws the previous version', async () => {
    const catalogue = await service();
    await catalogue.draft('growth', { platformFeeMonthly: money(85_000) }, {
      createdBy: 'u_paul', changeNote: '2026 uplift',
    });
    await catalogue.publish('growth', 2, 'u_sam');
    expect((await catalogue.current('growth'))?.version).toBe(2);
    // Withdrawn, not deleted: subscriptions sold on it still point at it.
    const versions = await catalogue.versions('growth');
    expect(versions.find((version) => version.version === 1)?.state).toBe('withdrawn');
  });

  it('keeps the old version readable, so "what were we selling in March" is answerable', async () => {
    const catalogue = await service();
    await catalogue.draft('growth', { platformFeeMonthly: money(85_000) }, {
      createdBy: 'u_paul', changeNote: 'uplift',
    });
    await catalogue.publish('growth', 2, 'u_sam');
    const original = await catalogue.versionFor('growth', 1);
    expect(original?.platformFee.monthly.amount).toBe(75_000);
  });

  it('reports the impact of a change in commercial terms', async () => {
    const catalogue = await service();
    await catalogue.draft('growth', {
      platformFeeMonthly: money(90_000), includedCreditsPence: 10_000,
      activationFee: money(50_000),
    }, { createdBy: 'u_paul', changeNote: 'repackage' });
    const impact = await catalogue.impact('growth', 2);
    expect(impact.monthlyChange.amount).toBe(15_000);
    expect(impact.monthlyChangeBasisPoints).toBe(2_000); // +20%
    expect(impact.creditsChange).toBe(-5_000);
    expect(impact.activationFeeChange.amount).toBe(50_000);
  });

  it('warns about the changes that look small on a form and are not', async () => {
    const catalogue = await service();
    await catalogue.draft('growth', {
      includedCreditsPence: 5_000, activationFee: money(50_000), selfServiceAvailable: false,
    }, { createdBy: 'u_paul', changeNote: 'repackage' });
    const impact = await catalogue.impact('growth', 2);
    const warnings = impact.warnings.join(' ');
    expect(warnings).toMatch(/credits fall/i);
    expect(warnings).toMatch(/activation fee/i);
    expect(warnings).toMatch(/self-service/i);
  });

  it('warns on a price move above 20 per cent', async () => {
    const catalogue = await service();
    await catalogue.draft('growth', { platformFeeMonthly: money(120_000) }, {
      createdBy: 'u_paul', changeNote: 'big change',
    });
    expect((await catalogue.impact('growth', 2)).warnings.join(' ')).toMatch(/20%/);
  });

  it('will not publish the same version twice', async () => {
    const catalogue = await service();
    await catalogue.draft('growth', { platformFeeMonthly: money(85_000) }, {
      createdBy: 'u_paul', changeNote: 'uplift',
    });
    await catalogue.publish('growth', 2, 'u_sam');
    await expect(catalogue.publish('growth', 2, 'u_sam')).rejects.toThrow();
  });

  it('lists only self-service plans for a customer, cheapest first', async () => {
    const catalogue = await service();
    const plans = await catalogue.selfServicePlans();
    expect(plans.map((plan) => plan.planCode)).toEqual(['starter', 'growth']);
  });

  it('seeds no activation fee, because charging one is a decision', async () => {
    // Defaulting it to a number nobody chose starts charging customers for
    // something nobody agreed.
    const catalogue = await service();
    expect((await catalogue.current('starter'))?.activationFee.amount).toBe(0);
  });
});

/** A signing key and its JWK, for building real ID tokens in the tests. */
function testKey() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  const kid = randomBytes(8).toString('hex');
  return {
    privateKey,
    jwk: { kid, kty: 'RSA', alg: 'RS256', n: jwk.n, e: jwk.e } satisfies Jwk,
  };
}

function signToken(key: ReturnType<typeof testKey>, claims: Record<string, unknown>, alg = 'RS256'): string {
  const header = Buffer.from(JSON.stringify({ alg, kid: key.jwk.kid, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  if (alg === 'none') return `${header}.${body}.`;
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${body}`);
  signer.end();
  return `${header}.${body}.${signer.sign(key.privateKey).toString('base64url')}`;
}

describe('Apple and Google sign-in', () => {
  const NOW = Math.floor(Date.parse('2026-03-01T09:00:00.000Z') / 1000);
  const google = googleProvider({ clientId: 'client-123', clientSecret: 'secret' });

  const validClaims = (over: Record<string, unknown> = {}) => ({
    iss: GOOGLE_ISSUER, aud: 'client-123', sub: 'google-user-1',
    exp: NOW + 600, iat: NOW, nonce: 'the-nonce',
    email: 'sam@vertex.example', email_verified: true, name: 'Sam Adler',
    ...over,
  });

  it('starts a flow with state, nonce and PKCE', () => {
    const { flow, authorizationUrl } = startFlow({
      provider: google, realm: 'app',
      redirectUri: 'https://app.detent.io/app/auth/google/callback',
      nowMs: Date.parse('2026-03-01T09:00:00.000Z'),
    });
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get('state')).toBe(flow.state);
    expect(url.searchParams.get('nonce')).toBe(flow.nonce);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
  });

  it('asks Apple to post the result back as a form', () => {
    const apple = appleProvider({ clientId: 'io.detent.app', clientSecret: async () => 'jwt' });
    const { authorizationUrl } = startFlow({
      provider: apple, realm: 'app',
      redirectUri: 'https://app.detent.io/app/auth/apple/callback',
      nowMs: Date.now(),
    });
    expect(new URL(authorizationUrl).searchParams.get('response_mode')).toBe('form_post');
    expect(apple.issuer).toBe(APPLE_ISSUER);
  });

  it('makes the PKCE challenge the hash of the verifier, not the verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).not.toBe(verifier);
    expect(challenge.length).toBeGreaterThan(20);
  });

  it('redeems a state only once, so a callback cannot be replayed', async () => {
    const store = new InMemoryOidcFlowStore();
    const { flow } = startFlow({
      provider: google, realm: 'app', redirectUri: 'https://x/cb', nowMs: Date.now(),
    });
    await store.put(flow);
    expect(await store.take(flow.state)).toBeDefined();
    expect(await store.take(flow.state)).toBeUndefined();
  });

  it('keeps only a same-site return path', () => {
    // Otherwise the parameter becomes an open redirect that carries a
    // signed-in user to somebody else's site.
    expect(safeReturnTo('/app/billing')).toBe('/app/billing');
    expect(safeReturnTo('https://evil.example/steal')).toBeUndefined();
    expect(safeReturnTo('//evil.example/steal')).toBeUndefined();
    expect(safeReturnTo('/\\evil.example')).toBeUndefined();
  });

  it('accepts a properly signed token', () => {
    const key = testKey();
    const result = verifyIdToken({
      idToken: signToken(key, validClaims()),
      keys: [key.jwk], issuer: GOOGLE_ISSUER, audience: 'client-123',
      nonce: 'the-nonce', nowSeconds: NOW,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a token signed with a key we do not know', () => {
    const key = testKey();
    const attacker = testKey();
    const token = signToken(attacker, validClaims());
    const result = verifyIdToken({
      idToken: token, keys: [key.jwk], issuer: GOOGLE_ISSUER,
      audience: 'client-123', nonce: 'the-nonce', nowSeconds: NOW,
    });
    expect(result.ok).toBe(false);
  });

  it('refuses alg none, the oldest JWT attack there is', () => {
    const key = testKey();
    const result = verifyIdToken({
      idToken: signToken(key, validClaims(), 'none'),
      keys: [key.jwk], issuer: GOOGLE_ISSUER, audience: 'client-123',
      nonce: 'the-nonce', nowSeconds: NOW,
    });
    expect(result.ok === false && result.reason).toBe('unsupported_algorithm');
  });

  it('refuses a token issued to a different application', () => {
    const key = testKey();
    const result = verifyIdToken({
      idToken: signToken(key, validClaims({ aud: 'someone-elses-client' })),
      keys: [key.jwk], issuer: GOOGLE_ISSUER, audience: 'client-123',
      nonce: 'the-nonce', nowSeconds: NOW,
    });
    expect(result.ok === false && result.reason).toBe('wrong_audience');
  });

  it('refuses a token from the wrong issuer', () => {
    const key = testKey();
    const result = verifyIdToken({
      idToken: signToken(key, validClaims({ iss: APPLE_ISSUER })),
      keys: [key.jwk], issuer: GOOGLE_ISSUER, audience: 'client-123',
      nonce: 'the-nonce', nowSeconds: NOW,
    });
    expect(result.ok === false && result.reason).toBe('wrong_issuer');
  });

  it('refuses an expired token', () => {
    const key = testKey();
    const result = verifyIdToken({
      idToken: signToken(key, validClaims({ exp: NOW - 3_600 })),
      keys: [key.jwk], issuer: GOOGLE_ISSUER, audience: 'client-123',
      nonce: 'the-nonce', nowSeconds: NOW,
    });
    expect(result.ok === false && result.reason).toBe('expired');
  });

  it('refuses a token whose nonce does not match the flow', () => {
    // Without this a token obtained elsewhere for the same client is replayable.
    const key = testKey();
    const result = verifyIdToken({
      idToken: signToken(key, validClaims({ nonce: 'a-different-nonce' })),
      keys: [key.jwk], issuer: GOOGLE_ISSUER, audience: 'client-123',
      nonce: 'the-nonce', nowSeconds: NOW,
    });
    expect(result.ok === false && result.reason).toBe('bad_nonce');
  });

  it('accepts a token inside the clock-skew allowance', () => {
    const key = testKey();
    const result = verifyIdToken({
      idToken: signToken(key, validClaims({ exp: NOW - 30 })),
      keys: [key.jwk], issuer: GOOGLE_ISSUER, audience: 'client-123',
      nonce: 'the-nonce', nowSeconds: NOW, leewaySeconds: 60,
    });
    expect(result.ok).toBe(true);
  });

  it('refuses to link an unverified email address', () => {
    // A provider will assert an address it has not verified. Linking on one is
    // account takeover: register the victim's address somewhere that does not
    // check, sign in here, arrive in their account.
    const result = toIdentity('google', validClaims({ email_verified: false }) as never);
    expect(result.ok === false && result.reason).toBe('email_unverified');
    expect(refusalMessage('email_unverified')).toMatch(/verified/i);
  });

  it('treats an absent verification flag as unverified', () => {
    const claims = validClaims();
    delete (claims as Record<string, unknown>)['email_verified'];
    expect(toIdentity('google', claims as never).ok).toBe(false);
  });

  it('accepts the string "true", which providers do send', () => {
    const result = toIdentity('google', validClaims({ email_verified: 'true' }) as never);
    expect(result.ok).toBe(true);
  });

  it('refuses an identity with no email at all', () => {
    const claims = validClaims();
    delete (claims as Record<string, unknown>)['email'];
    expect(toIdentity('apple', claims as never).ok === false).toBe(true);
  });

  it('keys the identity on the provider subject, not the email', () => {
    // An email can change at the provider; the subject cannot.
    const result = toIdentity('google', validClaims());
    expect(result.ok && result.identity.subject).toBe('google-user-1');
  });

  it('notices an Apple private relay address', () => {
    const result = toIdentity('apple', validClaims({
      iss: APPLE_ISSUER, is_private_email: 'true', email: 'abc@privaterelay.appleid.com',
    }) as never);
    expect(result.ok && result.identity.isPrivateRelay).toBe(true);
  });

  it('builds a name from given and family names when there is no name claim', () => {
    const claims = validClaims({ given_name: 'Sam', family_name: 'Adler' });
    delete (claims as Record<string, unknown>)['name'];
    const result = toIdentity('google', claims as never);
    expect(result.ok && result.identity.name).toBe('Sam Adler');
  });
});

describe('Stripe', () => {
  const stub = (responses: readonly { status: number; body: unknown }[]): HttpClient & {
    calls: { url: string; body?: string; headers: Record<string, string> }[];
  } => {
    const calls: { url: string; body?: string; headers: Record<string, string> }[] = [];
    let index = 0;
    return {
      calls,
      async request(input) {
        calls.push({ url: input.url, body: input.body, headers: { ...input.headers } });
        const next = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return { status: next!.status, body: JSON.stringify(next!.body) };
      },
    };
  };

  const provider = (http: HttpClient) => new StripeProvider({
    // Deliberately not shaped like a real Stripe credential. A fixture using a
    // provider's own key prefix is indistinguishable from a leaked secret to
    // every scanner that will ever read this repository, including the one a
    // hosting platform runs before it will publish, which blocks the deploy.
    // The prefixes are not written here either, for exactly that reason.
    apiKey: 'stripe-api-key-for-tests', webhookSecret: 'stripe-webhook-secret-for-tests', http,
    now: () => Date.parse('2026-03-01T09:00:00.000Z'),
  });

  it('encodes a nested body the way Stripe expects', () => {
    expect(encodeForm({ amount: 100, metadata: { accountId: 'a1' } }))
      .toBe('amount=100&metadata%5BaccountId%5D=a1');
    expect(encodeForm({ line_items: [{ quantity: 1 }] }))
      .toContain('line_items%5B0%5D%5Bquantity%5D=1');
  });

  it('collects a card on Stripe’s own page, never on ours', async () => {
    const http = stub([{ status: 200, body: { id: 'cs_1', url: 'https://checkout.stripe.com/c/1' } }]);
    const session = await provider(http).startSetup({
      accountId: 'a1', returnUrl: 'https://app.detent.io/app/billing',
    });
    expect(session.url).toContain('checkout.stripe.com');
    expect(http.calls[0]?.body).toContain('mode=setup');
  });

  it('takes the activation fee and saves the card in one card entry', async () => {
    // Asking a customer to enter a card twice at sign-up loses some of them.
    const http = stub([{ status: 200, body: { id: 'cs_2', url: 'https://checkout.stripe.com/c/2' } }]);
    await provider(http).startActivation({
      accountId: 'a1', returnUrl: 'https://app.detent.io/app/billing',
      activationFee: money(50_000), description: 'Detent activation',
    });
    const body = decodeURIComponent(http.calls[0]?.body ?? '');
    expect(body).toContain('mode=payment');
    expect(body).toContain('unit_amount]=50000');
    expect(body).toContain('setup_future_usage]=off_session');
  });

  it('sends the idempotency key to Stripe as well as keeping it locally', async () => {
    const http = stub([
      { status: 200, body: { data: [{ id: 'cus_1' }] } },
      { status: 200, body: { id: 'pi_1', status: 'succeeded', amount: 42_000, currency: 'gbp', created: 0 } },
    ]);
    await provider(http).charge({
      accountId: 'a1', amount: money(42_000), paymentMethodRef: 'pm_1' as never,
      description: 'Invoice 42', idempotencyKey: 'key-1', offSession: true,
    });
    expect(http.calls[1]?.headers['idempotency-key']).toBe('key-1');
  });

  it('pins the API version, so a Stripe change is a deliberate upgrade', async () => {
    const http = stub([{ status: 200, body: { id: 'cs_1', url: 'https://x' } }]);
    await provider(http).startSetup({ accountId: 'a1', returnUrl: 'https://x' });
    expect(http.calls[0]?.headers['stripe-version']).toBeTruthy();
  });

  it('keeps only the last four digits of a card', async () => {
    const http = stub([
      { status: 200, body: { data: [{ id: 'cus_1' }] } },
      { status: 200, body: { data: [{
        id: 'pm_1', card: { last4: '4242', brand: 'visa', exp_month: 12, exp_year: 2030 },
        billing_details: { name: 'S Adler' },
      }] } },
    ]);
    const methods = await provider(http).listPaymentMethods('a1');
    expect(methods[0]?.last4).toBe('4242');
    expect(JSON.stringify(methods)).not.toMatch(/\d{13,}/);
  });

  it('surfaces a decline as a failed intent rather than throwing', async () => {
    const http = stub([
      { status: 200, body: { data: [{ id: 'cus_1' }] } },
      { status: 200, body: {
        id: 'pi_2', status: 'requires_payment_method', amount: 1_000, currency: 'gbp', created: 0,
        last_payment_error: { code: 'card_declined', message: 'Your card was declined.' },
      } },
    ]);
    const intent = await provider(http).charge({
      accountId: 'a1', amount: money(1_000), paymentMethodRef: 'pm_1' as never,
      description: 'x', idempotencyKey: 'k', offSession: true,
    });
    expect(intent.status).toBe('requires_payment_method');
    expect(intent.failureCode).toBe('card_declined');
  });

  it('turns a Stripe error into a StripeError with its code', async () => {
    const http = stub([{ status: 400, body: { error: { message: 'No such customer', code: 'resource_missing' } } }]);
    await expect(provider(http).startSetup({ accountId: 'a1', returnUrl: 'https://x' }))
      .rejects.toThrow(/No such customer/);
  });

  it('verifies a webhook signature', async () => {
    const http = stub([{ status: 200, body: {} }]);
    const stripe = provider(http);
    const body = JSON.stringify({
      id: 'evt_1', type: 'payment_intent.succeeded', created: 1_772_355_600,
      data: { object: { id: 'pi_1', metadata: { accountId: 'a1' }, amount: 1_000, status: 'succeeded' } },
    });
    const event = await stripe.verifyWebhook(body, stripe.signWebhook(body));
    expect(event.type).toBe('payment_intent.succeeded');
    expect(event.payload['account_id']).toBe('a1');
  });

  it('rejects a webhook with a wrong signature', async () => {
    const stripe = provider(stub([{ status: 200, body: {} }]));
    // A current timestamp, so the signature check is what fails rather than
    // the cheaper timestamp check in front of it.
    const now = Math.floor(Date.parse('2026-03-01T09:00:00.000Z') / 1000);
    await expect(stripe.verifyWebhook('{}', `t=${now},v1=${'de'.repeat(32)}`))
      .rejects.toThrow(/verification failed/i);
  });

  it('rejects a replayed webhook outside the tolerance window', async () => {
    // Without the timestamp check a captured webhook replays forever, which is
    // how a refund event gets re-applied.
    const stripe = provider(stub([{ status: 200, body: {} }]));
    const body = '{"id":"evt_1","type":"x","created":0,"data":{"object":{}}}';
    const old = Math.floor(Date.parse('2026-03-01T09:00:00.000Z') / 1000) - 3_600;
    await expect(stripe.verifyWebhook(body, stripe.signWebhook(body, old)))
      .rejects.toThrow(/tolerance/i);
  });

  it('rejects a malformed signature header', async () => {
    const stripe = provider(stub([{ status: 200, body: {} }]));
    await expect(stripe.verifyWebhook('{}', 'nonsense')).rejects.toThrow(/malformed/i);
  });
});
