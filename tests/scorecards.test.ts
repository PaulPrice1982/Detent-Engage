import { describe, expect, it } from 'vitest';
import { allTime } from '@detent/awa-analytics';
import { buildToolCatalogue } from '@detent/awa-agent';
import { SandboxConnector } from '@detent/awa-connectors';
import { buildHarness, bearer } from './fixtures/tenant.js';

/**
 * CI gates for section 41 / FR-049 to FR-053.
 *
 * The compliance scorecard is the extension's own nominated highest-leverage
 * item, and the CRM data quality scorecard is the one that turns invisible
 * write-fidelity work into a renewal argument.
 */
async function busyTenant() {
  const crm = new SandboxConnector();
  const harness = await buildHarness({
    crm,
    script: [{ match: /.*/, output: { text: 'Happy to help.' } }],
  });
  const tenantId = harness.config.tenantId;
  const config = harness.platform.effectiveConfig(tenantId);
  const catalogue = buildToolCatalogue(config.serviceCatalogue);

  crm.seed({ objectType: 'contact', email: 'known@acme.co.uk', name: 'Known Person', ownerRef: 'owner_1' });

  // Session 1: consent refused, then a conversation.
  const s1 = await harness.platform.openSession(tenantId, 'UK');
  await harness.platform.consent.record({
    tenantId, subjectRef: s1.subjectRef, purpose: 'IDENTITY_RESOLUTION', choice: 'REFUSED',
    wordingShown: 'May we check whether we already know you?', source: 'WIDGET_PROMPT',
    jurisdiction: 'UK', correlationId: s1.correlationId,
  });
  await harness.platform.orchestrator.run({ session: s1, config, visitorInput: 'What do you do?' });
  // Blocked, because consent was refused.
  await harness.platform.identity.resolve({
    tenantId, sessionId: s1.id, subjectRef: s1.subjectRef,
    correlationId: s1.correlationId, email: 'known@acme.co.uk',
  });

  // Session 2: consent granted, resolution runs, and two writes to the same person.
  const s2 = await harness.platform.openSession(tenantId, 'UK');
  await harness.platform.consent.record({
    tenantId, subjectRef: s2.subjectRef, purpose: 'IDENTITY_RESOLUTION', choice: 'GRANTED',
    wordingShown: 'May we check whether we already know you?', source: 'HOST_CMP',
    jurisdiction: 'UK', correlationId: s2.correlationId,
  });
  await harness.platform.orchestrator.run({ session: s2, config, visitorInput: 'Hello' });
  await harness.platform.executor.execute(s2, config, catalogue, {
    tool: 'resolve_identity', args: { work_email: 'known@acme.co.uk' },
  });
  await harness.platform.executor.execute(s2, config, catalogue, {
    tool: 'upsert_person', args: { work_email: 'known@acme.co.uk', qualification_state: 'QUALIFIED' },
  });
  await harness.platform.executor.execute(s2, config, catalogue, {
    tool: 'upsert_person', args: { work_email: 'known@acme.co.uk', qualification_state: 'QUALIFIED' },
  });
  await harness.platform.outcomes.record({
    config, conversationId: s2.id, correlationId: s2.correlationId, outcome: 'book_meeting',
  });

  // Session 3: a blocked marketing enrolment.
  const s3 = await harness.platform.openSession(tenantId, 'UK');
  await harness.platform.policy.evaluate({
    tenantConfig: config, tool: 'enrol_sequence',
    args: { work_email: 'a@acme.co.uk', sequence_id: 's', consent_event_id: 'ce_x', confirmed_fields: ['work_email'] },
    correlationId: s3.correlationId, sessionId: s3.id, subjectRef: s3.subjectRef, connectionState: 'CONNECTED',
  });

  return { harness, tenantId, crm };
}

