import { describe, expect, it } from 'vitest';
import { FixedClock } from '@detent/awa-core';
import { ScriptedModelProvider } from '@detent/awa-agent';
import { ApiKeyService, Platform } from '@detent/awa-server';
import { CustomerWidgetProvisioner } from '../packages/server/src/customer-widgets.js';
import { DurableRuntime, type RuntimeArchive, type RuntimeSnapshot } from '../packages/server/src/runtime-state.js';

class Archive implements RuntimeArchive {
  state?: RuntimeSnapshot;
  fail = false;
  async load() { return structuredClone(this.state); }
  async save(state: RuntimeSnapshot) {
    if (this.fail) throw new Error('database unavailable');
    this.state = structuredClone(state);
  }
}

function boot(archive: RuntimeArchive, clock = new FixedClock(new Date('2026-09-30T12:00:00Z'))) {
  const platform = new Platform({ model: new ScriptedModelProvider(), clock });
  const keys = new ApiKeyService(() => clock.now());
  const widgets = new CustomerWidgetProvisioner(platform.tenants, keys);
  const runtime = new DurableRuntime(archive, platform, keys, widgets);
  return { platform, keys, widgets, runtime, clock };
}
const account = { accountId: 'acc_restart', tenantId: 't_restart', name: 'Restart' };

describe('durable runtime request boundary', () => {
  it('restores tenant settings, widget ownership, keys, sessions and kill switches on a fresh instance', async () => {
    const archive = new Archive();
    const first = boot(archive);
    let key = '';
    let sessionId = '';
    await first.runtime.run(async () => {
      key = first.widgets.provision(account);
      await first.platform.tenants.applyOperatorPatch(account.tenantId, { origins: ['https://example.com'], killSwitch: 'TEXT_ONLY' }, 'test');
      const session = first.platform.sessions.open(first.platform.tenants.get(account.tenantId), 'UK');
      sessionId = session.id;
      first.platform.sessions.record(session, 'visitor', 'Remember this conversation');
      session.writeSequence = 4;
      first.platform.platformKillSwitch = 'TEXT_ONLY';
    });
    const second = boot(archive);
    await second.runtime.restore();
    expect(second.widgets.provision(account)).toBe(key);
    expect(second.keys.authenticate(key).tenantId).toBe(account.tenantId);
    expect(second.platform.tenants.get(account.tenantId).origins).toEqual(['https://example.com']);
    expect(second.platform.tenants.get(account.tenantId).killSwitch).toBe('TEXT_ONLY');
    expect(second.platform.platformKillSwitch).toBe('TEXT_ONLY');
    expect(second.platform.sessions.get(sessionId)!.history[0]!.text).toBe('Remember this conversation');
    expect(second.platform.sessions.get(sessionId)!.writeSequence).toBe(4);
    expect(() => second.widgets.provision({ ...account, accountId: 'other' })).toThrow();
  });

  it('preserves revoked keys and expiry deadlines rather than reissuing them', async () => {
    const archive = new Archive();
    const first = boot(archive);
    const key = first.widgets.provision(account);
    const temporary = first.keys.issue(account.tenantId, 'tenant_admin', { ttlMs: 1000 });
    await first.runtime.run(async () => { first.keys.revoke(first.keys.authenticate(key).keyId); });
    first.clock.advance(2000);
    const second = boot(archive, first.clock);
    await second.runtime.restore();
    expect(() => second.keys.authenticate(key)).toThrow();
    expect(() => second.keys.authenticate(temporary.key)).toThrow();
    expect(() => second.widgets.provision(account)).toThrow();
  });

  it('does not revive expired conversations after a restart', async () => {
    const archive = new Archive();
    const first = boot(archive);
    first.widgets.provision(account);
    const session = first.platform.sessions.open(first.platform.tenants.get(account.tenantId), 'UK');
    await first.runtime.flush();
    first.clock.advance(31 * 60 * 1000);
    const second = boot(archive, first.clock);
    await second.runtime.restore();
    expect(second.platform.sessions.get(session.id)).toBeUndefined();
  });

  it('refuses a success response and all subsequent work after a persistence failure', async () => {
    const archive = new Archive();
    const first = boot(archive);
    archive.fail = true;
    await expect(first.runtime.run(async () => first.widgets.provision(account))).rejects.toThrow('database unavailable');
    expect(first.runtime.ready).toBe(false);
    archive.fail = false;
    let ran = false;
    await expect(first.runtime.run(async () => { ran = true; })).rejects.toThrow('restart required');
    expect(ran).toBe(false);
    expect(archive.state).toBeUndefined();
  });

  it('finishes and commits streamed work before exposing any SSE events', async () => {
    const archive = new Archive();
    const first = boot(archive);
    const response = await first.runtime.api(async () => ({ status: 200, body: {}, stream: (async function* () {
      first.widgets.provision(account);
      yield { event: 'sentence', data: { text: 'Approved.' } };
      first.platform.platformKillSwitch = 'TEXT_ONLY';
      yield { event: 'done', data: { text: 'Approved.' } };
    })() }));
    expect(archive.state!.killSwitch).toBe('TEXT_ONLY');
    const events = [];
    for await (const event of response.stream!) events.push(event);
    expect(events.length).toBe(2);
  });

  it('serialises requests so the next request cannot observe an uncommitted mutation', async () => {
    const archive = new Archive();
    const first = boot(archive);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const one = first.runtime.run(async () => { first.widgets.provision(account); await gate; });
    const two = first.runtime.run(async () => { expect(archive.state!.tenants[0]!.tenantId).toBe(account.tenantId); });
    release();
    await Promise.all([one, two]);
  });
});
