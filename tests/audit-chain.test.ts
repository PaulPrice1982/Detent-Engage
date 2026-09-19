import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore, canonicalJson } from '@detent/awa-audit';
import { FixedClock } from '@detent/awa-core';
import { buildHarness } from './fixtures/tenant.js';

/**
 * The audit log is the evidence the governance claim rests on. If it can be
 * edited without detection, every other control in this system is an assertion
 * rather than a fact (sections 29, 33.4).
 */
describe('hash-chained audit log', () => {
  it('verifies a well-formed chain', async () => {
    const store = new InMemoryAuditStore();
    const log = new AuditLog(store, new FixedClock(new Date('2026-09-04T09:00:00Z')));
    for (let i = 0; i < 20; i++) {
      await log.write({ tenantId: 't1', type: 'tool_call_executed', correlationId: `c${i}`, actor: 'system' });
    }
    expect((await log.verify('t1')).valid).toBe(true);
  });

  it('detects an edited entry', async () => {
    const store = new InMemoryAuditStore();
    const log = new AuditLog(store);
    await log.write({ tenantId: 't1', type: 'consent_recorded', correlationId: 'c1', actor: 'visitor' });
    await log.write({ tenantId: 't1', type: 'tool_call_executed', correlationId: 'c2', actor: 'system' });
    await log.write({ tenantId: 't1', type: 'tool_call_executed', correlationId: 'c3', actor: 'system' });

    const entries = await store.list('t1');
    // Tamper directly with the store, bypassing the log entirely.
    (entries[1] as { type: string }).type = 'policy_allowed';

    const verification = await log.verify('t1');
    expect(verification.valid).toBe(false);
    expect(verification.brokenAtSequence).toBe(2);
    expect(verification.reason).toBe('entry content altered');
  });

  it('detects a deleted entry', async () => {
    const store = new InMemoryAuditStore();
    const log = new AuditLog(store);
    for (let i = 0; i < 4; i++) {
      await log.write({ tenantId: 't1', type: 'tool_call_executed', correlationId: `c${i}`, actor: 'system' });
    }
    const entries = await store.list('t1');
    entries.splice(1, 1);
    // Re-seed the store with the truncated list.
    const tampered = new InMemoryAuditStore();
    for (const entry of entries) await tampered.append(entry);

    expect((await new AuditLog(tampered).verify('t1')).valid).toBe(false);
  });

  it('serialises concurrent appends so the chain cannot fork', async () => {
    const store = new InMemoryAuditStore();
    const log = new AuditLog(store);
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        log.write({ tenantId: 't1', type: 'tool_call_executed', correlationId: `c${i}`, actor: 'system' }),
      ),
    );
    const verification = await log.verify('t1');
    expect(verification.valid).toBe(true);
    expect(verification.checked).toBe(50);
  });

  it('canonicalises payloads so key order does not change the hash', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('redacts personal data in payloads before they are stored', async () => {
    const store = new InMemoryAuditStore();
    const log = new AuditLog(store);
    await log.write({
      tenantId: 't1', type: 'tool_call_executed', correlationId: 'c1', actor: 'system',
      payload: { note: 'Contact alex.warner@acme.co.uk on 07700 900123', access_token: 'super-secret' },
    });
    const [entry] = await store.list('t1');
    const serialised = JSON.stringify(entry);
    expect(serialised).not.toContain('alex.warner@acme.co.uk');
    expect(serialised).not.toContain('super-secret');
    expect(serialised).toContain('[redacted:email]');
  });

  it('replays a whole conversation from its correlation id', async () => {
    const harness = await buildHarness({ script: [{ match: /.*/, output: { text: 'Happy to help.' } }] });
    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    await harness.platform.orchestrator.run({
      session, config: harness.platform.effectiveConfig(session.tenantId), visitorInput: 'hello',
    });

    const replay = await harness.platform.audit.replay(session.tenantId, session.correlationId);
    expect(replay.length).toBeGreaterThan(1);
    // Replayability means the version pins travel with the entries.
    const withVersions = replay.find((entry) => entry.versions?.policy);
    expect(withVersions?.versions?.policy).toBe(harness.config.policyVersion);
    expect(replay.every((entry, index) => index === 0 || entry.sequence > replay[index - 1]!.sequence)).toBe(true);
  });
});
