import { describe, expect, it } from 'vitest';
import { buildHarness, bearer } from './fixtures/tenant.js';

/**
 * CI gate: consent gate integrity.
 * Pass threshold: zero identity resolutions and zero enrolments without a
 * stored consent event (section 30, table 41; section 36.2).
 */
describe('consent gate integrity', () => {
  it('does not resolve identity, and makes no CRM call, without a stored consent event', async () => {
    const harness = await buildHarness();
    const tenantId = harness.config.tenantId;
    harness.crm.seed({ objectType: 'contact', email: 'alex@acme.co.uk', name: 'Alex Warner', ownerRef: 'owner_1' });

    const session = await harness.platform.openSession(tenantId, 'UK');
    const resolution = await harness.platform.identity.resolve({
      tenantId,
      sessionId: session.id,
      subjectRef: session.subjectRef,
      correlationId: session.correlationId,
      email: 'alex@acme.co.uk',
    });

    expect(resolution.classification).toBe('NEW_PROSPECT');
    expect(resolution.reason).toBe('no_consent');
    expect(resolution.matchedExternalId).toBeUndefined();

    const audit = await harness.platform.audit.export(tenantId);
    expect(audit.entries.some((e) => e.type === 'resolution_blocked_no_consent')).toBe(true);
    // The strongest assertion available: no CRM search was performed at all.
    expect(audit.entries.some((e) => e.type === 'resolution_started')).toBe(false);
  });

  it('resolves once, and only once, an affirmative consent event is stored', async () => {
    const harness = await buildHarness();
    const tenantId = harness.config.tenantId;
    harness.crm.seed({ objectType: 'contact', email: 'alex@acme.co.uk', name: 'Alex Warner', ownerRef: 'owner_1', lifecycleStage: 'lead' });

    const session = await harness.platform.openSession(tenantId, 'UK');
    await harness.platform.consent.record({
      tenantId, subjectRef: session.subjectRef, purpose: 'IDENTITY_RESOLUTION',
      choice: 'GRANTED', wordingShown: 'May we check whether we already know you?',
      source: 'WIDGET_PROMPT', jurisdiction: 'UK', correlationId: session.correlationId,
    });

    const resolution = await harness.platform.identity.resolve({
      tenantId, sessionId: session.id, subjectRef: session.subjectRef,
      correlationId: session.correlationId, email: 'alex@acme.co.uk',
    });

    expect(resolution.classification).toBe('KNOWN_PROSPECT');
    expect(resolution.consentEventId).toBeDefined();
  });

  it('treats a refusal as refusal and stores it as evidence', async () => {
    const harness = await buildHarness();
    const tenantId = harness.config.tenantId;
    const session = await harness.platform.openSession(tenantId, 'UK');

    await harness.platform.consent.record({
      tenantId, subjectRef: session.subjectRef, purpose: 'IDENTITY_RESOLUTION',
      choice: 'REFUSED', wordingShown: 'May we check whether we already know you?',
      source: 'WIDGET_PROMPT', jurisdiction: 'UK', correlationId: session.correlationId,
    });

    expect(await harness.platform.consent.isGranted(tenantId, session.subjectRef, 'IDENTITY_RESOLUTION')).toBe(false);
    // Answered, so the visitor is not asked again in this session.
    expect(await harness.platform.consent.hasAnswered(tenantId, session.subjectRef, 'IDENTITY_RESOLUTION')).toBe(true);
  });

  it('blocks marketing enrolment without a stored consent event, whatever the model proposes', async () => {
    const harness = await buildHarness();
    const config = harness.platform.effectiveConfig(harness.config.tenantId);
    const session = await harness.platform.openSession(config.tenantId, 'UK');

    const decision = await harness.platform.policy.evaluate({
      tenantConfig: config,
      tool: 'enrol_sequence',
      args: { work_email: 'alex@acme.co.uk', sequence_id: 'seq_1', consent_event_id: 'ce_fabricated', confirmed_fields: ['work_email'] },
      correlationId: session.correlationId,
      sessionId: session.id,
      subjectRef: session.subjectRef,
      connectionState: 'CONNECTED',
    });

    expect(decision.effect).toBe('DENY');
    const audit = await harness.platform.audit.export(config.tenantId);
    expect(audit.entries.some((e) => e.type === 'enrolment_blocked_no_consent')).toBe(true);
  });

  it('rejects a fabricated consent_event_id that does not match the stored event', async () => {
    const harness = await buildHarness();
    const config = harness.platform.effectiveConfig(harness.config.tenantId);
    const session = await harness.platform.openSession(config.tenantId, 'UK');

    await harness.platform.consent.record({
      tenantId: config.tenantId, subjectRef: session.subjectRef, purpose: 'MARKETING',
      choice: 'GRANTED', wordingShown: 'Send me occasional updates.',
      source: 'WIDGET_PROMPT', jurisdiction: 'UK', correlationId: session.correlationId,
    });

    const decision = await harness.platform.policy.evaluate({
      tenantConfig: config,
      tool: 'enrol_sequence',
      // Consent exists, but the model presents a different id. Refused: the
      // stored event is the evidence, not the argument.
      args: { work_email: 'a@acme.co.uk', sequence_id: 's', consent_event_id: 'ce_wrong', confirmed_fields: ['work_email'] },
      correlationId: session.correlationId, sessionId: session.id,
      subjectRef: session.subjectRef, connectionState: 'CONNECTED',
    });

    expect(decision.effect).toBe('DENY');
    expect(decision.reasons.join(' ')).toContain('does not match the stored event');
  });

  it('records consent through the API with the exact wording shown', async () => {
    const harness = await buildHarness();
    const created = await harness.api.handle({
      method: 'POST', path: '/v1/sessions', headers: bearer(harness.widgetKey), body: { jurisdiction: 'UK' },
    });
    const sessionId = (created.body as { session_id: string }).session_id;

    const wording = 'We would like to check whether you are already a client so we can put you through to the right person. Is that OK?';
    const response = await harness.api.handle({
      method: 'POST', path: `/v1/sessions/${sessionId}/consent`,
      headers: bearer(harness.widgetKey),
      body: { purpose: 'IDENTITY_RESOLUTION', granted: true, wording },
    });

    expect(response.status).toBe(201);
    const session = harness.platform.sessions.get(sessionId)!;
    const stored = await harness.platform.consent.get(session.tenantId, session.subjectRef, 'IDENTITY_RESOLUTION');
    expect(stored?.wordingShown).toBe(wording);
  });
});
