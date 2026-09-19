import { describe, expect, it } from 'vitest';
import { buildToolCatalogue } from '@detent/awa-agent';
import { SandboxConnector } from '@detent/awa-connectors';
import { buildHarness, bearer } from './fixtures/tenant.js';

/**
 * The named sequence flows from section 12, exercised end to end through the
 * real API and the real policy path.
 */
describe('Flow 1: anonymous new visitor starts a text conversation', () => {
  it('shows the disclosure, answers from tenant knowledge, and makes no CRM call', async () => {
    const harness = await buildHarness({
      script: [{
        match: /contract/i,
        output: {
          text: 'We audit commercial agreements for unbilled excess use and renewal exposure. What is prompting you to look at this now?',
          toolCalls: [{ tool: 'knowledge_lookup', args: { query: 'contract review service' } }],
        },
      }],
    });

    const created = await harness.api.handle({
      method: 'POST', path: '/v1/sessions', headers: bearer(harness.widgetKey), body: { jurisdiction: 'UK' },
    });
    expect(created.status).toBe(201);
    const { session_id, disclosure } = created.body as { session_id: string; disclosure: string };
    expect(disclosure).toContain('AI');

    const reply = await harness.api.handle({
      method: 'POST', path: `/v1/sessions/${session_id}/messages`,
      headers: bearer(harness.widgetKey), body: { text: 'Do you do contract reviews?' },
    });

    expect(reply.status).toBe(200);
    const body = reply.body as { text: string };
    expect(body.text).toContain('unbilled excess use');

    // No consent, so no identity resolution and no CRM call of any kind.
    const audit = await harness.platform.audit.export(harness.config.tenantId);
    expect(audit.entries.some((e) => e.type === 'resolution_started')).toBe(false);
    expect(audit.entries.some((e) => e.type === 'crm_write_attempted')).toBe(false);
    expect(audit.verification.valid).toBe(true);
  });
});

describe('Flows 5 and 6: known contact returns with an open opportunity', () => {
  it('routes to the owner and discloses nothing about the CRM', async () => {
    const crm = new SandboxConnector();
    const harness = await buildHarness({ crm });
    const tenantId = harness.config.tenantId;

    const contact = crm.seed({ objectType: 'contact', email: 'alex@acme.co.uk', name: 'Alex Warner', ownerRef: 'owner_1' });
    crm.seedOpportunity({ id: 'opp_1', personRef: contact.id, stageRef: 'proposal', ownerRef: 'owner_1', isOpen: true });

    const session = await harness.platform.openSession(tenantId, 'UK');
    await harness.platform.consent.record({
      tenantId, subjectRef: session.subjectRef, purpose: 'IDENTITY_RESOLUTION',
      choice: 'GRANTED', wordingShown: 'May we check whether we already know you?',
      source: 'HOST_CMP', jurisdiction: 'UK', correlationId: session.correlationId,
    });

    const config = harness.platform.effectiveConfig(tenantId);
    const result = await harness.platform.executor.execute(session, config, buildToolCatalogue(config.serviceCatalogue), {
      tool: 'resolve_identity', args: { work_email: 'alex@acme.co.uk' },
    });

    expect(result.modelVisible['classification']).toBe('OPEN_OPPORTUNITY');
    expect(result.modelVisible['permittedBehaviour']).toBe('route_to_owner');
    // The classification changes what the assistant does, never what it says.
    const serialised = JSON.stringify(result.modelVisible);
    expect(serialised).not.toContain('opp_1');
    expect(serialised).not.toContain('proposal');
    expect(serialised).not.toContain('Alex Warner');
    expect(serialised).not.toContain('owner_1');
  });

  it('creates a note and a task for the owner, and no new lead record', async () => {
    const crm = new SandboxConnector();
    const harness = await buildHarness({ crm });
    const tenantId = harness.config.tenantId;
    const contact = crm.seed({ objectType: 'contact', email: 'alex@acme.co.uk', name: 'Alex Warner', ownerRef: 'owner_1' });
    crm.seedOpportunity({ id: 'opp_1', personRef: contact.id, stageRef: 'proposal', ownerRef: 'owner_1', isOpen: true });

    const session = await harness.platform.openSession(tenantId, 'UK');
    await harness.platform.consent.record({
      tenantId, subjectRef: session.subjectRef, purpose: 'IDENTITY_RESOLUTION',
      choice: 'GRANTED', wordingShown: 'w', source: 'HOST_CMP', jurisdiction: 'UK', correlationId: session.correlationId,
    });

    const config = harness.platform.effectiveConfig(tenantId);
    const catalogue = buildToolCatalogue(config.serviceCatalogue);
    const before = crm.records.size;

    await harness.platform.executor.execute(session, config, catalogue, { tool: 'resolve_identity', args: { work_email: 'alex@acme.co.uk' } });
    await harness.platform.executor.execute(session, config, catalogue, { tool: 'create_note', args: { subject: 'Website enquiry', body: 'Returning contact asked about renewal exposure.' } });
    await harness.platform.executor.execute(session, config, catalogue, { tool: 'create_task', args: { subject: 'Follow up with returning contact' } });

    expect(crm.records.size).toBe(before);
    expect(crm.activities.filter((a) => a.objectType === 'note')).toHaveLength(1);
    const task = crm.activities.find((a) => a.objectType === 'task');
    // The owner is the CRM-resolved reference, not one the assistant chose.
    expect(task?.ownerRef).toBe('owner_1');
  });
});

