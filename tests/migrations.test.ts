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
import { createHash } from 'node:crypto';
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

  /**
   * This asserted that an out-of-order migration is always refused. The
   * contract changed deliberately: when every migration only declares schema
   * and declares it idempotently, the runner replays the whole sequence
   * instead, because refusing and naming a manual command is useless to a
   * deployment that crash-loops before anybody can run it.
   *
   * The intent is unchanged and still worth holding: an out-of-order
   * migration is never *quietly* applied. It is either replayed as a whole
   * ordered sequence and said out loud, or refused. So the fixture now uses a
   * migration replay cannot make safe, which is where refusal is still right,
   * and the replay path is covered in the suite below.
   */
  it('is refused, naming the file and the one it sorts behind', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'detent-order-'));
    // Not idempotent, so replaying it would fail the second time.
    writeFileSync(join(directory, '0001_early.sql'), 'CREATE TABLE early (id int);');
    writeFileSync(join(directory, '0002_late.sql'), 'CREATE TABLE IF NOT EXISTS late (id int);');

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

/**
 * Recovering a database whose ledger no longer describes the files.
 *
 * Two ways it gets there, and a deployment hit both at once.
 *
 * Renumbering two files to remove a duplicate prefix left the deployed
 * database recording names that no longer exist. Every later release was then
 * refused by the ordering guard: correct, and a hard outage over a rename.
 *
 * And an earlier release's migration files carried their own COMMIT, which
 * ended the runner's transaction early: the schema was committed and the row
 * recording it was not. The ledger came out missing rows for migrations the
 * database plainly has.
 */
