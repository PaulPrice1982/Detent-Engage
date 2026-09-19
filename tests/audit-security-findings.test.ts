import { describe, expect, it } from 'vitest';
import { ApiKeyService, RequestRateLimiter, assertOriginAllowed, originMatches } from '@detent/awa-server';
import { FixedClock, checkFieldAuthority } from '@detent/awa-core';
import { buildHarness, bearer } from './fixtures/tenant.js';

/**
 * CI gate: the security findings of the September 2026 independent audit.
 * Pass threshold: every one of these refuses. Each `it` names the finding it
 * closes, so a regression is traceable to the report that asked for it.
 */

describe('SEC-1 · the public widget key cannot confirm a billable outcome', () => {
  it('refuses an outcome confirmation presented with a widget key', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({
      method: 'POST',
      path: '/v1/outcomes/corr_whatever/confirm',
      headers: bearer(harness.widgetKey),
      body: { succeeded: true },
    });

    // 403, not 404: the route exists and the caller is not permitted to use it.
    expect(response.status).toBe(403);
    expect((response.body as { error: string }).error).toBe('POLICY_DENIED');
  });

  it('accepts one from a tenant admin', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({
      method: 'POST',
      path: '/v1/outcomes/corr_unknown/confirm',
      headers: bearer(harness.adminKey),
      body: { succeeded: true },
    });
    // The correlation id does not exist, so this is a 404 from the outcome
    // service rather than an authorisation refusal, which is the point.
    expect(response.status).not.toBe(403);
  });
});

describe('SEC-2 · abuse control on the visitor API', () => {
  it('rate limits messages per session', async () => {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const limiter = new RequestRateLimiter(
      { ...new RequestRateLimiter().limits, perSession: { limit: 3, windowMs: 60_000 } },
      clock,
    );
    const input = { keyId: 'ak_1', ip: '198.51.100.7', sessionId: 'sess_1' };
    expect((await limiter.checkMessage(input)).allowed).toBe(true);
    expect((await limiter.checkMessage(input)).allowed).toBe(true);
    expect((await limiter.checkMessage(input)).allowed).toBe(true);

    const refused = await limiter.checkMessage(input);
    expect(refused.allowed).toBe(false);
    expect(refused.scope).toBe('session');
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('caps the total number of messages in one session, whatever the rate', async () => {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const limiter = new RequestRateLimiter(
      { ...new RequestRateLimiter().limits, maxMessagesPerSession: 2 },
      clock,
    );
    const input = { keyId: 'ak_1', ip: '198.51.100.7', sessionId: 'sess_2' };
    expect((await limiter.checkMessage(input)).allowed).toBe(true);
    expect((await limiter.checkMessage(input)).allowed).toBe(true);
    expect((await limiter.checkMessage(input)).scope).toBe('session_total');
  });

  it('checks the spend cap before the model is called, not after', async () => {
    const harness = await buildHarness();
    const tenantId = harness.config.tenantId;
    await harness.platform.tenants.update(tenantId, {
      spendCaps: {
        monthlyPence: 10, warnAtFraction: 0.5, degradeToTextAtFraction: 0.8,
        maxConcurrentVoice: 1, maxConversationsPerMonth: 1_000,
      },
    }, 'platform_admin');
    // Spend the cap.
    await harness.platform.metering.record(tenantId, 'text_message', 200);

    const before = await harness.platform.metering.usage(tenantId);
    const session = await harness.platform.openSession(tenantId, 'UK');
    const result = await harness.platform.orchestrator.run({
      session,
      config: harness.platform.effectiveConfig(tenantId),
      visitorInput: 'what do you charge?',
    });
    const after = await harness.platform.metering.usage(tenantId);

    expect(result.degraded).toBe('spend_cap');
    // No tokens were spent on a tenant already past their cap: that is the
    // whole finding. The only movement is the conversation the session opened.
    expect(after.llmTokens).toBe(before.llmTokens);
    expect(result.nextAction.kind).not.toBe('none');
  });

  it('refuses a session on a tenant past their cap, with a route on', async () => {
    const harness = await buildHarness();
    const tenantId = harness.config.tenantId;
    await harness.platform.tenants.update(tenantId, {
      spendCaps: {
        monthlyPence: 1, warnAtFraction: 0.5, degradeToTextAtFraction: 0.8,
        maxConcurrentVoice: 1, maxConversationsPerMonth: 1_000,
      },
    }, 'platform_admin');
    await harness.platform.metering.record(tenantId, 'text_message', 100);

    const response = await harness.api.handle({
      method: 'POST', path: '/v1/sessions', headers: bearer(harness.widgetKey), body: {},
    });
    expect(response.status).toBe(402);
  });

  it('refuses a message longer than the input cap before it reaches the tokeniser', async () => {
    const harness = await buildHarness();
    const opened = await harness.api.handle({
      method: 'POST', path: '/v1/sessions', headers: bearer(harness.widgetKey), body: {},
    });
    const sessionId = (opened.body as { session_id: string }).session_id;

    const response = await harness.api.handle({
      method: 'POST', path: `/v1/sessions/${sessionId}/messages`,
      headers: bearer(harness.widgetKey),
      body: { text: 'x'.repeat(50_000) },
    });
    expect(response.status).toBe(400);
  });
});

describe('SEC-5 · widget keys are bound to registered origins', () => {
  it('refuses a widget key presented from an unregistered origin', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({
      method: 'POST', path: '/v1/sessions',
      headers: bearer(harness.widgetKey, 'https://competitor.example'),
      body: {},
    });
    expect(response.status).toBe(403);
  });

  it('refuses a widget key presented with no origin at all', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({
      method: 'POST', path: '/v1/sessions',
      headers: { authorization: `Bearer ${harness.widgetKey}` },
      body: {},
    });
    expect(response.status).toBe(403);
  });

  it('fails closed for a tenant with no registered origins', () => {
    const principal = { tenantId: 't_x', audience: 'widget' as const, keyId: 'ak_1', keyOrigins: [] };
    expect(() => assertOriginAllowed(principal, 'https://anything.example', [])).toThrowError(/registered origins/);
  });

  it('matches a single-label subdomain wildcard and nothing wider', () => {
    expect(originMatches('https://shop.example.com', ['https://*.example.com'])).toBe(true);
    expect(originMatches('https://example.com', ['https://*.example.com'])).toBe(false);
    // The suffix trick a naive `endsWith` would fall for.
    expect(originMatches('https://example.com.attacker.net', ['https://*.example.com'])).toBe(false);
    expect(originMatches('https://a.b.example.com', ['https://*.example.com'])).toBe(false);
  });

  it('leaves server-to-server admin calls alone', () => {
    const principal = { tenantId: 't_x', audience: 'tenant_admin' as const, keyId: 'ak_1', keyOrigins: [] };
    expect(() => assertOriginAllowed(principal, undefined, [])).not.toThrow();
  });
});

