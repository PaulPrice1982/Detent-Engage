import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { FixedClock, ImpersonationBoundaryError, assertMarked, markSyntheticMedia, type TenantConfig } from '@detent/awa-core';
import { EngagementRulesEngine, SignalStore, VisitorSignalService } from '@detent/awa-signals';
import { EnrichmentOrchestrator, AccountMatcher } from '@detent/awa-signals';
import { SandboxConnector } from '@detent/awa-connectors';
import { buildHarness } from './fixtures/tenant.js';
import { StubCompanyResolver, StubEnrichmentVendor } from './fixtures/extension.js';

/**
 * CI gates for section 43 (lawful subset) / FR-060 to FR-063, and FR-068.
 *
 * The invariant from section 50: **zero person-level identification without
 * consent.** Risk 16 is that proactive engagement drifts from company-level to
 * person-level under commercial pressure, and the mitigation is that the gate
 * is in code rather than in policy.
 */
const COMPANY = { companyName: 'Northwind Ltd', domain: 'northwind.co.uk', confidence: 0.82, source: 'reverse_ip' as const };

async function signalsFor(options: { withResolver?: boolean } = {}) {
  const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
  const audit = new AuditLog(new InMemoryAuditStore(), clock);
  const harness = await buildHarness();
  const store = new SignalStore(900, clock);
  const resolver = options.withResolver === false ? undefined : new StubCompanyResolver({ '203.0.113.9': COMPANY });
  const service = new VisitorSignalService(store, harness.platform.consent, audit, resolver);
  return { harness, service, store, audit, clock };
}

describe('identity level is gated on consent, in code', () => {
  it('permits company level only, in a non-consented session', async () => {
    const { harness, service } = await signalsFor();
    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    const level = await service.permittedIdentityLevel({
      tenantId: session.tenantId, sessionId: session.id,
      subjectRef: session.subjectRef, correlationId: session.correlationId, ip: '203.0.113.9',
    });
    expect(level).toBe('COMPANY');
  });

  it('permits person level only once consent is stored', async () => {
    const { harness, service } = await signalsFor();
    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    await harness.platform.consent.record({
      tenantId: session.tenantId, subjectRef: session.subjectRef, purpose: 'IDENTITY_RESOLUTION',
      choice: 'GRANTED', wordingShown: 'w', source: 'HOST_CMP', jurisdiction: 'UK', correlationId: session.correlationId,
    });
    const level = await service.permittedIdentityLevel({
      tenantId: session.tenantId, sessionId: session.id,
      subjectRef: session.subjectRef, correlationId: session.correlationId,
    });
    expect(level).toBe('PERSON');
  });

  it('permits nothing when no lawful resolver is available', async () => {
    const { harness, service } = await signalsFor({ withResolver: false });
    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    expect(await service.permittedIdentityLevel({
      tenantId: session.tenantId, sessionId: session.id,
      subjectRef: session.subjectRef, correlationId: session.correlationId,
    })).toBe('NONE');
  });

  it('refuses person-level identification without consent, and logs the refusal', async () => {
    const { harness, service, audit } = await signalsFor();
    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    const context = {
      tenantId: session.tenantId, sessionId: session.id,
      subjectRef: session.subjectRef, correlationId: session.correlationId,
    };
    await expect(service.refusePersonLevel(context, 'engagement_rules'))
      .rejects.toMatchObject({ kind: 'CONSENT_REQUIRED' });

    const exported = await audit.export(session.tenantId);
    expect(exported.entries.some((e) => e.type === 'resolution_blocked_no_consent')).toBe(true);
  });

  it('does not record behavioural signals outside a consented session', async () => {
    const { harness, service, store } = await signalsFor();
    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    const context = {
      tenantId: session.tenantId, sessionId: session.id,
      subjectRef: session.subjectRef, correlationId: session.correlationId,
    };
    const recorded = await service.recordSignal(context, { pagePath: '/pricing', dwellSeconds: 40, at: '2026-09-04T09:00:00.000Z' });
    expect(recorded).toBe(false);
    expect(store.forSession(session.tenantId, session.id)).toHaveLength(0);
  });

  it('never returns a person from a company resolution', async () => {
    const { harness, service } = await signalsFor();
    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    const resolution = await service.resolveCompany({
      tenantId: session.tenantId, sessionId: session.id,
      subjectRef: session.subjectRef, correlationId: session.correlationId, ip: '203.0.113.9',
    });
    // The return type has no person-shaped field. That is a cheaper guarantee
    // than a rule everyone has to remember.
    expect(resolution).toEqual(COMPANY);
    expect(JSON.stringify(resolution)).not.toMatch(/name.*@|email|person/i);
  });

  it('never records the visitor IP in the audit log', async () => {
    const { harness, service, audit } = await signalsFor();
    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    await service.resolveCompany({
      tenantId: session.tenantId, sessionId: session.id,
      subjectRef: session.subjectRef, correlationId: session.correlationId, ip: '203.0.113.9',
    });
    const exported = await audit.export(session.tenantId);
    expect(JSON.stringify(exported.entries)).not.toContain('203.0.113.9');
  });
});

