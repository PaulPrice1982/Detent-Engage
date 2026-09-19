import { describe, expect, it } from 'vitest';
import { Keyring, LocalKeyProvider, isSealedValue } from '@detent/awa-core';
import { EncryptedConnectionStore, InMemorySealedConnectionStore } from '@detent/awa-connectors';

/**
 * CI gate: credentials at rest (audit SEC-4).
 * Pass threshold: no plaintext credential is ever written to a store, a
 * ciphertext is bound to its tenant, and rotation rewrites ciphertext without
 * the plaintext leaving the process.
 */
const keyringFor = () => new Keyring(new LocalKeyProvider(LocalKeyProvider.generateRootKey(), 'test-root'));

describe('credential envelope encryption', () => {
  it('never writes a plaintext token to the store', async () => {
    const sealed = new InMemorySealedConnectionStore();
    const store = new EncryptedConnectionStore(keyringFor(), sealed);

    await store.put({
      tenantId: 't_a',
      connector: 'hubspot',
      state: 'CONNECTED',
      credential: { kind: 'oauth2', accessToken: 'pat-na1-SECRET-TOKEN', refreshToken: 'refresh-SECRET' },
    });

    const raw = JSON.stringify(await sealed.get('t_a'));
    expect(raw).not.toContain('pat-na1-SECRET-TOKEN');
    expect(raw).not.toContain('refresh-SECRET');
    expect(isSealedValue((await sealed.get('t_a'))!.sealed)).toBe(true);
  });

  it('returns the credential intact on read', async () => {
    const store = new EncryptedConnectionStore(keyringFor());
    await store.put({
      tenantId: 't_a',
      connector: 'salesforce',
      state: 'CONNECTED',
      credential: {
        kind: 'oauth2', accessToken: 'token-1', refreshToken: 'refresh-1',
        instanceUrl: 'https://acme.my.salesforce.com',
      },
    });

    const connection = await store.get('t_a');
    expect(connection?.credential.accessToken).toBe('token-1');
    expect(connection?.credential.refreshToken).toBe('refresh-1');
    // Non-secret metadata stays readable, so an operator can see which CRM a
    // tenant is on without holding a key.
    expect(connection?.credential.instanceUrl).toBe('https://acme.my.salesforce.com');
  });

  it('will not decrypt a ciphertext moved to another tenant', async () => {
    const sealed = new InMemorySealedConnectionStore();
    const store = new EncryptedConnectionStore(keyringFor(), sealed);
    await store.put({
      tenantId: 't_a', connector: 'hubspot', state: 'CONNECTED',
      credential: { kind: 'oauth2', accessToken: 'token-a' },
    });

    // An attacker with database write access copies the row to another tenant.
    const stolen = (await sealed.get('t_a'))!;
    await sealed.put({ ...stolen, tenantId: 't_b' });

    // The tenant id is authenticated as additional data, so the move makes the
    // value undecryptable rather than readable.
    await expect(store.get('t_b')).rejects.toThrow();
  });

  it('does not let one tenant key open another tenant value', async () => {
    const provider = new LocalKeyProvider(LocalKeyProvider.generateRootKey());
    const keyring = new Keyring(provider);
    const value = await keyring.seal('t_a', 'secret');
    await expect(keyring.open('t_b', value)).rejects.toThrow();
  });

  it('rewraps every stored credential on rotation without changing the plaintext', async () => {
    const sealed = new InMemorySealedConnectionStore();
    const store = new EncryptedConnectionStore(keyringFor(), sealed);
    for (const tenantId of ['t_a', 't_b', 't_c']) {
      await store.put({
        tenantId, connector: 'hubspot', state: 'CONNECTED',
        credential: { kind: 'oauth2', accessToken: `token-${tenantId}` },
      });
    }
    const before = (await sealed.get('t_a'))!.sealed.ciphertext;

    const result = await store.rotateKeys();
    expect(result.rewrapped).toBe(3);
    expect(result.failed).toEqual([]);

    const after = (await sealed.get('t_a'))!.sealed;
    expect(after.ciphertext).not.toBe(before);
    expect((await store.get('t_a'))?.credential.accessToken).toBe('token-t_a');
  });

  it('replaces a credential after a refresh, keeping the connector', async () => {
    const store = new EncryptedConnectionStore(keyringFor());
    await store.put({
      tenantId: 't_a', connector: 'pipedrive', state: 'DEGRADED',
      credential: { kind: 'oauth2', accessToken: 'expired', refreshToken: 'r1' },
    });

    await store.refresh('t_a', { kind: 'oauth2', accessToken: 'fresh', refreshToken: 'r2' });

    const connection = await store.get('t_a');
    expect(connection?.credential.accessToken).toBe('fresh');
    expect(connection?.connector).toBe('pipedrive');
    expect(connection?.state).toBe('CONNECTED');
  });

  it('refuses a root key that is too short to be worth using', () => {
    expect(() => new LocalKeyProvider('short')).toThrowError(/at least 32 bytes/);
  });
});
