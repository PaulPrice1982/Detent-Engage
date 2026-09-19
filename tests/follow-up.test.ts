import { describe, expect, it } from 'vitest';
import { FixedClock, type TenantConfig } from '@detent/awa-core';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import {
  FollowUpEngine, FrequencyLedger, InMemoryMessageSender, InMemorySuppressionStore,
  PLATFORM_MAX_FOLLOWUPS_PER_CONVERSATION, SuppressionList,
  effectiveCap, generateLiaTemplate, isCorporateSubscriber, permittedLane, resolveJurisdiction,
} from '@detent/awa-followup';
import { buildHarness } from './fixtures/tenant.js';

/**
 * CI gates for section 42 / FR-054 to FR-059.
 *
 * The governing principle, and the reason this is a rules engine rather than a
 * feature: **fail closed.** An unresolvable jurisdiction produces
 * transactional-only, never a guess in the platform's commercial favour.
 */
async function config(over: Partial<TenantConfig['followUp']> = {}, jurisdiction: TenantConfig['homeJurisdiction'] = 'UK'): Promise<TenantConfig> {
  const { config: base } = await buildHarness();
  return {
    ...base,
    homeJurisdiction: jurisdiction,
    followUp: {
      enabled: true, liaComplete: true, maxFollowUpsPerConversation: 1,
      senderName: 'Acme Revenue Ltd', senderAddress: 'hello@acme.co.uk',
      physicalAddress: '1 Example Street, London EC1A 1AA',
      ...over,
    },
  };
}

function engine(clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'))) {
  const audit = new AuditLog(new InMemoryAuditStore(), clock);
  const sender = new InMemoryMessageSender();
  const suppression = new SuppressionList(new InMemorySuppressionStore(), 'salt', clock);
  const frequency = new FrequencyLedger('salt', clock);
  return {
    engine: new FollowUpEngine(sender, suppression, frequency, audit, 'https://platform.example', clock),
    sender, suppression, audit, clock,
  };
}

describe('jurisdiction resolution', () => {
  it('resolves from an explicit country code', () => {
    expect(resolveJurisdiction({ email: 'a@x.com', countryCode: 'GB', hasMarketingConsentEvent: false })).toBe('UK');
    expect(resolveJurisdiction({ email: 'a@x.com', countryCode: 'CA', hasMarketingConsentEvent: false })).toBe('CA');
  });

  it('resolves from a country-code top-level domain', () => {
    expect(resolveJurisdiction({ email: 'a@acme.co.uk', hasMarketingConsentEvent: false })).toBe('UK');
    expect(resolveJurisdiction({ email: 'a@acme.ie', hasMarketingConsentEvent: false })).toBe('EU');
  });

  it('refuses to resolve from a public mailbox, because it says nothing about location', () => {
    expect(resolveJurisdiction({ email: 'a@gmail.com', hasMarketingConsentEvent: false })).toBeUndefined();
  });

  it('refuses to resolve a .com, rather than assuming US', () => {
    expect(resolveJurisdiction({ email: 'a@acme.com', hasMarketingConsentEvent: false })).toBeUndefined();
  });
});

describe('the lane decision (FR-055)', () => {
  it('fails closed to transactional-only on an unresolvable jurisdiction', async () => {
    const decision = permittedLane({ email: 'buyer@acme.com', hasMarketingConsentEvent: false }, await config());
    expect(decision.lane).toBe('TRANSACTIONAL_ONLY');
    expect(decision.failedClosed).toBe(true);
  });

  it('permits consented nurture wherever a stored consent event exists', async () => {
    const decision = permittedLane({ email: 'buyer@acme.ca', countryCode: 'CA', hasMarketingConsentEvent: true }, await config());
    expect(decision.lane).toBe('CONSENTED_NURTURE');
  });

  it('never permits lane two for a Canadian recipient, per CASL', async () => {
    const decision = permittedLane({ email: 'info@acme.ca', countryCode: 'CA', hasMarketingConsentEvent: false }, await config());
    expect(decision.lane).toBe('TRANSACTIONAL_ONLY');
    expect(decision.reason).toMatch(/CASL/);
  });

  it('never permits lane two for an EU recipient', async () => {
    const decision = permittedLane({ email: 'info@acme.ie', hasMarketingConsentEvent: false }, await config());
    expect(decision.lane).toBe('TRANSACTIONAL_ONLY');
  });

  it('permits lane two for a UK corporate subscriber once the LIA is complete', async () => {
    const decision = permittedLane({ email: 'enquiries@acme.co.uk', hasMarketingConsentEvent: false }, await config());
    expect(decision.lane).toBe('LEGITIMATE_INTEREST_FOLLOWUP');
  });

  it('does not treat a named individual at a corporate domain as a corporate subscriber', async () => {
    // A named individual may be an individual subscriber. Do not assume.
    expect(isCorporateSubscriber({ email: 'alex.warner@acme.co.uk', hasMarketingConsentEvent: false })).toBe(false);
    const decision = permittedLane({ email: 'alex.warner@acme.co.uk', hasMarketingConsentEvent: false }, await config());
    expect(decision.lane).toBe('TRANSACTIONAL_ONLY');
  });

  it('applies the stricter of the recipient and tenant jurisdictions', async () => {
    // A UK-eligible recipient, but an EU tenant: the stricter rule wins.
    const decision = permittedLane({ email: 'enquiries@acme.co.uk', hasMarketingConsentEvent: false }, await config({}, 'EU'));
    expect(decision.lane).toBe('TRANSACTIONAL_ONLY');
    expect(decision.jurisdictionApplied).toBe('EU');
  });
});