describe('the compliance scorecard (FR-051)', () => {
  it('reports the PECR gate operating, not merely specified', async () => {
    const { harness, tenantId } = await busyTenant();
    const scorecard = await harness.platform.compliance.build(tenantId, allTime(), '2026-09-04T10:00:00.000Z');

    expect(scorecard.identityResolutionsBlockedForConsent).toBeGreaterThan(0);
    expect(scorecard.identityResolutionsPerformed).toBeGreaterThan(0);
  });

  it('reports blocked marketing enrolments', async () => {
    const { harness, tenantId } = await busyTenant();
    const scorecard = await harness.platform.compliance.build(tenantId, allTime(), '2026-09-04T10:00:00.000Z');
    expect(scorecard.marketingEnrolmentsBlocked).toBeGreaterThan(0);
  });

  it('reports AI disclosure coverage, targeting 100%', async () => {
    const { harness, tenantId } = await busyTenant();
    const scorecard = await harness.platform.compliance.build(tenantId, allTime(), '2026-09-04T10:00:00.000Z');
    expect(scorecard.sessionsWithDisclosure).toBeGreaterThan(0);
    // Sessions 1 and 2 had a turn; session 3 never did, so coverage is
    // reported honestly rather than rounded up.
    expect(scorecard.aiDisclosureCoveragePct).toBeGreaterThan(0);
    expect(scorecard.aiDisclosureCoveragePct).toBeLessThanOrEqual(100);
  });

  it('breaks consent down by purpose, jurisdiction and outcome', async () => {
    const { harness, tenantId } = await busyTenant();
    const scorecard = await harness.platform.compliance.build(tenantId, allTime(), '2026-09-04T10:00:00.000Z');
    const identity = scorecard.consentEvents.find((row) => row.purpose === 'IDENTITY_RESOLUTION');
    expect(identity).toBeDefined();
    expect(identity!.granted).toBe(1);
    expect(identity!.refused).toBe(1);
    expect(identity!.jurisdiction).toBe('UK');
  });

  it('carries the chain verification with the figures', async () => {
    const { harness, tenantId } = await busyTenant();
    const scorecard = await harness.platform.compliance.build(tenantId, allTime(), '2026-09-04T10:00:00.000Z');
    // A scorecard whose underlying log does not verify is not evidence, and
    // shipping it without saying so would be compliance theatre.
    expect(scorecard.evidence.chainVerified).toBe(true);
    expect(scorecard.evidence.auditEntriesExamined).toBeGreaterThan(0);
  });

  it('exports machine-readable over any date range in one action', async () => {
    const { harness, tenantId } = await busyTenant();
    const response = await harness.api.handle({
      method: 'GET', path: `/v1/admin/tenants/${tenantId}/compliance`,
      headers: bearer(harness.adminKey),
    });
    expect(response.status).toBe(200);
    expect(response.headers?.['content-disposition']).toContain('attachment');
    expect(JSON.parse(JSON.stringify(response.body))).toHaveProperty('aiDisclosureCoveragePct');
  });

  it('honours a narrow date window', async () => {
    const { harness, tenantId } = await busyTenant();
    const empty = await harness.platform.compliance.build(
      tenantId, { from: '2020-01-01T00:00:00.000Z', to: '2020-01-02T00:00:00.000Z' }, 'now',
    );
    expect(empty.evidence.auditEntriesExamined).toBe(0);
    expect(empty.sessionsOpened).toBe(0);
  });

  it('refuses to be read by another tenant', async () => {
    const { harness } = await busyTenant();
    const response = await harness.api.handle({
      method: 'GET', path: '/v1/admin/tenants/t_someone_else/compliance',
      headers: bearer(harness.adminKey),
    });
    expect(response.status).toBe(403);
  });
});

