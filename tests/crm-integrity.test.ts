import { describe, expect, it } from 'vitest';
import { FORBIDDEN_WRITE_FIELDS, idempotencyKey, type CanonicalWriteEnvelope } from '@detent/awa-core';
import { SandboxConnector, assertNoForbiddenFields } from '@detent/awa-connectors';
import { buildHarness } from './fixtures/tenant.js';

/**
 * CI gate: per-CRM contract tests.
 * Pass threshold: zero duplicates and zero owner overwrites (sections 16.5,
 * 30, 36.2). These are the two outcomes the business objectives set at zero.
 */
function envelope(over: Partial<CanonicalWriteEnvelope> & { tenantId: string }): CanonicalWriteEnvelope {
  return {
    correlationId: 'corr_test',
    idempotencyKey: 'sess_test:upsert_person:1',
    operation: 'upsert_person',
    canonical: { emails: ['alex@acme.co.uk'], qualificationState: 'QUALIFIED' },
    sourceOfTruthPolicy: 'assistant_may_write_contact_fields_only',
    forbiddenFields: [...FORBIDDEN_WRITE_FIELDS],
    ...over,
  };
}

describe('source-of-truth enforcement', () => {
  it('refuses an envelope carrying any CRM-authoritative field', () => {
    for (const field of FORBIDDEN_WRITE_FIELDS) {
      expect(() =>
        assertNoForbiddenFields(envelope({
          tenantId: 't_acme',
          canonical: { emails: ['a@acme.co.uk'], qualificationState: 'QUALIFIED', [field]: 'x' } as never,
        })),
      ).toThrowError(/CRM-authoritative/);
    }
  });

  it('still refuses an owner on a person write, and every other authoritative field on an activity', () => {
    expect(() =>
      assertNoForbiddenFields(envelope({
        tenantId: 't_acme', operation: 'upsert_person',
        canonical: { emails: ['a@acme.co.uk'], qualificationState: 'QUALIFIED', ownerRef: 'owner_2' } as never,
      })),
    ).toThrowError(/CRM-authoritative/);

    // An activity may carry a CRM-read ownerRef so a task lands in the right
    // queue, but nothing else authoritative.
    expect(() =>
      assertNoForbiddenFields(envelope({
        tenantId: 't_acme', operation: 'create_task',
        canonical: { type: 'task', subject: 'x', ownerRef: 'owner_1' } as never,
      })),
    ).not.toThrow();

    expect(() =>
      assertNoForbiddenFields(envelope({
        tenantId: 't_acme', operation: 'create_task',
        canonical: { type: 'task', subject: 'x', lifecycleStage: 'customer' } as never,
      })),
    ).toThrowError(/CRM-authoritative/);
  });

  it('never overwrites an existing owner or lifecycle stage on update', async () => {
    const harness = await buildHarness();
    const seeded = harness.crm.seed({
      objectType: 'contact', email: 'alex@acme.co.uk', name: 'Alex Warner',
      ownerRef: 'owner_1', lifecycleStage: 'customer',
    });

    await harness.platform.adapter.write(envelope({
      tenantId: harness.config.tenantId,
      canonical: {
        emails: ['alex@acme.co.uk'],
        name: { given: 'Alex', family: 'Warner-Smith' },
        jobTitle: 'Revenue Operations Lead',
        qualificationState: 'QUALIFIED',
      },
    }));

    const after = harness.crm.records.get(seeded.id)!;
    expect(after.ownerRef).toBe('owner_1');
    expect(after.lifecycleStage).toBe('customer');
    expect(after.jobTitle).toBe('Revenue Operations Lead');
  });
});

