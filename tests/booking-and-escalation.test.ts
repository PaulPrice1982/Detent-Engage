import { describe, expect, it } from 'vitest';
import { buildToolCatalogue, nextQualifyingQuestion, scoreQualification, transitionLead } from '@detent/awa-agent';
import { DEFAULT_HIGH_RISK_TOPICS, evaluateEscalation, evaluatePriceAuthority } from '@detent/awa-policy';
import { buildHarness } from './fixtures/tenant.js';

/**
 * CI gates: calendar race (zero double bookings), human handoff (correct
 * trigger in 100% of scenario cases), and the invariant from section 28 — a
 * commitment already made to a person is never retracted to preserve system
 * consistency.
 */
describe('meeting booking', () => {
  it('never double-books under concurrent requests for the same slot', async () => {
    const harness = await buildHarness();
    const tenantId = harness.config.tenantId;
    harness.platform.calendar.seed(tenantId, [
      { id: 'slot_1', ownerRef: 'owner_1', startsAt: '2026-09-08T10:00:00.000Z', endsAt: '2026-09-08T10:30:00.000Z' },
    ]);

    const attempts = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        (async () => {
          await harness.platform.calendar.hold(tenantId, 'slot_1');
          return harness.platform.calendar.confirm(tenantId, 'slot_1', `visitor${i}@acme.co.uk`, `key_${i}`);
        })(),
      ),
    );

    const confirmed = attempts.filter((a) => a.status === 'fulfilled');
    expect(confirmed).toHaveLength(1);
    expect(harness.platform.calendar.bookingsFor(tenantId)).toHaveLength(1);
  });

  it('is idempotent on the session-derived key', async () => {
    const harness = await buildHarness();
    const tenantId = harness.config.tenantId;
    harness.platform.calendar.seed(tenantId, [
      { id: 'slot_1', ownerRef: 'owner_1', startsAt: '2026-09-08T10:00:00.000Z', endsAt: '2026-09-08T10:30:00.000Z' },
    ]);

    await harness.platform.calendar.hold(tenantId, 'slot_1');
    const first = await harness.platform.calendar.confirm(tenantId, 'slot_1', 'a@acme.co.uk', 'sess_1:book_meeting:1');
    const second = await harness.platform.calendar.confirm(tenantId, 'slot_1', 'a@acme.co.uk', 'sess_1:book_meeting:1');
    expect(second.id).toBe(first.id);
  });

  it('refuses to confirm a slot it has not held', async () => {
    const harness = await buildHarness();
    const tenantId = harness.config.tenantId;
    harness.platform.calendar.seed(tenantId, [
      { id: 'slot_1', ownerRef: 'owner_1', startsAt: '2026-09-08T10:00:00.000Z', endsAt: '2026-09-08T10:30:00.000Z' },
    ]);
    await expect(harness.platform.calendar.confirm(tenantId, 'slot_1', 'a@acme.co.uk', 'k'))
      .rejects.toMatchObject({ kind: 'CONFLICT' });
  });

  it('confirms the booking to the visitor even when the CRM write fails', async () => {
    const { SandboxConnector } = await import('@detent/awa-connectors');
    const crm = new SandboxConnector({ failNextWrites: 6, failureKind: 'UPSTREAM_UNAVAILABLE' });
    const harness = await buildHarness({ crm });
    const tenantId = harness.config.tenantId;
    const config = harness.platform.effectiveConfig(tenantId);

    harness.platform.calendar.seed(tenantId, [
      { id: 'slot_1', ownerRef: 'owner_1', startsAt: '2026-09-08T10:00:00.000Z', endsAt: '2026-09-08T10:30:00.000Z' },
    ]);

    const session = await harness.platform.openSession(tenantId, 'UK');
    const result = await harness.platform.executor.execute(session, config, buildToolCatalogue(config.serviceCatalogue), {
      tool: 'book_meeting',
      args: { slot_id: 'slot_1', work_email: 'alex@acme.co.uk', confirmed_fields: ['work_email', 'slot_id'] },
    });

    // The invariant: the visitor is told the booking is confirmed, because it is.
    expect(result.modelVisible['booked']).toBe(true);
    expect(result.internal?.['crmLogged']).toBe(false);

    const audit = await harness.platform.audit.export(tenantId);
    expect(audit.entries.some((e) => e.type === 'crm_write_parked')).toBe(true);
    expect(harness.platform.calendar.bookingsFor(tenantId)).toHaveLength(1);
  });
});