describe('Flow 8: existing customer must never enter the new-lead path', () => {
  it('classifies as EXISTING_CUSTOMER and escalates to the account team', async () => {
    const crm = new SandboxConnector();
    const harness = await buildHarness({ crm });
    const tenantId = harness.config.tenantId;
    crm.seed({ objectType: 'contact', email: 'alex@acme.co.uk', name: 'Alex Warner', ownerRef: 'owner_1', lifecycleStage: 'customer' });

    const session = await harness.platform.openSession(tenantId, 'UK');
    await harness.platform.consent.record({
      tenantId, subjectRef: session.subjectRef, purpose: 'IDENTITY_RESOLUTION',
      choice: 'GRANTED', wordingShown: 'w', source: 'HOST_CMP', jurisdiction: 'UK', correlationId: session.correlationId,
    });

    const resolution = await harness.platform.identity.resolve({
      tenantId, sessionId: session.id, subjectRef: session.subjectRef,
      correlationId: session.correlationId, email: 'alex@acme.co.uk',
    });
    expect(resolution.classification).toBe('EXISTING_CUSTOMER');
    expect(resolution.permittedBehaviour).toBe('route_to_account_team');
  });
});

describe('Flow 19: tenant CRM token revoked mid-operation', () => {
  it('parks writes, degrades the connection, and keeps the conversation going', async () => {
    const crm = new SandboxConnector({ failNextWrites: 1, failureKind: 'CONNECTION_DEGRADED' });
    const harness = await buildHarness({
      crm,
      script: [{
        match: /.*/,
        output: {
          text: 'Thanks, I have your details and the team will pick this up.',
          toolCalls: [{ tool: 'upsert_person', args: { work_email: 'alex@acme.co.uk', qualification_state: 'QUALIFIED' } }],
        },
      }],
    });

    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    const turn = await harness.platform.orchestrator.run({
      session, config: harness.platform.effectiveConfig(session.tenantId),
      visitorInput: 'Here are my details, alex@acme.co.uk',
    });

    // The conversation is unaffected. Fail closed on the credential, fail open
    // on the conversation.
    expect(turn.text).toContain('the team will pick this up');
    expect(await harness.platform.adapter.connectionState(session.tenantId)).toBe('DEGRADED');

    // On reconnect, parked writes drain idempotently: exactly one record.
    await harness.platform.adapter.markConnected(session.tenantId);
    const config = harness.platform.effectiveConfig(session.tenantId);
    await harness.platform.executor.execute(session, config, buildToolCatalogue(config.serviceCatalogue), {
      tool: 'upsert_person', args: { work_email: 'alex@acme.co.uk', qualification_state: 'QUALIFIED' },
    });
    expect([...crm.records.values()].filter((r) => r.email === 'alex@acme.co.uk')).toHaveLength(1);
  });
});