describe('SEC-6 · a tenant admin cannot widen their own controls', () => {
  it('refuses a tenant admin raising their own spend cap', async () => {
    const harness = await buildHarness();
    await expect(harness.platform.tenants.update(harness.config.tenantId, {
      spendCaps: {
        monthlyPence: 10_000_000, warnAtFraction: 0.9, degradeToTextAtFraction: 0.95,
        maxConcurrentVoice: 99, maxConversationsPerMonth: 10_000_000,
      },
    }, 'tenant_admin')).rejects.toThrowError(/may not change/);
  });

  it('refuses a tenant admin widening the outbound allowlist', async () => {
    const harness = await buildHarness();
    // The allowlist is exactly what the output validator uses to block link and
    // image-beacon exfiltration, so a tenant adding a host to it is the attack.
    await expect(harness.platform.tenants.update(harness.config.tenantId, {
      outboundAllowlist: ['exfiltration.example'],
    }, 'tenant_admin')).rejects.toThrowError(/may not change/);
  });

  it('allows a platform admin to set the same fields', async () => {
    const harness = await buildHarness();
    const updated = await harness.platform.tenants.update(harness.config.tenantId, {
      outboundAllowlist: ['partner.example'],
    }, 'platform_admin');
    expect(updated.outboundAllowlist).toEqual(['partner.example']);
  });

  it('refuses a field that is in no authority table at all', () => {
    const verdict = checkFieldAuthority({ someNewField: true }, 'platform_admin');
    expect(verdict.allowed).toBe(false);
    expect(verdict.unknown).toContain('someNewField');
  });

  it('still lets a tenant edit their own copy', async () => {
    const harness = await buildHarness();
    const updated = await harness.platform.tenants.update(harness.config.tenantId, {
      serviceCatalogue: ['contract-review'],
    }, 'tenant_admin');
    expect(updated.serviceCatalogue).toEqual(['contract-review']);
  });
});

