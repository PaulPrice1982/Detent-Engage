import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { ChangeEventProcessor, type ChangeEvent } from '@detent/awa-server';
import { buildHarness, bearer } from './fixtures/tenant.js';

/**
 * CI gate: webhook replay and ordering — 100% idempotent under replay,
 * duplication and reordering (FR-020, sections 22.4, 30).
 */
function event(over: Partial<ChangeEvent> = {}): ChangeEvent {
  return {
    event_id: 'evt_1', tenant_id: 't_acme', connector: 'hubspot',
    object_type: 'person', external_id: '551', change_type: 'property_changed',
    source_version: '2026-09-04T09:14:22.113Z', attempt: 1, ...over,
  };
}

describe('change event processing', () => {
  it('rejects an event whose signature does not verify', async () => {
    const harness = await buildHarness();
    const processor = new ChangeEventProcessor(harness.platform.audit);
    expect(await processor.process(event(), { signatureVerified: false })).toBe('rejected_signature');
  });

  it('verifies a genuine signature and rejects a forged one', async () => {
    const harness = await buildHarness();
    const processor = new ChangeEventProcessor(harness.platform.audit);
    const body = JSON.stringify(event());
    const signature = createHmac('sha256', 'shared-secret').update(body).digest('hex');

    expect(processor.verifySignature('shared-secret', body, signature)).toBe(true);
    expect(processor.verifySignature('shared-secret', body, 'deadbeef')).toBe(false);
    expect(processor.verifySignature('wrong-secret', body, signature)).toBe(false);
  });

  it('is idempotent under replay of the same delivery', async () => {
    const harness = await buildHarness();
    const processor = new ChangeEventProcessor(harness.platform.audit);
    expect(await processor.process(event(), { signatureVerified: true })).toBe('applied');
    expect(await processor.process(event(), { signatureVerified: true })).toBe('duplicate');
  });

  it('treats a redelivery attempt as a new dedup key but discards it as out of order', async () => {
    const harness = await buildHarness();
    const processor = new ChangeEventProcessor(harness.platform.audit);
    await processor.process(event({ attempt: 1 }), { signatureVerified: true });
    // Same event, vendor retry: the dedup key differs but the version does not
    // advance, so the change is not applied twice.
    expect(await processor.process(event({ attempt: 2 }), { signatureVerified: true })).toBe('out_of_order');
  });

  it('discards an out-of-order event rather than applying stale state', async () => {
    const harness = await buildHarness();
    const processor = new ChangeEventProcessor(harness.platform.audit);
    await processor.process(event({ event_id: 'evt_new', source_version: '2026-09-04T10:00:00.000Z' }), { signatureVerified: true });
    expect(await processor.process(event({ event_id: 'evt_old', source_version: '2026-09-04T09:00:00.000Z' }), { signatureVerified: true }))
      .toBe('out_of_order');
  });

  it('remaps identifiers after a merge rather than assuming they are stable', async () => {
    const harness = await buildHarness();
    const processor = new ChangeEventProcessor(harness.platform.audit);
    await processor.process(event({ event_id: 'evt_m', change_type: 'merged', merged_into: '900', source_version: '2026-09-04T11:00:00.000Z' }), { signatureVerified: true });
    expect(processor.resolveIdentifier('t_acme', '551')).toBe('900');
  });

  it('follows a chain of merges without looping on cyclic vendor data', async () => {
    const harness = await buildHarness();
    const processor = new ChangeEventProcessor(harness.platform.audit);
    processor.identifierRemap.set('t_acme:a', 'b');
    processor.identifierRemap.set('t_acme:b', 'c');
    processor.identifierRemap.set('t_acme:c', 'a');
    expect(['a', 'b', 'c']).toContain(processor.resolveIdentifier('t_acme', 'a'));
  });

  it('rejects an unsigned webhook at the API boundary with 401', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({
      method: 'POST', path: '/v1/webhooks/hubspot', headers: {},
      body: event(), rawBody: JSON.stringify(event()),
    });
    expect(response.status).toBe(401);
  });

  it('accepts a correctly signed webhook at the API boundary', async () => {
    const harness = await buildHarness();
    harness.api.setWebhookSecret('hubspot', 'shared-secret');
    const rawBody = JSON.stringify(event());
    const response = await harness.api.handle({
      method: 'POST', path: '/v1/webhooks/hubspot',
      headers: { 'x-signature': createHmac('sha256', 'shared-secret').update(rawBody).digest('hex') },
      body: JSON.parse(rawBody), rawBody,
    });
    expect(response.status).toBe(202);
    expect((response.body as { outcome: string }).outcome).toBe('applied');
  });
});

/**
 * Tenant lifecycle gates (section 23.4): no CRM connection before a DPA record
 * exists, and no live traffic before a field-mapping dry run has been accepted.
 */
describe('tenant lifecycle gates', () => {
  it('refuses to connect a CRM before a DPA record exists', async () => {
    const harness = await buildHarness();
    harness.platform.tenants.create({ tenantId: 't_new', name: 'New Ltd', connector: 'sandbox' });
    // The lifecycle methods are async now that the audit append is awaited
    // before the state changes, rather than fired and forgotten (audit SEC-10).
    await expect(harness.platform.tenants.transition('t_new', 'CRM_CONNECTED', 'tenant'))
      .rejects.toThrowError(/illegal tenant transition/);
  });

  it('refuses to go live before the field mapping is accepted', async () => {
    const harness = await buildHarness();
    harness.platform.tenants.create({ tenantId: 't_new', name: 'New Ltd', connector: 'sandbox' });
    await harness.platform.tenants.recordDpa('t_new', 'DPA-2');
    await harness.platform.tenants.transition('t_new', 'CRM_CONNECTED', 'tenant');
    await harness.platform.tenants.transition('t_new', 'MAPPED', 'tenant');
    await harness.platform.tenants.transition('t_new', 'TEST_MODE', 'tenant');

    await expect(harness.platform.tenants.transition('t_new', 'LIVE', 'tenant'))
      .rejects.toThrowError(/field-mapping dry run/);

    harness.platform.tenants.acceptFieldMapping('t_new');
    expect((await harness.platform.tenants.transition('t_new', 'LIVE', 'tenant')).state).toBe('LIVE');
  });

  it('increments the config version on every change so a turn can be replayed', async () => {
    const harness = await buildHarness();
    const before = harness.platform.tenants.get(harness.config.tenantId).version;
    await harness.platform.tenants.update(harness.config.tenantId, { serviceCatalogue: ['a'] }, 'tenant_admin');
    expect(harness.platform.tenants.get(harness.config.tenantId).version).toBe(before + 1);
  });

  it('does not allow state to be changed through the config update path', async () => {
    const harness = await buildHarness();
    await expect(harness.platform.tenants.update(harness.config.tenantId, { state: 'SUSPENDED' }, 'platform_admin'))
      .rejects.toThrowError(/state/);
  });

  it('exposes a verifiable audit export to the tenant admin', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({
      method: 'GET', path: `/v1/admin/tenants/${harness.config.tenantId}/audit`,
      headers: bearer(harness.adminKey),
    });
    const body = response.body as { verification: { valid: boolean }; entries: unknown[] };
    expect(response.status).toBe(200);
    expect(body.verification.valid).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
  });
});
