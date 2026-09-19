/**
 * What a deployment is required to have before it serves.
 *
 * The rule these hold: a development machine may run the whole platform on
 * in-memory stores, and a deployment may not. In-memory stores lose the audit
 * chain, the consent evidence and the spend counters at every restart, so a
 * deployment that falls back to them is a product that tells a customer their
 * consent was recorded and then forgets.
 */
import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_MODELS, bootEnvironmentFrom, configurationProblems, databaseProblem,
} from '../packages/server/src/boot-config.js';

const complete = {
  DETENT_DEPLOYED: 'true',
  DATABASE_URL: 'postgres://user:secret@db.internal:5432/detent',
  AWA_ROOT_KEY: 'a'.repeat(64),
  AWA_CHECKPOINT_KEY: 'b'.repeat(64),
  ANTHROPIC_API_KEY: 'sk-test',
  AWA_ORIGINS: 'https://www.example.test',
  AWA_MODEL: 'claude-sonnet-5',
};

describe('deciding whether this is a deployment', () => {
  it('treats a bare development machine as development', () => {
    expect(bootEnvironmentFrom({}).deployed).toBe(false);
  });

  it('accepts any of the three markers a host might set', () => {
    // A container that sets only its own platform's variable is still a
    // deployment. Recognising one marker and not another is how a production
    // deployment comes up in development mode and nobody notices.
    expect(bootEnvironmentFrom({ DETENT_DEPLOYED: 'true' }).deployed).toBe(true);
    expect(bootEnvironmentFrom({ REPLIT_DEPLOYMENT: '1' }).deployed).toBe(true);
    expect(bootEnvironmentFrom({ NODE_ENV: 'production' }).deployed).toBe(true);
  });
});

describe('what a deployment must have', () => {
  it('is content when everything is present', () => {
    expect(configurationProblems(bootEnvironmentFrom(complete))).toEqual([]);
  });

  it('says nothing about a development machine', () => {
    expect(configurationProblems(bootEnvironmentFrom({}))).toEqual([]);
  });

  it('reports every problem at once, not the first', () => {
    // An operator who fixes one missing variable, redeploys and is told about
    // the next has to redeploy as many times as there are problems, and each
    // round is minutes of a site being down.
    const problems = configurationProblems(bootEnvironmentFrom({ DETENT_DEPLOYED: 'true' }));
    expect(problems.length).toBeGreaterThanOrEqual(5);
    expect(problems.join('\n')).toMatch(/DATABASE_URL/);
    expect(problems.join('\n')).toMatch(/AWA_ROOT_KEY/);
    expect(problems.join('\n')).toMatch(/AWA_CHECKPOINT_KEY/);
    expect(problems.join('\n')).toMatch(/ANTHROPIC_API_KEY/);
    expect(problems.join('\n')).toMatch(/AWA_ORIGINS/);
  });

  it('refuses a model id this release has not been verified against', () => {
    const problems = configurationProblems(
      bootEnvironmentFrom({ ...complete, AWA_MODEL: 'claude-something-retired' }),
    );
    expect(problems.join(' ')).toMatch(/has not been verified against/);
    // And it says which ones would work, rather than only that this one does not.
    for (const model of SUPPORTED_MODELS) expect(problems.join(' ')).toContain(model);
  });

  it('requires the model to be named rather than defaulted in code', () => {
    // A hard-coded default is a guess that goes wrong silently: the provider
    // answers 404 for a retired name and the assistant is simply unavailable.
    const { AWA_MODEL: _unused, ...withoutModel } = complete;
    expect(configurationProblems(bootEnvironmentFrom(withoutModel)).join(' '))
      .toMatch(/AWA_MODEL is not set/);
  });

  it('allows a local root key only when the deployment says so explicitly', () => {
    const { AWA_ROOT_KEY: _unused, ...withoutKey } = complete;
    expect(configurationProblems(bootEnvironmentFrom(withoutKey)).join(' '))
      .toMatch(/AWA_ROOT_KEY/);
    expect(configurationProblems(
      bootEnvironmentFrom({ ...withoutKey, AWA_ALLOW_LOCAL_KEY: '1' }),
    )).toEqual([]);
  });
});

describe('printing api keys', () => {
  it('is off unless asked for', () => {
    expect(bootEnvironmentFrom({}).printKeys).toBe(false);
  });

  it('is refused in production even when asked for', () => {
    // A key on stdout is a key in whatever aggregates the logs, held by
    // whoever can read them and for as long as they are retained.
    expect(bootEnvironmentFrom({
      AWA_DEV_PRINT_KEYS: '1', NODE_ENV: 'production',
    }).printKeys).toBe(false);
    expect(bootEnvironmentFrom({ AWA_DEV_PRINT_KEYS: '1' }).printKeys).toBe(true);
  });
});

describe('a database that is set and does not answer', () => {
  const unreachable = async (): Promise<boolean> => false;

  it('is reported as a reachability problem, not a missing setting', async () => {
    const problem = await databaseProblem(complete.DATABASE_URL, unreachable);
    expect(problem).toMatch(/did not answer/);
    expect(problem).toMatch(/db\.internal:5432/);
  });

  it('never repeats the connection string, which carries a password', async () => {
    // A password on a status page is a password in a screenshot.
    const problem = await databaseProblem(complete.DATABASE_URL, unreachable);
    expect(problem).not.toContain('secret');
    expect(problem).not.toContain('postgres://');
  });

  it('treats a probe that throws as unreachable', async () => {
    const problem = await databaseProblem(complete.DATABASE_URL, async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(problem).toMatch(/did not answer/);
  });

  it('says nothing when the database answers', async () => {
    expect(await databaseProblem(complete.DATABASE_URL, async () => true)).toBeUndefined();
  });

  it('says nothing when there is no DATABASE_URL, which is a separate problem', async () => {
    expect(await databaseProblem(undefined, unreachable)).toBeUndefined();
  });
});