describe('the engagement rules engine (FR-061)', () => {
  const engagementConfig = (over: Partial<TenantConfig['engagement']> = {}) => ({
    enabled: true, companyLevelInNonConsentedSessions: true,
    minimumDwellSeconds: 30, minimumPagesViewed: 2,
    respectInSessionDismissal: true, enrichmentEnabled: false, enrichmentMonthlyCapPence: 10_000,
    ...over,
  });

  async function evaluate(over: Partial<Parameters<EngagementRulesEngine['evaluate']>[0]> = {}, engagement = engagementConfig()) {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const audit = new AuditLog(new InMemoryAuditStore(), clock);
    const { config } = await buildHarness();
    const engine = new EngagementRulesEngine(audit);
    return {
      engine,
      decision: await engine.evaluate({
        config: { ...config, engagement },
        sessionId: 'sess_1', correlationId: 'corr_1',
        identityLevel: 'COMPANY',
        signals: [
          { sessionId: 'sess_1', tenantId: config.tenantId, pagePath: '/pricing', dwellSeconds: 25, at: 'now' },
          { sessionId: 'sess_1', tenantId: config.tenantId, pagePath: '/services', dwellSeconds: 20, at: 'now' },
        ],
        dismissedThisSession: false,
        visitorAlreadyEngaged: false,
        ...over,
      }),
    };
  }

  it('fires when dwell and page thresholds are met', async () => {
    const { decision } = await evaluate();
    expect(decision.fire).toBe(true);
    expect(decision.fire && decision.identityLevel).toBe('COMPANY');
  });

  it('never re-engages a visitor who dismissed in this session', async () => {
    const { decision } = await evaluate({ dismissedThisSession: true });
    expect(decision.fire).toBe(false);
    expect(decision.reason).toMatch(/dismissed/);
  });

  it('does not interrupt a visitor who already opened the assistant', async () => {
    const { decision } = await evaluate({ visitorAlreadyEngaged: true });
    expect(decision.fire).toBe(false);
  });

  it('fires at most once per session', async () => {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const audit = new AuditLog(new InMemoryAuditStore(), clock);
    const { config } = await buildHarness();
    const engine = new EngagementRulesEngine(audit);
    const context = {
      config: { ...config, engagement: engagementConfig() },
      sessionId: 'sess_2', correlationId: 'corr_2', identityLevel: 'COMPANY' as const,
      signals: [
        { sessionId: 'sess_2', tenantId: config.tenantId, pagePath: '/a', dwellSeconds: 30, at: 'now' },
        { sessionId: 'sess_2', tenantId: config.tenantId, pagePath: '/b', dwellSeconds: 30, at: 'now' },
      ],
      dismissedThisSession: false, visitorAlreadyEngaged: false,
    };
    expect((await engine.evaluate(context)).fire).toBe(true);
    expect((await engine.evaluate(context)).fire).toBe(false);
  });

  it('respects the dwell and page thresholds', async () => {
    const { decision } = await evaluate({
      signals: [{ sessionId: 'sess_1', tenantId: 't', pagePath: '/x', dwellSeconds: 5, at: 'now' }],
    });
    expect(decision.fire).toBe(false);
    expect(decision.reason).toMatch(/below the 30s threshold/);
  });

  it('does not fire at all when no lawful identity level is available', async () => {
    const { decision } = await evaluate({ identityLevel: 'NONE' });
    expect(decision.fire).toBe(false);
  });
});

