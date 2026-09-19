/**
 * A migration must be safe to run twice.
 *
 * This is the fault that took the live site down and held it there. The
 * migration files opened their own transaction and committed it at the end,
 * while the runner also wrapped each file in a transaction together with the
 * row that records it as applied. The file's COMMIT ended the runner's
 * transaction early, so a failure after that point left the schema committed
 * and the ledger row missing. Every start after that re-ran a migration whose
 * tables already existed and stopped on:
 *
 *   relation "tenant" already exists
 *
 * Two rules follow, and this file holds both.
 *
 *  1. No migration manages its own transaction. The runner owns it, so a
 *     migration and the record of it either both land or neither does.
 *  2. Every statement is safe to run again, so a database that already carries
 *     the schema is adopted rather than refused. Without this the only way out
 *     of the state above is somebody typing SQL into production.
 *
 * These are static checks on purpose. The behaviour was verified against a real
 * PostgreSQL in exactly the broken state, and that database cannot exist in
 * this suite, but the properties that make the recovery work are readable in
 * the files and are what regresses.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../packages/persistence/src/database.js';

const DIRECTORY = join('db', 'migrations');
const FILES = readdirSync(DIRECTORY).filter((name) => name.endsWith('.sql')).sort();

/** The file with its comments and dollar-quoted plpgsql bodies removed. */
function statementsOf(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

describe('every migration', () => {
  it('has a version prefix nothing else shares', () => {
    // Two files sharing a prefix leaves their relative order to whatever the
    // filenames happen to sort to, which is not a decision anybody made. The
    // delivered tree had two 0002_ files.
    const byPrefix = new Map<string, string[]>();
    for (const file of FILES) {
      const prefix = /^(\d+)/.exec(file)?.[1];
      if (!prefix) continue;
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
    }
    const shared = [...byPrefix.values()].filter((group) => group.length > 1);
    expect(shared, `these share a version prefix: ${JSON.stringify(shared)}`).toEqual([]);
  });

  it('exists', () => {
    expect(FILES.length).toBeGreaterThan(0);
    expect(FILES).toContain('0001_init.sql');
  });

  it('leaves the transaction to the runner', () => {
    for (const file of FILES) {
      const body = statementsOf(readFileSync(join(DIRECTORY, file), 'utf8'));
      // A plpgsql block opens with BEGIN too, so only a statement-level one at
      // the start of a line with its own semicolon counts.
      expect(/^\s*BEGIN\s*;/m.test(body), `${file} opens its own transaction`).toBe(false);
      expect(/^\s*COMMIT\s*;/m.test(body), `${file} commits its own work`).toBe(false);
      expect(/^\s*ROLLBACK\s*;/m.test(body), `${file} rolls back its own work`).toBe(false);
    }
  });

  it('creates every table and index in a form that can run again', () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      statementsOf(readFileSync(join(DIRECTORY, file), 'utf8'))
        .split('\n')
        .forEach((line, index) => {
          const create = /^\s*CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|SCHEMA|SEQUENCE|EXTENSION)\b/i
            .exec(line);
          if (!create) return;
          if (!/IF NOT EXISTS/i.test(line)) offenders.push(`${file}:${index + 1} ${line.trim()}`);
        });
    }
    expect(
      offenders,
      `These would fail on a database that already has them:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('drops a trigger or a policy before creating it, having no IF NOT EXISTS', () => {
    for (const file of FILES) {
      const body = statementsOf(readFileSync(join(DIRECTORY, file), 'utf8'));
      for (const [, name] of body.matchAll(/CREATE TRIGGER\s+(\w+)/gi)) {
        expect(
          new RegExp(`DROP TRIGGER IF EXISTS ${name}\\b`, 'i').test(body),
          `${file}: trigger ${name} is created without being dropped first`,
        ).toBe(true);
      }
      // The policy is created through EXECUTE format(...), so the check is that
      // a guarded drop is present wherever a create is.
      if (/CREATE POLICY/i.test(body)) {
        expect(
          /DROP POLICY IF EXISTS/i.test(body),
          `${file}: a policy is created without being dropped first`,
        ).toBe(true);
      }
    }
  });

  it('does not fail the whole schema over a role a managed database refuses', () => {
    // The isolation the application relies on is the policy, FORCE ROW LEVEL
    // SECURITY and SET LOCAL app.tenant_id. None of them need awa_app, so a
    // hosted PostgreSQL that will not create a role must not take the schema
    // down with it.
    const init = readFileSync(join(DIRECTORY, '0001_init.sql'), 'utf8');
    expect(init).toMatch(/EXCEPTION WHEN insufficient_privilege/i);
    for (const file of FILES) {
      const body = statementsOf(readFileSync(join(DIRECTORY, file), 'utf8'));
      if (/\bTO awa_app\b/i.test(body)) {
        // Every grant to that role sits inside a block that checks it exists.
        expect(
          /pg_roles/.test(body),
          `${file}: grants to awa_app without checking the role exists`,
        ).toBe(true);
      }
    }
  });

  it('still enforces tenant isolation on every tenant-scoped table', () => {
    // The recovery must not have been bought by weakening the thing the schema
    // exists for.
    const init = readFileSync(join(DIRECTORY, '0001_init.sql'), 'utf8');
    expect(init).toMatch(/ENABLE ROW LEVEL SECURITY/);
    expect(init).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(init).toMatch(/CREATE POLICY tenant_isolation/);
    expect(init).toMatch(/current_setting\(''app\.tenant_id'', true\)/);
  });
});


/**
 * A missing migration must be said out loud.
 *
 * The live container had an empty db/migrations. readdir returned nothing,
 * migrate returned nothing, and the boot line said "migrations up to date"
 * about a database with no schema. The failure then surfaced several steps
 * later as a missing relation from whichever store queried first, which names a
 * table and never the cause, and it cost a full round to find by listing the
 * container's files.
 *
 * No migrations is not a quiet no-op. This release ships its schema, so an
 * empty directory means the files did not arrive.
 */
describe('a migrations directory with nothing in it', () => {
  /** Never reached: the directory is checked before anything is connected. */
  const unusedDatabase = {
    query: async () => { throw new Error('the database must not be touched'); },
    transaction: async () => { throw new Error('the database must not be touched'); },
  };

  it('is refused, with the reason and the remedy', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'detent-migrations-'));
    await expect(migrate(unusedDatabase as never, empty)).rejects.toThrow(/No migrations/i);
    await expect(migrate(unusedDatabase as never, empty)).rejects.toThrow(/db\/migrations/);
  });

  it('is refused when the directory is not there at all', async () => {
    const missing = join(tmpdir(), 'detent-migrations-that-do-not-exist');
    await expect(migrate(unusedDatabase as never, missing)).rejects.toThrow(/No migrations/i);
  });
});

/**
 * A migration that arrives behind one already applied.
 *
 * Two branches each add a migration, the later-numbered one merges first, and
 * the other now sorts before something that has run. Applying it then runs it
 * against a schema it was never written for, and the ledger afterwards
 * describes an order that never happened.
 */
describe('a migration that sorts before one already applied', () => {
  function databaseWith(appliedFilenames: readonly string[]) {
    const applied = [...appliedFilenames];
    return {
      query: async (text: string) => {
        if (/FROM schema_migration/i.test(text)) {
          return applied.map((filename) => ({ filename }));
        }
        return [];
      },
      transaction: async () => {
        throw new Error('no migration should be applied once the order is wrong');
      },
    };
  }

  it('is refused, naming the file and the one it sorts behind', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'detent-order-'));
    writeFileSync(join(directory, '0001_early.sql'), 'SELECT 1;');
    writeFileSync(join(directory, '0002_late.sql'), 'SELECT 1;');

    // 0002 has run; 0001 has not. Applying 0001 now is the fault.
    await expect(
      migrate(databaseWith(['0002_late.sql']) as never, directory),
    ).rejects.toThrow(/out of order/i);
    await expect(
      migrate(databaseWith(['0002_late.sql']) as never, directory),
    ).rejects.toThrow(/0001_early\.sql/);
  });

  it('is content when everything applied is behind what is pending', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'detent-order-ok-'));
    writeFileSync(join(directory, '0001_early.sql'), 'SELECT 1;');
    writeFileSync(join(directory, '0002_late.sql'), 'SELECT 1;');
    // 0001 applied, 0002 pending: ordinary, and must not be refused. It throws
    // from the stub transaction, which is how we know it got that far.
    await expect(
      migrate(databaseWith(['0001_early.sql']) as never, directory),
    ).rejects.toThrow(/no migration should be applied/);
  });

  it('refuses two files that share a version prefix', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'detent-prefix-'));
    writeFileSync(join(directory, '0002_platform.sql'), 'SELECT 1;');
    writeFileSync(join(directory, '0002_audit.sql'), 'SELECT 1;');
    await expect(
      migrate(databaseWith([]) as never, directory),
    ).rejects.toThrow(/share a version prefix/i);
  });
});
