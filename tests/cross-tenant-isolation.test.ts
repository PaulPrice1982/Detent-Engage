import { describe, expect, it } from 'vitest';
import { SandboxConnector } from '@detent/awa-connectors';
import { buildHarness, bearer } from './fixtures/tenant.js';

/**
 * CI gate: cross-tenant isolation.
 * Pass threshold: zero leakage incidents. No tolerance (section 30, table 41).
 * A failure here trips the platform kill switch and is a P1 security incident.
 */
describe('cross-tenant isolation', () => {
  it('never returns another tenant knowledge from retrieval', async () => {
    const harness = await buildHarness({ tenantId: 't_alpha' });
    const other = harness.platform.corpus.ingest({
      tenantId: 't_beta',
      sourceKind: 'faq',
      sourceRef: 'beta/secret',
      title: 'Beta confidential pricing',
      text: 'Beta Ltd charges £99000 for the enterprise programme and its largest client is Northwind.',
      shipped: true,
    });
    harness.platform.corpus.publish('t_beta', other.id, 'beta-admin');

    // The exact query terms of the other tenant's content.
    const results = harness.platform.retrieval.retrieve('t_alpha', 'Beta confidential pricing Northwind enterprise programme');
    expect(results).toHaveLength(0);

    const betaResults = harness.platform.retrieval.retrieve('t_beta', 'enterprise programme');
    expect(betaResults.length).toBeGreaterThan(0);
  });

  it('refuses an admin API call addressed at another tenant', async () => {
    const harness = await buildHarness({ tenantId: 't_alpha' });
    const response = await harness.api.handle({
      method: 'GET', path: '/v1/admin/tenants/t_beta', headers: bearer(harness.adminKey),
    });
    expect(response.status).toBe(403);
    expect((response.body as { error: string }).error).toBe('POLICY_DENIED');
  });

  it('refuses to post a message into another tenant session', async () => {
    const alpha = await buildHarness({ tenantId: 't_alpha' });
    const beta = await buildHarness({ tenantId: 't_beta' });

    const betaSession = await beta.platform.openSession('t_beta', 'UK');
    // Alpha's key, Beta's session id, on Alpha's API. Denied at the
    // authorisation layer before any handler logic runs.
    const response = await alpha.api.handle({
      method: 'POST', path: `/v1/sessions/${betaSession.id}/messages`,
      headers: bearer(alpha.widgetKey), body: { text: 'hello' },
    });
    expect(response.status).toBe(404);
  });

  it('keeps audit chains separate, so one tenant export reveals nothing about another', async () => {
    const harness = await buildHarness({ tenantId: 't_alpha' });
    await harness.platform.audit.write({
      tenantId: 't_beta', type: 'session_opened', correlationId: 'corr_beta', actor: 'system',
    });
    await harness.platform.audit.write({
      tenantId: 't_alpha', type: 'session_opened', correlationId: 'corr_alpha', actor: 'system',
    });

    const alphaExport = await harness.platform.audit.export('t_alpha');
    expect(alphaExport.entries.every((entry) => entry.tenantId === 't_alpha')).toBe(true);
    expect(alphaExport.verification.valid).toBe(true);
  });

  it('does not let one tenant CRM connection serve another tenant', async () => {
    const crm = new SandboxConnector();
    const harness = await buildHarness({ tenantId: 't_alpha', crm });
    crm.seed({ objectType: 'contact', email: 'alex@acme.co.uk', name: 'Alex Warner' });

    // t_beta has no connection at all in this platform instance.
    await expect(harness.platform.adapter.searchPerson('t_beta', { email: 'alex@acme.co.uk' }))
      .rejects.toMatchObject({ kind: 'TENANT_NOT_FOUND' });
  });

  it('scopes metering and spend caps per tenant', async () => {
    const harness = await buildHarness({ tenantId: 't_alpha' });
    await harness.platform.metering.record('t_alpha', 'voice_minute', 10);
    const alpha = await harness.platform.metering.usage('t_alpha');
    const beta = await harness.platform.metering.usage('t_beta');
    expect(alpha.voiceMinutes).toBe(10);
    expect(beta.voiceMinutes).toBe(0);
  });
});