describe('the LIA gate (FR-056)', () => {
  it('disables lane two until the assessment is marked complete', async () => {
    const { engine: followUp } = engine();
    const verdict = await followUp.send({
      config: await config({ liaComplete: false }),
      conversationId: 'c1', correlationId: 'corr_1',
      recipient: { email: 'enquiries@acme.co.uk', hasMarketingConsentEvent: false },
      conversationSummary: 'Asked about contract review.',
      subject: 'Following up', body: 'You asked about contract review.',
    });
    expect(verdict.sent).toBe(false);
    // The gate fires in permittedLane, and the engine holds a second,
    // independent check for the same thing.
    expect(verdict.sent === false && verdict.reason).toMatch(/legitimate interests assessment is not/);
  });

  it('generates an LIA template the controller completes, not the platform', async () => {
    const template = generateLiaTemplate(await config());
    expect(template).toContain('Controller to complete');
    expect(template).toContain('not legal advice');
    expect(template).toMatch(/Frequency is hard-capped at 1 message per conversation/);
  });
});

describe('suppression and frequency caps (FR-057, FR-058)', () => {
  it('honours an opt-out immediately, permanently and across every tenant', async () => {
    const { engine: followUp } = engine();
    const tenantConfig = await config();
    await followUp.optOut('enquiries@acme.co.uk', tenantConfig.tenantId, 'corr_opt');

    const verdict = await followUp.send({
      config: { ...tenantConfig, tenantId: 't_someone_else' },
      conversationId: 'c1', correlationId: 'corr_2',
      recipient: { email: 'enquiries@acme.co.uk', hasMarketingConsentEvent: true },
      conversationSummary: 's', subject: 'Hello', body: 'Body',
    });
    expect(verdict.sent).toBe(false);
    expect(verdict.sent === false && verdict.reason).toMatch(/global suppression list/);
  });

  it('suppresses even a transactional message for someone who opted out', async () => {
    const { engine: followUp } = engine();
    const tenantConfig = await config();
    await followUp.optOut('alex@acme.co.uk', tenantConfig.tenantId, 'corr_opt');
    const verdict = await followUp.send({
      config: tenantConfig, conversationId: 'c1', correlationId: 'corr_3',
      recipient: { email: 'alex@acme.co.uk', hasMarketingConsentEvent: false },
      conversationSummary: 's', subject: 'Your meeting', body: 'Confirmed', transactional: true,
    });
    expect(verdict.sent).toBe(false);
  });

  it('caps at one follow-up per conversation and cannot be raised by a tenant', async () => {
    expect(effectiveCap(50)).toBe(PLATFORM_MAX_FOLLOWUPS_PER_CONVERSATION);

    const { engine: followUp } = engine();
    const tenantConfig = await config({ maxFollowUpsPerConversation: 50 });
    const request = {
      config: tenantConfig, conversationId: 'c1', correlationId: 'corr_4',
      recipient: { email: 'enquiries@acme.co.uk', hasMarketingConsentEvent: false },
      conversationSummary: 's', subject: 'Following up', body: 'You asked about contract review.',
    };
    expect((await followUp.send(request)).sent).toBe(true);
    const second = await followUp.send(request);
    expect(second.sent).toBe(false);
    expect(second.sent === false && second.reason).toMatch(/frequency cap of 1/);
  });

  it('caps a recipient at three messages in thirty days across all tenants', async () => {
    const { engine: followUp } = engine();
    const tenantConfig = await config();
    for (let i = 0; i < 3; i++) {
      const verdict = await followUp.send({
        config: { ...tenantConfig, tenantId: `t_${i}` },
        conversationId: `c${i}`, correlationId: `corr_${i}`,
        recipient: { email: 'enquiries@acme.co.uk', hasMarketingConsentEvent: false },
        conversationSummary: 's', subject: 'Following up', body: 'Body',
      });
      expect(verdict.sent).toBe(true);
    }
    const fourth = await followUp.send({
      config: { ...tenantConfig, tenantId: 't_4' },
      conversationId: 'c4', correlationId: 'corr_4',
      recipient: { email: 'enquiries@acme.co.uk', hasMarketingConsentEvent: false },
      conversationSummary: 's', subject: 'Following up', body: 'Body',
    });
    expect(fourth.sent).toBe(false);
    expect(fourth.sent === false && fourth.reason).toMatch(/per recipient per 30 days/);
  });

  it('includes a prominent opt-out and sender identity in every non-transactional message', async () => {
    const { engine: followUp, sender } = engine();
    await followUp.send({
      config: await config(), conversationId: 'c1', correlationId: 'corr_5',
      recipient: { email: 'enquiries@acme.co.uk', hasMarketingConsentEvent: false },
      conversationSummary: 's', subject: 'Following up', body: 'You asked about contract review.',
    });
    const message = sender.sent[0]!;
    expect(message.optOutUrl).toBeDefined();
    expect(message.body).toContain('1 Example Street');
    expect(message.body).toContain('immediately and permanently');
    expect(message.legalBasis).toContain('legitimate interest');
  });

  it('refuses a non-transactional message when sender identity is unconfigured', async () => {
    const { engine: followUp } = engine();
    const verdict = await followUp.send({
      config: await config({ physicalAddress: '' }),
      conversationId: 'c1', correlationId: 'corr_6',
      recipient: { email: 'enquiries@acme.co.uk', hasMarketingConsentEvent: false },
      conversationSummary: 's', subject: 'Following up', body: 'Body',
    });
    expect(verdict.sent).toBe(false);
    expect(verdict.sent === false && verdict.reason).toMatch(/sender identity/);
  });

  it('sends a transactional message without an opt-out link, and logs its basis', async () => {
    const { engine: followUp, sender } = engine();
    const verdict = await followUp.send({
      config: await config({ enabled: false }),
      conversationId: 'c1', correlationId: 'corr_7',
      recipient: { email: 'alex@acme.co.uk', hasMarketingConsentEvent: false },
      conversationSummary: 's', subject: 'Your meeting is confirmed', body: 'Details', transactional: true,
    });
    expect(verdict.sent).toBe(true);
    expect(sender.sent[0]!.optOutUrl).toBeUndefined();
    expect(sender.sent[0]!.lane).toBe('TRANSACTIONAL_ONLY');
  });

  it('logs every send and every refusal with its lane, basis and jurisdiction', async () => {
    const { engine: followUp, audit } = engine();
    const tenantConfig = await config();
    await followUp.send({
      config: tenantConfig, conversationId: 'c1', correlationId: 'corr_8',
      recipient: { email: 'enquiries@acme.co.uk', hasMarketingConsentEvent: false },
      conversationSummary: 's', subject: 'Following up', body: 'Body',
    });
    await followUp.send({
      config: tenantConfig, conversationId: 'c2', correlationId: 'corr_9',
      recipient: { email: 'buyer@acme.com', hasMarketingConsentEvent: false },
      conversationSummary: 's', subject: 'Following up', body: 'Body',
    });

    const exported = await audit.export(tenantConfig.tenantId);
    const sent = exported.entries.find((e) => (e.payload as Record<string, unknown>)?.['change'] === 'follow_up_sent');
    const refused = exported.entries.find((e) => (e.payload as Record<string, unknown>)?.['change'] === 'follow_up_refused');
    expect((sent!.payload as Record<string, unknown>)['lane']).toBe('LEGITIMATE_INTEREST_FOLLOWUP');
    expect((refused!.payload as Record<string, unknown>)['failedClosed']).toBe(true);
  });
});
