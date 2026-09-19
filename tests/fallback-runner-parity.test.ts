/**
 * The fallback runner keeps up with the tests it has to run.
 *
 * Three runners run this suite: vitest where it is installed, and the built-in
 * runner under tsx or under Node's own TypeScript transform where it is not.
 * The promise is that all three run the same files unmodified, and it is the
 * reason the suite is evidence in a locked-down environment rather than only
 * on a laptop with a working registry.
 *
 * That promise broke silently. Three test files were written using `beforeAll`
 * and `afterAll`, which the built-in runner did not implement, so on a host
 * where the registry had not installed vitest those files failed to load with
 * "does not provide an export named" while every other file passed. The suite
 * looked 99% green and was not running the tests that prove the sign-in pages
 * are served.
 *
 * Nothing caught it because nothing compared the two. This does: it reads what
 * the suite actually imports from 'vitest' and asserts the fallback provides
 * every one of those names.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as fallback from '../tools/mini-test.js';

/** Every name the suite imports from 'vitest', read from the files themselves. */
function importedFromVitest(): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync('tests')) {
    if (!entry.endsWith('.test.ts')) continue;
    const source = readFileSync(join('tests', entry), 'utf8');
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'vitest'/g)) {
      for (const part of (match[1] ?? '').split(',')) {
        const name = part.replace(/\btype\b/, '').split(' as ')[0]?.trim();
        if (name) names.add(name);
      }
    }
  }
  return names;
}

describe('the built-in runner', () => {
  it('provides every name the suite imports from vitest', () => {
    const wanted = [...importedFromVitest()].sort();
    // The guard is worthless if it is asserting over an empty set.
    expect(wanted.length, 'no vitest imports were found to check').toBeGreaterThan(3);

    const missing = wanted.filter((name) => !(name in fallback));
    expect(
      missing,
      `tests/ imports these from 'vitest' and tools/mini-test.ts does not export them: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('provides the lifecycle hooks, which it once did not', () => {
    for (const hook of ['beforeAll', 'afterAll', 'beforeEach', 'afterEach']) {
      expect(typeof (fallback as Record<string, unknown>)[hook], hook).toBe('function');
    }
  });

  it('spreads a table row across the parameters, as vitest does', () => {
    // It used to pass the row whole, so the second parameter was undefined and
    // the first was an array. The test still ran and still reported a name
    // while asserting something other than what it says, which is worse than
    // not running at all.
    //
    // Observed through describe.each, whose body runs at registration, so the
    // arguments are visible here without running the fallback's own runner.
    const seen: unknown[][] = [];
    const each = (fallback.describe as unknown as {
      each: (rows: readonly unknown[]) => (name: string, body: (...args: unknown[]) => void) => void;
    }).each;
    each([['/a', 1], ['/b', 2]])('serves %s', (...args) => { seen.push(args); });

    expect(seen).toEqual([['/a', 1], ['/b', 2]]);
  });
});
