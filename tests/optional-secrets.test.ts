/**
 * An optional secret that is wrong disables its own feature and nothing else.
 *
 * This is the rule the rest of the platform already followed, written down
 * after it was broken once. `DETENT_CREDENTIAL_KEY` was treated as a refusal
 * when malformed, on the reasoning that somebody who set it meant credentials
 * to be encrypted and carrying on quietly would be the opposite of what they
 * asked for. The reasoning was right and the consequence was wrong: one
 * mistyped secret took down the marketing site, the customer app and the
 * console, none of which need that key at all.
 *
 * The mistake itself is worth keeping in a test, because it is the mistake
 * anybody would make. Base64 decoding ignores every character that is not
 * base64, so pasting the command instead of its output decodes to fifteen bytes
 * rather than failing, and a message reading "must be 32 bytes, this one
 * decodes to 15" describes a symptom while hiding the cause. It sent somebody
 * looking for a truncated key twice.
 */
import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { FixedClock } from '@detent/awa-core';
import { credentialKeyProblem } from '@detent/awa-persistence';
import { SESSION_SECRET_MINIMUM, buildDevSites } from '../packages/server/src/dev-sites.js';

describe('the credential key', () => {
  it('accepts what openssl rand -base64 32 actually prints', () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect(credentialKeyProblem(randomBytes(32).toString('base64'))).toBeUndefined();
    }
  });

  it('forgives surrounding whitespace, which a paste often carries', () => {
    expect(credentialKeyProblem(`  ${randomBytes(32).toString('base64')}\n`)).toBeUndefined();
  });

  it('recognises the command pasted instead of its output', () => {
    // The exact mistake, and the exact string. It decodes to 15 bytes rather
    // than failing, which is why the old message was unhelpful.
    const pasted = 'openssl rand -base64 32';
    expect(Buffer.from(pasted, 'base64')).toHaveLength(15);
    expect(credentialKeyProblem(pasted)).toMatch(/command rather than its output/i);
  });

  it('says how long it should be for anything else that is wrong', () => {
    expect(credentialKeyProblem('too-short')).toMatch(/44 characters/);
    expect(credentialKeyProblem(randomBytes(16).toString('base64'))).toMatch(/44 characters/);
    expect(credentialKeyProblem(randomBytes(64).toString('base64'))).toMatch(/44 characters/);
    expect(credentialKeyProblem('')).toMatch(/empty/i);
  });

  it('refuses a key that decodes to the right length by accident', () => {
    // 32 bytes decoded from a string that is not 44 characters of base64. The
    // decoder forgives it; this must not, or a key with less entropy than it
    // appears to have gets used to encrypt somebody's Salesforce token.
    const forgiving = `${randomBytes(32).toString('base64')} and some words`;
    expect(Buffer.from(forgiving, 'base64').length).toBeGreaterThanOrEqual(32);
    expect(credentialKeyProblem(forgiving)).toBeDefined();
  });
});


/**
 * The rule, applied to every optional secret rather than to the one that bit.
 *
 * The credential key was fixed and the session secret was not, so the same
 * fault stopped the same application one release later: a value too short to
 * sign a cookie took down the marketing site, which has no sessions and needs
 * no secret. Fixing an instance and not the class is how a thing happens twice.
 *
 * Every case below is a secret that is set and unusable. Each must build, and
 * each must refuse to use the bad value.
 */
describe('a secret that is set and unusable', () => {
  const base = () => ({
    audit: new AuditLog(new InMemoryAuditStore()),
    clock: new FixedClock(new Date('2026-09-06T09:00:00.000Z')),
  });

  it('does not stop the application, whatever is wrong with it', async () => {
    for (const sessionSecret of ['', 'short', 'still-far-too-short-to-sign', ' '.repeat(40)]) {
      const sites = await buildDevSites({ ...base(), sessionSecret });
      // Built, serving, and every surface present.
      expect(sites.consoleRouter, JSON.stringify(sessionSecret)).toBeDefined();
      expect(sites.appRouter).toBeDefined();
      expect(await sites.marketing('/')).toBeDefined();
    }
  });

  it('never uses a session secret that is too short to sign with', async () => {
    const sites = await buildDevSites({ ...base(), sessionSecret: 'short' });
    // A generated secret is used instead, so sessions work now and are lost at
    // the next restart. Reported rather than silent.
    expect(sites.sessionsPersist).toBe(false);
  });

  it('keeps a good one, so sessions survive a restart', async () => {
    const sites = await buildDevSites({
      ...base(), sessionSecret: randomBytes(32).toString('hex'),
    });
    expect(sites.sessionsPersist).toBe(true);
  });

  it('agrees with the minimum it tells people about', () => {
    // The check and the message that explains it drifting apart is how somebody
    // reads "at least 32" while the code wants something else.
    expect(SESSION_SECRET_MINIMUM).toBe(32);
    expect(randomBytes(32).toString('hex').length).toBeGreaterThanOrEqual(SESSION_SECRET_MINIMUM);
    expect(randomBytes(32).toString('base64').length).toBeGreaterThanOrEqual(SESSION_SECRET_MINIMUM);
  });

  it('accepts what tools/make-secret.mjs prints, for both of them', async () => {
    const { execFileSync } = await import('node:child_process');
    const run = (kind: string) =>
      execFileSync(process.execPath, ['tools/make-secret.mjs', kind]).toString().trim();

    expect(credentialKeyProblem(run('credential'))).toBeUndefined();
    expect(run('session').length).toBeGreaterThanOrEqual(SESSION_SECRET_MINIMUM);
    // The tool prints the value and nothing else. Anything around it is
    // something a person can select by mistake.
    expect(run('credential')).not.toMatch(/\s/);
    expect(run('session')).not.toMatch(/\s/);
  });
});