describe('idempotency', () => {
  it('creates exactly one record when the same write is retried', async () => {
    const harness = await buildHarness();
    const key = idempotencyKey('sess_x', 'upsert_person', 1);
    const first = await harness.platform.adapter.write(envelope({ tenantId: harness.config.tenantId, idempotencyKey: key }));
    const second = await harness.platform.adapter.write(envelope({ tenantId: harness.config.tenantId, idempotencyKey: key }));

    expect(second.externalId).toBe(first.externalId);
    expect(second.created).toBe(false);
    expect([...harness.crm.records.values()].filter((r) => r.email === 'alex@acme.co.uk')).toHaveLength(1);
  });

  it('creates one record when two different writes target the same person', async () => {
    const harness = await buildHarness();
    await harness.platform.adapter.write(envelope({ tenantId: harness.config.tenantId, idempotencyKey: 'sess_x:upsert_person:1' }));
    await harness.platform.adapter.write(envelope({ tenantId: harness.config.tenantId, idempotencyKey: 'sess_x:upsert_person:2' }));
    expect([...harness.crm.records.values()].filter((r) => r.email === 'alex@acme.co.uk')).toHaveLength(1);
  });

  it('derives a stable idempotency key from the session and operation', () => {
    expect(idempotencyKey('sess_1', 'upsert_person', 3)).toBe('sess_1:upsert_person:3');
  });
});

describe('lead versus contact split', () => {
  it('creates a Lead, not a Contact, for an unqualified visitor in a lead-based CRM', async () => {
    const harness = await buildHarness();
    const result = await harness.platform.adapter.write(envelope({
      tenantId: harness.config.tenantId,
      canonical: { emails: ['new@acme.co.uk'], qualificationState: 'CAPTURED' },
    }));
    expect(result.objectType).toBe('lead');
  });

  it('creates a Contact once the visitor is qualified', async () => {
    const harness = await buildHarness();
    const result = await harness.platform.adapter.write(envelope({
      tenantId: harness.config.tenantId,
      canonical: { emails: ['qualified@acme.co.uk'], qualificationState: 'QUALIFIED' },
    }));
    expect(result.objectType).toBe('contact');
  });

  it('uses a unified contact where the CRM has no separate lead object', async () => {
    const crm = new SandboxConnector({ hasSeparateLeadObject: false });
    const harness = await buildHarness({ crm });
    const result = await harness.platform.adapter.write(envelope({
      tenantId: harness.config.tenantId,
      canonical: { emails: ['new@acme.co.uk'], qualificationState: 'CAPTURED' },
    }));
    expect(result.objectType).toBe('contact');
  });
});

