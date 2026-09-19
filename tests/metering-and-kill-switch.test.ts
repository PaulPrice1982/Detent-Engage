import { describe, expect, it } from 'vitest';
import { DEFAULT_UNIT_COSTS, InMemoryUsageStore, MeteringService } from '@detent/awa-policy';
import { FixedClock } from '@detent/awa-core';
import { buildHarness, bearer } from './fixtures/tenant.js';

/**
 * CI gates: denial of wallet (spend cap holds under flood simulation) and the
 * platform and per-tenant kill switches demonstrated in a game day
 * (sections 32.5, 30, 36.2).
 */
const CAPS = {
  monthlyPence: 10_000,
  warnAtFraction: 0.7,
  degradeToTextAtFraction: 0.9,
  maxConcurrentVoice: 3,
  maxConversationsPerMonth: 100,
};

describe('spend caps and denial of wallet', () => {
  it('warns, then degrades to text, then blocks', async () => {
    const metering = new MeteringService(new InMemoryUsageStore(), DEFAULT_UNIT_COSTS, new FixedClock(new Date('2026-09-04T00:00:00Z')));
    expect((await metering.check('t1', CAPS)).state).toBe('OK');

    // 1,200 voice minutes at 6.3p is 7,560p, i.e. 75.6% of the cap.
    await metering.record('t1', 'voice_minute', 1200);
    expect((await metering.check('t1', CAPS)).state).toBe('WARN');

    await metering.record('t1', 'voice_minute', 250);
    expect((await metering.check('t1', CAPS)).state).toBe('DEGRADE_TO_TEXT');

    await metering.record('t1', 'voice_minute', 200);
    const verdict = await metering.check('t1', CAPS);
    expect(verdict.state).toBe('BLOCKED');
    expect(verdict.state === 'BLOCKED' && verdict.reason).toBe('spend_cap');
  });

  it('holds the cap under a simulated bot flood', async () => {
    const metering = new MeteringService(new InMemoryUsageStore(), DEFAULT_UNIT_COSTS, new FixedClock(new Date('2026-09-04T00:00:00Z')));
    let blockedAt: number | undefined;

    for (let i = 1; i <= 10_000; i++) {
      const verdict = await metering.check('t1', CAPS, { voice: true });
      if (verdict.state === 'BLOCKED') { blockedAt = i; break; }
      // Burst pricing, which is the expensive path an attacker would drive.
      await metering.record('t1', 'voice_minute', 1, { burst: true });
    }

    expect(blockedAt).toBeDefined();
    const usage = await metering.usage('t1');
    // The cap holds: spend never runs away past it.
    expect(usage.spendPence).toBeLessThan(CAPS.monthlyPence + DEFAULT_UNIT_COSTS.voiceMinuteBurst);
  });

  it('enforces pooled voice concurrency per tenant', async () => {
    const metering = new MeteringService(new InMemoryUsageStore());
    await metering.openVoiceSession('t1', CAPS);
    await metering.openVoiceSession('t1', CAPS);
    await metering.openVoiceSession('t1', CAPS);
    await expect(metering.openVoiceSession('t1', CAPS)).rejects.toMatchObject({ kind: 'QUOTA_EXCEEDED' });

    await metering.closeVoiceSession('t1');
    await expect(metering.openVoiceSession('t1', CAPS)).resolves.toBeUndefined();
  });

  it('reports blended cost of goods per conversation against the £0.60 target', async () => {
    const metering = new MeteringService(new InMemoryUsageStore());
    await metering.record('t1', 'conversation', 100);
    await metering.record('t1', 'voice_minute', 105); // 30% voice mix at 3.5 min
    await metering.record('t1', 'text_message', 1050);
    await metering.record('t1', 'llm_token', 400_000);

    const perConversation = await metering.costPerConversationPence('t1');
    expect(perConversation).toBeDefined();
    console.log(`blended cost of goods: ${perConversation!.toFixed(2)}p per conversation`);
    expect(perConversation!).toBeLessThanOrEqual(60);
  });
});

describe('kill switches', () => {
  it('per-tenant booking-link mode answers honestly and calls no model', async () => {
    const harness = await buildHarness({ script: [{ match: /.*/, output: { text: 'I should not be reached.' } }] });
    harness.platform.tenants.update(harness.config.tenantId, {
      killSwitch: 'BOOKING_LINK_ONLY',
      bookingLinkUrl: 'https://acme.co.uk/book',
    }, 'platform');

    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    const turn = await harness.platform.orchestrator.run({
      session, config: harness.platform.effectiveConfig(session.tenantId), visitorInput: 'hello',
    });

    expect(turn.text).toContain('acme.co.uk/book');
    expect(turn.text).not.toContain('I should not be reached');
    const audit = await harness.platform.audit.export(session.tenantId);
    expect(audit.entries.some((e) => e.type === 'kill_switch_engaged')).toBe(true);
  });

  it('platform switch overrides a tenant that has its own switch off', async () => {
    const harness = await buildHarness();
    expect(harness.platform.effectiveConfig(harness.config.tenantId).killSwitch).toBe('OFF');

    await harness.api.handle({
      method: 'POST', path: '/v1/admin/kill-switch',
      headers: bearer(harness.platformKey), body: { mode: 'BOOKING_LINK_ONLY' },
    });

    expect(harness.platform.effectiveConfig(harness.config.tenantId).killSwitch).toBe('BOOKING_LINK_ONLY');
  });

  it('does not let a tenant admin operate the platform switch', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({
      method: 'POST', path: '/v1/admin/kill-switch',
      headers: bearer(harness.adminKey), body: { mode: 'OFF' },
    });
    expect(response.status).toBe(403);
  });
});