describe('SEC-8 · API key lifecycle', () => {
  it('does not put the tenant id in the key material', () => {
    const keys = new ApiKeyService();
    const { key } = keys.issue('t_secret_internal_name', 'widget');
    expect(key).not.toContain('t_secret_internal_name');
    expect(key.startsWith('awa_pub_')).toBe(true);
  });

  it('refuses an expired key', () => {
    let now = new Date('2026-09-04T09:00:00.000Z');
    const keys = new ApiKeyService(() => now);
    const { key } = keys.issue('t_a', 'tenant_admin', { ttlMs: 1_000 });
    expect(() => keys.authenticate(key)).not.toThrow();
    now = new Date('2026-09-04T09:00:02.000Z');
    expect(() => keys.authenticate(key)).toThrowError(/expired/);
  });

  it('records when a key was last used', () => {
    const keys = new ApiKeyService(() => new Date('2026-09-04T09:00:00.000Z'));
    const { key, record } = keys.issue('t_a', 'tenant_admin');
    expect(keys.list('t_a').find((k) => k.id === record.id)?.lastUsedAt).toBeUndefined();
    keys.authenticate(key);
    expect(keys.list('t_a').find((k) => k.id === record.id)?.lastUsedAt).toBe('2026-09-04T09:00:00.000Z');
  });

  it('rotates with an overlap window so a tenant can redeploy without an outage', () => {
    let now = new Date('2026-09-04T09:00:00.000Z');
    const keys = new ApiKeyService(() => now);
    const original = keys.issue('t_a', 'widget', { origins: ['https://a.example'] });
    const successor = keys.rotate(original.record.id, 24 * 60 * 60 * 1000);

    // Both work during the overlap.
    expect(() => keys.authenticate(original.key)).not.toThrow();
    expect(() => keys.authenticate(successor.key)).not.toThrow();
    // The successor inherits the origin binding.
    expect(successor.record.origins).toEqual(['https://a.example']);

    now = new Date('2026-09-06T09:00:00.000Z');
    expect(() => keys.authenticate(original.key)).toThrowError(/expired/);
    expect(() => keys.authenticate(successor.key)).not.toThrow();
  });

  it('revokes by id without a linear scan through the key material', () => {
    const keys = new ApiKeyService();
    const { key, record } = keys.issue('t_a', 'tenant_admin');
    keys.revoke(record.id);
    expect(() => keys.authenticate(key)).toThrowError(/not recognised/);
    expect(keys.list('t_a')[0]?.active).toBe(false);
  });

  it('never returns a key or a digest from the listing', () => {
    const keys = new ApiKeyService();
    const { key } = keys.issue('t_a', 'widget');
    const listed = JSON.stringify(keys.list('t_a'));
    expect(listed).not.toContain(key);
    expect(listed).not.toContain('digest');
  });
});

describe('SEC-10 · observability on the failure path', () => {
  it('returns a correlation id on an internal error and logs it', async () => {
    const harness = await buildHarness();
    const lines: string[] = [];
    // A route that throws something that is not an AwaError.
    const platform = harness.platform as unknown as { outcomes: { confirm: () => Promise<never> } };
    platform.outcomes.confirm = async () => { throw new TypeError('unexpected'); };

    const { Api } = await import('@detent/awa-server');
    const { JsonLogger } = await import('@detent/awa-core');
    const api = new Api(harness.platform, {
      keys: harness.keys,
      logger: new JsonLogger({ sink: (line) => lines.push(line) }),
    });

    const response = await api.handle({
      method: 'POST', path: '/v1/outcomes/corr_x/confirm',
      headers: bearer(harness.adminKey), body: {},
    });

    expect(response.status).toBe(500);
    const correlationId = (response.body as { correlation_id: string }).correlation_id;
    expect(correlationId).toMatch(/^req_/);
    // The id in the response is the id in the log, which is the whole point of
    // having one: a visitor's screenshot finds the log line.
    expect(lines.some((line) => line.includes(correlationId))).toBe(true);
  });

  it('does not disclose the platform kill switch to an unauthenticated caller', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({ method: 'GET', path: '/health', headers: {} });
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('killSwitch');
    expect(JSON.stringify(response.body)).not.toContain('kill_switch');
  });
});