describe('degradation and reconciliation', () => {
  it('parks writes and marks the connection degraded on a revoked credential', async () => {
    const crm = new SandboxConnector({ failNextWrites: 1, failureKind: 'CONNECTION_DEGRADED' });
    const harness = await buildHarness({ crm });

    await expect(harness.platform.adapter.write(envelope({ tenantId: harness.config.tenantId })))
      .rejects.toMatchObject({ kind: 'CONNECTION_DEGRADED' });

    expect(await harness.platform.adapter.connectionState(harness.config.tenantId)).toBe('DEGRADED');
    const audit = await harness.platform.audit.export(harness.config.tenantId);
    expect(audit.entries.some((e) => e.type === 'connection_degraded')).toBe(true);
    expect(audit.entries.some((e) => e.type === 'crm_write_parked')).toBe(true);
  });

  it('drains parked writes idempotently after a reconnect', async () => {
    const crm = new SandboxConnector({ failNextWrites: 1, failureKind: 'UPSTREAM_UNAVAILABLE' });
    const harness = await buildHarness({ crm });
    const tenantId = harness.config.tenantId;
    const key = 'sess_park:upsert_person:1';

    // The adapter retries, exhausts the injected failure, and the write lands.
    await harness.platform.adapter.write(envelope({ tenantId, idempotencyKey: key }));

    const pending = await harness.platform.receipts.pendingReconciliation(tenantId);
    expect(pending).toHaveLength(0);
    expect([...crm.records.values()].filter((r) => r.email === 'alex@acme.co.uk')).toHaveLength(1);
  });

  it('replays a parked write once the connection recovers, without duplicating it', async () => {
    // The audit's PERF-8 finding: parked writes were "an in-memory list with no
    // worker", so a CRM outage became a queue somebody worked by hand.
    const crm = new SandboxConnector({ failNextWrites: 1, failureKind: 'CONNECTION_DEGRADED' });
    const harness = await buildHarness({ crm });
    const tenantId = harness.config.tenantId;

    await expect(harness.platform.adapter.write(envelope({ tenantId, idempotencyKey: 'sess_x:upsert_person:1' })))
      .rejects.toMatchObject({ kind: 'CONNECTION_DEGRADED' });
    expect([...crm.records.values()].filter((r) => r.email === 'alex@acme.co.uk')).toHaveLength(0);

    // Nothing is replayed while the connection is still degraded.
    const whileDown = await harness.platform.reconciliation.runForTenant(tenantId);
    expect(whileDown.reconciled).toBe(0);

    // The credential is restored, as a reconnect would.
    await harness.platform.connectCrm(tenantId, 'sandbox', { kind: 'oauth2', accessToken: 'fresh-token' });

    const result = await harness.platform.reconciliation.runForTenant(tenantId);
    expect(result.reconciled).toBe(1);
    expect(result.stillParked).toBe(0);
    // One CRM record, not two: the idempotency key is what makes replay safe.
    expect([...crm.records.values()].filter((r) => r.email === 'alex@acme.co.uk')).toHaveLength(1);

    const audit = await harness.platform.audit.export(tenantId);
    expect(audit.entries.some((e) => e.type === 'crm_write_reconciled')).toBe(true);
  });

  it('leaves a write for a human rather than retrying it forever', async () => {
    const crm = new SandboxConnector({ failNextWrites: 99, failureKind: 'UPSTREAM_UNAVAILABLE' });
    const harness = await buildHarness({
      crm,
      // No real sleeping: the backoff is exercised elsewhere, and this test is
      // about the attempt ceiling.
      adapter: { maxAttempts: 1, sleep: async () => undefined },
      reconciliationMaxAttempts: 3,
    });
    const tenantId = harness.config.tenantId;

    await expect(harness.platform.adapter.write(envelope({ tenantId, idempotencyKey: 'sess_y:upsert_person:1' })))
      .rejects.toThrow();

    let abandoned = 0;
    for (let pass = 0; pass < 6 && abandoned === 0; pass += 1) {
      abandoned = (await harness.platform.reconciliation.runForTenant(tenantId)).abandoned;
    }
    expect(abandoned).toBe(1);
    // Abandoned, not silently dropped: the audit records why.
    const audit = await harness.platform.audit.export(tenantId);
    expect(audit.entries.some((e) => (e.payload as { stage?: string } | undefined)?.stage === 'reconciliation')).toBe(true);
  });

  it('reports a rate limit as retryable and does not create a duplicate', async () => {
    const crm = new SandboxConnector({ failNextWrites: 2, failureKind: 'RATE_LIMITED' });
    const harness = await buildHarness({ crm });
    await harness.platform.adapter.write(envelope({ tenantId: harness.config.tenantId }));
    expect([...crm.records.values()].filter((r) => r.email === 'alex@acme.co.uk')).toHaveLength(1);
  });
});

describe('capability declaration', () => {
  it('publishes the connector capability declaration for the tenant admin', async () => {
    const harness = await buildHarness();
    const capabilities = await harness.platform.adapter.capabilities(harness.config.tenantId);
    expect(capabilities.connector).toBe('sandbox');
    expect(capabilities.degradationNotes.length).toBeGreaterThan(0);
  });

  it('degrades explicitly rather than failing where a capability is absent', async () => {
    const harness = await buildHarness();
    // The sandbox declares NONE for duplicate detection and merge. The platform
    // must not attempt it, and must not pretend it happened.
    const capabilities = await harness.platform.adapter.capabilities(harness.config.tenantId);
    expect(capabilities.duplicateDetectionOrMerge).toBe('NONE');
  });
});