describe('Flow 21: tenant exceeds plan quota', () => {
  it('degrades rather than silently overspending on the tenant behalf', async () => {
    const harness = await buildHarness();
    const tenantId = harness.config.tenantId;
    // The spend cap is operator-authority: a tenant admin may not raise their
    // own ceiling (audit SEC-6), so the test sets it as the operator does.
    await harness.platform.tenants.update(tenantId, {
      spendCaps: { monthlyPence: 100, warnAtFraction: 0.5, degradeToTextAtFraction: 0.8, maxConcurrentVoice: 1, maxConversationsPerMonth: 2 },
    }, 'platform_admin');

    await harness.platform.metering.record(tenantId, 'conversation', 5);
    const config = harness.platform.effectiveConfig(tenantId);
    const session = await harness.platform.openSession(tenantId, 'UK');

    const decision = await harness.platform.policy.evaluate({
      tenantConfig: config, tool: 'knowledge_lookup', args: { query: 'x' },
      correlationId: session.correlationId, sessionId: session.id,
      subjectRef: session.subjectRef, connectionState: 'CONNECTED',
    });

    expect(decision.effect).toBe('DENY');
    expect(decision.obligations.degradeTo).toBe('BOOKING_LINK_ONLY');
    expect(decision.obligations.warnTenant).toBe(true);
  });
});

describe('the visitor asking for a human stops qualification immediately', () => {
  it('refuses further qualifying tools but never blocks escalation', async () => {
    const harness = await buildHarness();
    const config = harness.platform.effectiveConfig(harness.config.tenantId);
    const session = await harness.platform.openSession(config.tenantId, 'UK');
    session.humanRequested = true;

    const captureDecision = await harness.platform.policy.evaluate({
      tenantConfig: config, tool: 'capture_contact',
      args: { work_email: 'a@acme.co.uk', full_name: 'Alex Warner', service_interest: 'contract-review', confirmed_fields: ['work_email', 'full_name'] },
      correlationId: session.correlationId, sessionId: session.id,
      subjectRef: session.subjectRef, connectionState: 'CONNECTED', humanRequested: true,
    });
    expect(captureDecision.effect).toBe('DENY');

    const escalateDecision = await harness.platform.policy.evaluate({
      tenantConfig: config, tool: 'escalate_to_human', args: { reason: 'explicit_request' },
      correlationId: session.correlationId, sessionId: session.id,
      subjectRef: session.subjectRef, connectionState: 'CONNECTED', humanRequested: true,
    });
    expect(escalateDecision.effect).toBe('ALLOW');
  });
});

describe('non-resolving mode is a full path, not a penalty', () => {
  it('qualifies, captures and books without ever touching a CRM', async () => {
    const crm = new SandboxConnector();
    const harness = await buildHarness({ crm });
    const tenantId = harness.config.tenantId;
    const config = harness.platform.effectiveConfig(tenantId);
    harness.platform.calendar.seed(tenantId, [
      { id: 'slot_1', ownerRef: 'owner_1', startsAt: '2026-09-08T10:00:00.000Z', endsAt: '2026-09-08T10:30:00.000Z' },
    ]);

    const session = await harness.platform.openSession(tenantId, 'UK');
    const catalogue = buildToolCatalogue(config.serviceCatalogue);

    await harness.platform.executor.execute(session, config, catalogue, {
      tool: 'capture_contact',
      args: { work_email: 'alex@acme.co.uk', full_name: 'Alex Warner', service_interest: 'contract-review', confirmed_fields: ['work_email', 'full_name'] },
    });
    const booking = await harness.platform.executor.execute(session, config, catalogue, {
      tool: 'book_meeting', args: { slot_id: 'slot_1', work_email: 'alex@acme.co.uk', confirmed_fields: ['work_email', 'slot_id'] },
    });

    expect(booking.modelVisible['booked']).toBe(true);
    expect(harness.platform.calendar.bookingsFor(tenantId)).toHaveLength(1);
    // No consent was given, so no CRM person record was created.
    expect([...crm.records.values()].filter((r) => r.email === 'alex@acme.co.uk')).toHaveLength(0);
  });
});