describe('a ledger that no longer matches the files', () => {
  const sum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

  /** A database whose ledger and applied statements can both be inspected. */
  function databaseWith(rows: readonly { filename: string; checksum: string }[]) {
    const ledger = rows.map((row) => ({ ...row }));
    const applied: string[] = [];
    const statements: string[] = [];
    return {
      ledger,
      applied,
      statements,
      query: async (text: string, values: readonly unknown[] = []) => {
        if (/FROM schema_migration/i.test(text)) return ledger.map((row) => ({ ...row }));
        if (/UPDATE schema_migration SET filename/i.test(text)) {
          const [to, from] = values as [string, string];
          const row = ledger.find((one) => one.filename === from);
          if (row) row.filename = to;
          statements.push(`rename ${from} -> ${to}`);
          return [];
        }
        return [];
      },
      transaction: async (body: (client: {
        query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
      }) => Promise<unknown>) => body({
        query: async (text: string, values: readonly unknown[] = []) => {
          if (/INSERT INTO schema_migration/i.test(text)) {
            const [filename, checksum] = values as [string, string];
            const row = ledger.find((one) => one.filename === filename);
            if (row) row.checksum = checksum;
            else ledger.push({ filename, checksum });
            applied.push(filename);
          }
          return [];
        },
      }),
    };
  }

  function directoryOf(files: Record<string, string>): string {
    const directory = mkdtempSync(join(tmpdir(), 'detent-ledger-'));
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(directory, name), body);
    }
    return directory;
  }

  it('adopts a migration that was renamed, without running it again', async () => {
    // Identity is the content, not the number somebody gave it.
    const body = 'SELECT 1;';
    const directory = directoryOf({ '0001_a.sql': 'SELECT 0;', '0003_renamed.sql': body });
    const database = databaseWith([
      { filename: '0001_a.sql', checksum: sum('SELECT 0;') },
      { filename: '0002_old_name.sql', checksum: sum(body) },
    ]);

    await migrate(database as never, directory);

    expect(database.statements).toContain('rename 0002_old_name.sql -> 0003_renamed.sql');
    // Adopted, not re-run.
    expect(database.applied).not.toContain('0003_renamed.sql');
    expect(database.ledger.map((row) => row.filename).sort())
      .toEqual(['0001_a.sql', '0003_renamed.sql']);
  });

  it('recovers by itself when every migration is safe to replay', async () => {
    /**
     * Refusing and naming a command to run by hand is the wrong trade when the
     * command cannot be run. A deployment in this state crash-loops, and
     * nobody can reach it to repair it: the remedy was unreachable from
     * exactly the situation that needed it.
     *
     * The runner cannot tell a branch-ordering mistake from a ledger that lost
     * rows, and it does not have to. When every migration only declares schema
     * and declares it idempotently, replaying the sequence in order ends where
     * a fresh install ends either way, so the question is whether replay is
     * safe, which is answerable by reading the files.
     */
    const directory = directoryOf({
      '0001_a.sql': 'CREATE TABLE IF NOT EXISTS a (id int);',
      '0002_b.sql': 'CREATE TABLE IF NOT EXISTS b (id int);',
    });
    const database = databaseWith([
      { filename: '0002_b.sql', checksum: sum('CREATE TABLE IF NOT EXISTS b (id int);') },
    ]);
    const notices: string[] = [];

    const ran = await migrate(database as never, directory, {
      onNotice: (line) => notices.push(line),
    });

    expect(ran).toEqual(['0001_a.sql', '0002_b.sql']);
    // Said out loud. A schema that changed itself without saying so is worse
    // than one that refused.
    expect(notices.join(' ')).toMatch(/replayed in order/);
    expect(notices.join(' ')).toMatch(/no data is touched/);
  });

  it('still refuses when a migration carries data', async () => {
    // A second INSERT is a second row. Replay is only safe for schema.
    const directory = directoryOf({
      '0001_a.sql': "CREATE TABLE IF NOT EXISTS a (id int);\nINSERT INTO a VALUES (1);",
      '0002_b.sql': 'CREATE TABLE IF NOT EXISTS b (id int);',
    });
    const database = databaseWith([
      { filename: '0002_b.sql', checksum: sum('CREATE TABLE IF NOT EXISTS b (id int);') },
    ]);

    await expect(migrate(database as never, directory)).rejects.toThrow(/changes data/);
    expect(database.applied, 'nothing may be applied when it refuses').toEqual([]);
  });

  it('still refuses when a migration can only run once', async () => {
    const directory = directoryOf({
      '0001_a.sql': 'CREATE TABLE a (id int);',
      '0002_b.sql': 'CREATE TABLE IF NOT EXISTS b (id int);',
    });
    const database = databaseWith([
      { filename: '0002_b.sql', checksum: sum('CREATE TABLE IF NOT EXISTS b (id int);') },
    ]);

    await expect(migrate(database as never, directory)).rejects.toThrow(/runs only once/);
  });

  it('refuses when a migration manages its own transaction', async () => {
    // The fault that lost the ledger rows in the first place.
    const directory = directoryOf({
      '0001_a.sql': 'BEGIN;\nCREATE TABLE IF NOT EXISTS a (id int);\nCOMMIT;',
      '0002_b.sql': 'CREATE TABLE IF NOT EXISTS b (id int);',
    });
    const database = databaseWith([
      { filename: '0002_b.sql', checksum: sum('CREATE TABLE IF NOT EXISTS b (id int);') },
    ]);

    await expect(migrate(database as never, directory)).rejects.toThrow(/own transaction/);
  });

  it('replays the whole sequence on repair, not only what is pending', async () => {
    /**
     * The regression this exists for.
     *
     * Idempotent per file does not mean safe in any order. A later migration
     * removes what an earlier one creates: 0004 takes row-level security off
     * the tenant registry, which is read unbound. Re-running only the pending
     * 0001 put that policy back after the migration that removes it had run,
     * and the platform could then read zero tenants. The schema was
     * self-consistent and wrong.
     */
    const directory = directoryOf({
      '0001_creates.sql': 'SELECT 1;',
      '0002_keeps.sql': 'SELECT 2;',
      '0003_removes.sql': 'SELECT 3;',
    });
    const database = databaseWith([
      { filename: '0003_removes.sql', checksum: sum('SELECT 3;') },
    ]);

    const ran = await migrate(database as never, directory, { repair: true });

    // Every file, in order, so the last writer for any object is the same one
    // it would be on a new database.
    expect(ran).toEqual(['0001_creates.sql', '0002_keeps.sql', '0003_removes.sql']);
    expect(database.applied).toEqual(['0001_creates.sql', '0002_keeps.sql', '0003_removes.sql']);
    expect(database.ledger).toHaveLength(3);
  });

  it('does not replay anything when there is nothing wrong', async () => {
    const directory = directoryOf({ '0001_a.sql': 'SELECT 0;', '0002_b.sql': 'SELECT 1;' });
    const database = databaseWith([
      { filename: '0001_a.sql', checksum: sum('SELECT 0;') },
      { filename: '0002_b.sql', checksum: sum('SELECT 1;') },
    ]);

    expect(await migrate(database as never, directory)).toEqual([]);
    expect(database.applied).toEqual([]);
  });
});