describe('enrichment economics (FR-063)', () => {
  async function orchestrator() {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const harness = await buildHarness();
    const primary = new StubEnrichmentVendor('primary', {});
    const fallback = new StubEnrichmentVendor('fallback', {
      'northwind.co.uk': { domain: 'northwind.co.uk', companyName: 'Northwind Ltd', vendor: 'fallback', retrievedAt: 'now' },
    });
    const orchestrator = new EnrichmentOrchestrator([primary, fallback], harness.platform.metering, 8.0, 90, clock);
    const config = {
      ...harness.config,
      engagement: { ...harness.config.engagement, enrichmentEnabled: true, enrichmentMonthlyCapPence: 100 },
    };
    return { orchestrator, config, primary, fallback, harness };
  }

  it('shows the cost before a bulk routine runs', async () => {
    const { orchestrator: o, config } = await orchestrator();
    const preview = await o.preview(config, ['a.co.uk', 'b.co.uk', 'a.co.uk']);
    expect(preview.records).toBe(2);
    expect(preview.chargeable).toBe(2);
    expect(preview.estimatedPence).toBe(16);
    expect(preview.withinCap).toBe(true);
  });

  it('falls through to a second vendor when the primary returns nothing (FR-065)', async () => {
    const { orchestrator: o, config, primary, fallback } = await orchestrator();
    const record = await o.enrich(config, 'northwind.co.uk');
    expect(record?.vendor).toBe('fallback');
    expect(primary.calls).toBe(1);
    expect(fallback.calls).toBe(1);
  });

  it('caches per tenant and does not charge twice for the same domain', async () => {
    const { orchestrator: o, config, fallback, harness } = await orchestrator();
    await o.enrich(config, 'northwind.co.uk');
    await o.enrich(config, 'northwind.co.uk');
    expect(fallback.calls).toBe(1);
    const usage = await harness.platform.metering.usage(config.tenantId);
    expect(usage.enrichmentRecords).toBe(1);
  });

  it('refuses to exceed the monthly enrichment cap', async () => {
    const { orchestrator: o, config } = await orchestrator();
    const domains = Array.from({ length: 50 }, (_, i) => `d${i}.co.uk`);
    await expect(o.enrichMany(config, domains)).rejects.toMatchObject({ kind: 'SPEND_CAP_REACHED' });
  });

  it('refuses to run at all when the tenant has not enabled enrichment', async () => {
    const { orchestrator: o, config } = await orchestrator();
    await expect(o.enrich({ ...config, engagement: { ...config.engagement, enrichmentEnabled: false } }, 'x.co.uk'))
      .rejects.toMatchObject({ kind: 'POLICY_DENIED' });
  });
});

describe('account matching (FR-064)', () => {
  it('matches a company to a CRM account without matching a person', async () => {
    const crm = new SandboxConnector();
    const harness = await buildHarness({ crm });
    crm.seed({ objectType: 'organisation', name: 'Northwind Ltd', domain: 'northwind.co.uk', ownerRef: 'owner_1' });

    const matcher = new AccountMatcher(harness.platform.adapter);
    const result = await matcher.match(harness.config.tenantId, COMPANY);

    expect(result.match?.accountName).toBe('Northwind Ltd');
    expect(result.match?.ownerRef).toBe('owner_1');
    // No person-shaped field exists on the result at all.
    expect(JSON.stringify(result)).not.toMatch(/personRef|email/);
  });

  it('declines to guess when two accounts share a domain', async () => {
    const crm = new SandboxConnector();
    const harness = await buildHarness({ crm });
    crm.seed({ objectType: 'organisation', name: 'Northwind Ltd', domain: 'northwind.co.uk' });
    crm.seed({ objectType: 'organisation', name: 'Northwind Group', domain: 'northwind.co.uk' });

    const result = await new AccountMatcher(harness.platform.adapter).match(harness.config.tenantId, COMPANY);
    expect(result.match).toBeUndefined();
    expect(result.reason).toMatch(/declining to guess/);
  });
});

describe('synthetic media marking (FR-068)', () => {
  it('marks generated media machine-readably', () => {
    const mark = markSyntheticMedia({
      kind: 'video', tenantId: 't1', correlationId: 'c1',
      presenter: 'NON_HUMAN', createdAt: '2026-09-04T09:00:00.000Z',
    });
    expect(mark.generatedBy).toBe('ai');
    expect(mark.assertion).toBe('c2pa.actions');
    expect(mark.visibleLabel).toBe('AI-generated');
  });

  it('refuses a synthetic likeness of a person rather than marking it', () => {
    // Marking does not cure impersonation. Section 13.3 prohibits it outright.
    expect(() => markSyntheticMedia({
      kind: 'video', tenantId: 't1', correlationId: 'c1',
      presenter: 'SYNTHETIC_LIKENESS', createdAt: 'now',
    })).toThrow(ImpersonationBoundaryError);
  });

  it('refuses to serve an unmarked asset', () => {
    expect(() => assertMarked(undefined, 'asset_1')).toThrowError(/no Article 50\(2\) marking/);
  });
});