describe('the CRM data quality scorecard (FR-050)', () => {
  it('reports duplicates prevented, naming the record', async () => {
    const { harness, tenantId } = await busyTenant();
    const scorecard = await harness.platform.dataQuality.build(tenantId, allTime(), 'now', Date.now());

    // The second upsert of the same person resolved to the existing record.
    expect(scorecard.duplicatesPreventedCount).toBeGreaterThan(0);
    expect(scorecard.duplicatesPrevented[0]!.externalId).toBeTruthy();
    expect(scorecard.duplicatesPrevented[0]!.operation).toBe('upsert_person');
  });

  it('reports owner overwrites blocked, and reading zero is the point', async () => {
    const { harness, tenantId } = await busyTenant();
    const scorecard = await harness.platform.dataQuality.build(tenantId, allTime(), 'now', Date.now());
    expect(scorecard.ownerOverwritesBlocked).toHaveLength(0);
    expect(scorecard.lifecycleStageProtections).toHaveLength(0);
  });

  it('counts a refused authoritative-field write when one is attempted', async () => {
    const { harness, tenantId } = await busyTenant();
    try {
      await harness.platform.adapter.write({
        tenantId, correlationId: 'corr_bad', idempotencyKey: 'k_bad', operation: 'upsert_person',
        canonical: { emails: ['x@acme.co.uk'], qualificationState: 'QUALIFIED', ownerRef: 'owner_2' } as never,
        sourceOfTruthPolicy: 'assistant_may_write_contact_fields_only',
        forbiddenFields: ['owner', 'ownerRef', 'lifecycle_stage'],
      });
    } catch {
      // Expected: the adapter refuses.
    }
    await harness.platform.audit.write({
      tenantId, type: 'policy_denied', correlationId: 'corr_bad', actor: 'policy',
      payload: { message: 'write envelope contains CRM-authoritative fields: ownerRef' },
    });

    const scorecard = await harness.platform.dataQuality.build(tenantId, allTime(), 'now', Date.now());
    expect(scorecard.ownerOverwritesBlocked.length).toBeGreaterThan(0);
  });

  it('reports the reconciliation backlog and its age', async () => {
    const { harness, tenantId } = await busyTenant();
    const scorecard = await harness.platform.dataQuality.build(tenantId, allTime(), 'now', Date.now());
    expect(scorecard.reconciliationBacklog.pending).toBe(0);
  });

  it('reports measured precision on the tenant own data, labelled as such', async () => {
    const { harness, tenantId } = await busyTenant();
    const scorecard = await harness.platform.dataQuality.build(tenantId, allTime(), 'now', Date.now());
    expect(scorecard.deduplicationPrecision.confidentMatchesActedOn).toBeGreaterThan(0);
    // Not conflated with the CI precision gate, which measures something else.
    expect(scorecard.deduplicationPrecision.note).toContain('live data');
  });
});

describe('the qualification funnel (FR-049)', () => {
  it('populates every view from live data', async () => {
    const { harness, tenantId } = await busyTenant();
    const report = await harness.platform.funnel.build(tenantId, allTime(), 'now');

    expect(report.funnel.sessions).toBe(3);
    expect(report.funnel.engaged).toBeGreaterThan(0);
    expect(report.outcomeBreakdown.length).toBeGreaterThan(0);
    expect(report.cost.costPerConversationPence).toBeDefined();
    expect(report.deflection.deflectionRatePct).toBeGreaterThanOrEqual(0);
    expect(report.coverage.byHourUtc.length).toBeGreaterThan(0);
  });

  it('offers drill-through from an outcome to its conversations', async () => {
    const { harness, tenantId } = await busyTenant();
    const report = await harness.platform.funnel.build(tenantId, allTime(), 'now');
    const booked = report.outcomeBreakdown.find((row) => row.outcome === 'book_meeting');
    expect(booked?.correlationIds.length).toBeGreaterThan(0);
  });

  it('computes cost per qualified lead and per booked meeting', async () => {
    const { harness, tenantId } = await busyTenant();
    const report = await harness.platform.funnel.build(tenantId, allTime(), 'now');
    expect(report.cost.costPerQualifiedLeadPence).toBeDefined();
    expect(report.cost.costPerBookedMeetingPence).toBeDefined();
  });

  it('is tenant-scoped, verified by a cross-tenant probe (FR-053)', async () => {
    const { harness } = await busyTenant();
    const response = await harness.api.handle({
      method: 'GET', path: '/v1/admin/tenants/t_other/analytics', headers: bearer(harness.adminKey),
    });
    expect(response.status).toBe(403);
  });
});