describe('escalation triggers', () => {
  const thresholds = { confidenceFloor: 0.65, negativeSentimentTurns: 2, highRiskTopics: DEFAULT_HIGH_RISK_TOPICS };

  it('escalates on an explicit request and stops qualifying', () => {
    const outcome = evaluateEscalation(thresholds, { visitorAskedForHuman: true });
    expect(outcome.escalate).toBe(true);
    expect(outcome.stopQualifying).toBe(true);
  });

  it('escalates on low confidence for a factual question, and suppresses the answer', () => {
    const outcome = evaluateEscalation(thresholds, { factualQuestion: true, modelConfidence: 0.4 });
    expect(outcome.triggers).toContain('low_confidence');
    expect(outcome.answerSuppressed).toBe(true);
  });

  it('does not escalate on low confidence when no factual claim was requested', () => {
    expect(evaluateEscalation(thresholds, { modelConfidence: 0.4 }).escalate).toBe(false);
  });

  it('escalates on a high-risk topic without attempting an answer', () => {
    const outcome = evaluateEscalation(thresholds, { detectedTopics: ['employment tribunal claim'] });
    expect(outcome.triggers).toContain('high_risk_topic');
    expect(outcome.answerSuppressed).toBe(true);
  });

  it('routes an existing customer away from the new-lead path', () => {
    const outcome = evaluateEscalation(thresholds, { classification: 'EXISTING_CUSTOMER' });
    expect(outcome.triggers).toContain('existing_customer');
    expect(outcome.stopQualifying).toBe(true);
  });

  it('escalates on sustained negative sentiment, not on a single turn', () => {
    expect(evaluateEscalation(thresholds, { consecutiveNegativeTurns: 1 }).escalate).toBe(false);
    expect(evaluateEscalation(thresholds, { consecutiveNegativeTurns: 2 }).escalate).toBe(true);
  });

  it('carries full context to the handoff console so the visitor does not repeat themselves', async () => {
    const harness = await buildHarness({
      script: [{ match: /human/i, output: { text: 'Of course.', toolCalls: [{ tool: 'escalate_to_human', args: { reason: 'explicit_request', summary: 'Visitor asked for a person.' } }] } }],
    });
    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    await harness.platform.orchestrator.run({
      session, config: harness.platform.effectiveConfig(session.tenantId),
      visitorInput: 'Can I speak to a human please',
    });

    const [handoff] = harness.platform.handoff.forTenant(session.tenantId);
    expect(handoff).toBeDefined();
    expect(handoff!.transcript.length).toBeGreaterThan(0);
    expect(handoff!.reason).toBe('explicit_request');
  });
});

describe('price authority', () => {
  it('states an approved fixed price verbatim with its conditions', async () => {
    const { config } = await buildHarness();
    const outcome = evaluatePriceAuthority(config, { sku: 'contract-review' });
    expect(outcome.kind).toBe('STATE_PRICE');
    expect(outcome.statement).toContain('£4,500');
    expect(outcome.statement).toContain('up to 25 contracts');
  });

  it('states a range and what moves a quote within it', async () => {
    const { config } = await buildHarness();
    const outcome = evaluatePriceAuthority(config, { sku: 'revenue-recovery' });
    expect(outcome.kind).toBe('STATE_RANGE');
    expect(outcome.statement).toContain('contract volume');
  });

  it('never offers a discount and always routes the request to a human', async () => {
    const { config } = await buildHarness();
    const outcome = evaluatePriceAuthority(config, { sku: 'contract-review', discountRequested: true });
    expect(outcome.kind).toBe('ROUTE_TO_HUMAN');
    expect(outcome.statement).not.toMatch(/\d/);
  });

  it('routes an off-list SKU to a human rather than improvising', async () => {
    const { config } = await buildHarness();
    expect(evaluatePriceAuthority(config, { sku: 'nonexistent' }).kind).toBe('ROUTE_TO_HUMAN');
  });

  it('quotes on scope where the tenant has published nothing', async () => {
    const { config } = await buildHarness();
    const outcome = evaluatePriceAuthority({ ...config, priceList: [] }, {});
    expect(outcome.kind).toBe('QUOTE_ON_SCOPE');
  });
});

describe('progressive disclosure', () => {
  it('answers a direct question before asking anything', async () => {
    const { config } = await buildHarness();
    const outcome = nextQualifyingQuestion({
      config, state: { captured: {}, askedThisSession: [] },
      visitorAskedQuestion: true, visitorAskedForHuman: false, valueDelivered: true,
    });
    expect(outcome.shouldAsk).toBe(false);
  });

  it('stops the moment the visitor asks for a human', async () => {
    const { config } = await buildHarness();
    const outcome = nextQualifyingQuestion({
      config, state: { captured: {}, askedThisSession: [] },
      visitorAskedQuestion: false, visitorAskedForHuman: true, valueDelivered: true,
    });
    expect(outcome.shouldAsk).toBe(false);
    expect(outcome.reason).toContain('qualification stops');
  });

  it('never re-asks a dimension already captured or already asked', async () => {
    const { config } = await buildHarness();
    const outcome = nextQualifyingQuestion({
      config,
      state: { captured: { timing: 'this quarter' }, askedThisSession: ['budget', 'scale'] },
      visitorAskedQuestion: false, visitorAskedForHuman: false, valueDelivered: true,
    });
    expect(outcome.shouldAsk).toBe(false);
  });

  it('scores qualification against the tenant model', async () => {
    const { config } = await buildHarness();
    const verdict = scoreQualification(config.qualification, {
      captured: { need: 'contract leakage', timing: 'this quarter', service_interest: 'contract-review', scale: '400 contracts' },
      askedThisSession: [],
    });
    expect(verdict.state).toBe('QUALIFIED');
    expect(verdict.missingRequired).toHaveLength(0);
  });

  it('refuses an illegal lead state transition', () => {
    expect(transitionLead('New', 'Captured')).toBe('Captured');
    expect(() => transitionLead('New', 'Routed')).toThrowError(/illegal lead transition/);
  });
});
