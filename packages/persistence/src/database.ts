import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';

/**
 * The database connection, and the rules for using it.
 *
 * Two of those rules matter more than the rest:
 *
 * Tenant binding uses `SET LOCAL`, never a plain `SET`. A plain `SET` outlives
 * its transaction and travels back into the connection pool, so the next
 * request served by that connection inherits the previous request's tenant.
 * That is not a subtle bug: it is one customer reading another's data, and it
 * only appears under load, which is when it is least survivable.
 *
 * Nothing here logs a connection string. A URL carries a password, and a
 * password in a log is a password in whatever aggregates the logs.
 */

const { Pool } = pg;

/**
 * Take `sslmode` out of the URL and pass TLS settings explicitly.
 *
 * Every managed Postgres hands out a URL ending `?sslmode=require`, and pg
 * warns on every boot that it currently treats that as `verify-full` and will
 * stop doing so in its next major version. The warning is right to exist: the
 * two differ in whether the server's certificate is actually checked, and a
 * silent change of that is a silent downgrade of transport security.
 *
 * So the decision is made here rather than inherited. `require` and above
 * verify the certificate, which is what the current behaviour already is and
 * what a managed provider's own certificate chain supports. `disable` is
 * honoured as written, because a sidecar proxy on localhost is a real
 * arrangement. Nothing is guessed at connection time and no warning is
 * printed, because there is nothing left to warn about.
 */
function splitSsl(url: string): {
  connectionString: string;
  ssl?: { rejectUnauthorized: boolean };
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL this can parse. Left exactly as given: the caller's own error
    // about it is clearer than one invented here.
    return { connectionString: url };
  }
  const mode = parsed.searchParams.get('sslmode');
  if (mode === null) return { connectionString: url };
  parsed.searchParams.delete('sslmode');
  const connectionString = parsed.toString();
  switch (mode) {
    case 'disable':
      return { connectionString };
    case 'no-verify':
      // Encrypted, certificate unchecked. Only ever a deliberate choice.
      return { connectionString, ssl: { rejectUnauthorized: false } };
    default:
      return { connectionString, ssl: { rejectUnauthorized: true } };
  }
}

export interface DatabaseOptions {
  readonly connectionString: string;
  /** Bounded so a burst cannot exhaust the server's connection slots. */
  readonly maxConnections?: number;
  readonly statementTimeoutMs?: number;
}

export class Database {
  private readonly pool: pg.Pool;

  constructor(options: DatabaseOptions) {
    const { connectionString, ssl } = splitSsl(options.connectionString);
    this.pool = new Pool({
      connectionString,
      ...(ssl === undefined ? {} : { ssl }),
      max: options.maxConnections ?? 10,
      // A query that will never finish should not hold a connection for ever.
      statement_timeout: options.statementTimeoutMs ?? 15_000,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    // A pool error with no listener takes the process down. An idle client
    // dropped by the server is ordinary, not fatal.
    this.pool.on('error', (error) => {
      console.error(`Database pool: ${error.message}`);
    });
  }

  /** One statement, on any connection. */
  async query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<T[]> {
    const result = await this.pool.query<T>(text, values as unknown[]);
    return result.rows;
  }

  /**
   * Several statements on one connection, committed together.
   *
   * `tenantId` binds the transaction for row-level security. It is set with
   * `SET LOCAL`, so it is discarded at COMMIT or ROLLBACK and cannot leak into
   * the next user of this pooled connection.
   */
  async transaction<T>(
    body: (client: pg.PoolClient) => Promise<T>,
    tenantId?: string,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (tenantId !== undefined) {
        // Parameterised. A tenant id is data, and interpolating it into a SET
        // is the one place in this file where SQL injection would be trivial.
        await client.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
      }
      const result = await body(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // A rollback that fails means the connection is already gone. The
        // original error is the one worth reporting.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * A query against a tenant-scoped table, with the tenant bound.
   *
   * Every table in the initial schema carries `FORCE ROW LEVEL SECURITY` and a
   * policy of `tenant_id = current_setting('app.tenant_id', true)`. A plain
   * query does not set that, so the policy sees NULL: a read returns nothing
   * and a write is refused with "new row violates row-level security policy".
   *
   * This was invisible for as long as the tests ran as a superuser, because a
   * superuser bypasses row level security entirely. A managed PostgreSQL hands
   * the application an ordinary owner role, and an owner is exactly who FORCE
   * exists to constrain, so on the platform this was deployed to the audit
   * trail could not be written and the knowledge corpus could not be read back.
   *
   * A transaction rather than a session variable, and SET LOCAL rather than
   * SET, because the connection goes back to the pool afterwards and a session
   * variable left on it becomes the next request's tenant context.
   */
  async queryAs<T extends pg.QueryResultRow = pg.QueryResultRow>(
    tenantId: string,
    text: string,
    values: readonly unknown[] = [],
  ): Promise<T[]> {
    return this.transaction(async (client) => {
      const result = await client.query<T>(text, [...values]);
      return result.rows;
    }, tenantId);
  }

  /** Answers whether the database is reachable, for the health endpoint. */
  async healthy(): Promise<boolean> {
    try {
      await this.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Applies any migration that has not run yet, in filename order.
 *
 * Each runs inside its own transaction and is recorded in the same
 * transaction, so a migration either applied and is recorded, or did neither.
 * A migration recorded but not applied is the state nobody can recover from by
 * reading the database.
 */
export interface MigrateOptions {
  /**
   * Apply pending migrations wherever they sort, instead of refusing.
   *
   * The remedy for a ledger that lost rows. Every migration in this release is
   * idempotent by construction, asserted by `tests/migrations.test.ts`, so
   * re-running one against a schema that already has it changes nothing. That
   * property is what makes this safe, and it is why the ordering guard can be
   * strict by default: there is a documented way out that does not involve
   * somebody typing SQL into production.
   *
   * Never the default. Applying a migration out of order is the thing the
   * guard exists to prevent, and doing it has to be somebody's decision.
   */
  readonly repair?: boolean;
}

export async function migrate(
  database: Database,
  directory: string,
  options: MigrateOptions = {},
): Promise<string[]> {
  let present: string[];
  try {
    present = await readdir(directory);
  } catch {
    present = [];
  }
  const files = present.filter((name) => name.endsWith('.sql')).sort();

  // No migrations is never a legitimate state for this application: it ships
  // its schema, so an empty directory means the files did not arrive rather
  // than that there is nothing to do.
  //
  // Before this it was silent. readdir returned nothing, migrate returned
  // nothing, and the boot line said "migrations up to date" about a database
  // with no schema at all. The failure then surfaced several steps later as a
  // missing relation from whichever store happened to query first, which names
  // a table and not the cause. On the live deployment the files were absent
  // from the container and the message the operator got was about cms_page.
  if (files.length === 0) {
    throw new Error(
      `No migrations were found in ${directory}. This release ships its schema, so an `
      + 'empty directory means the files did not arrive rather than that there is nothing '
      + 'to apply. Restore db/migrations from the release and start again. Nothing has '
      + 'been changed in the database.',
    );
  }

  // Only now, with a release that is complete. Checking the files first means an
  // incomplete one is refused without a connection being opened or a table being
  // created, which is the difference between a clear refusal and a database that
  // has been half prepared by a build that should never have run.
  await database.query(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      filename    text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      checksum    text        NOT NULL
    )`);

  let ledger = await database.query<{ filename: string; checksum: string }>(
    'SELECT filename, checksum FROM schema_migration',
  );

  /**
   * A migration that was renamed is the same migration.
   *
   * Its identity is its content, not the number somebody gave it. Renumbering
   * two files to remove a duplicate prefix left a deployed database recording
   * names that no longer exist, and the ordering guard below then refused every
   * later release: correct, and a hard outage over a rename.
   *
   * Matched on the checksum already stored for exactly this purpose. A row
   * whose file is gone, and a file with no row and the same checksum, are one
   * migration under two names, so the row is renamed and nothing is re-run.
   */
  const onDisk = new Set(files);
  const byChecksum = new Map<string, string>();
  for (const file of files) {
    byChecksum.set(await digest(await readFile(resolve(directory, file), 'utf8')), file);
  }
  const renames: { from: string; to: string }[] = [];
  for (const row of ledger) {
    if (onDisk.has(row.filename)) continue;
    const now = byChecksum.get(row.checksum);
    if (!now || ledger.some((other) => other.filename === now)) continue;
    renames.push({ from: row.filename, to: now });
  }
  for (const rename of renames) {
    await database.query(
      'UPDATE schema_migration SET filename = $1 WHERE filename = $2',
      [rename.to, rename.from],
    );
  }
  if (renames.length > 0) {
    ledger = await database.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migration',
    );
  }

  const applied = new Set(ledger.map((row) => row.filename));

  // A file that sorts before something already applied is a migration that was
  // merged behind another branch's. Applying it now runs it against a schema it
  // was never written for, and the version ledger afterwards describes an order
  // that never happened. Refused rather than reordered, because only the author
  // knows whether it is still correct.
  //
  // Two files also sharing a numeric prefix is the same fault a step earlier:
  // their relative order is then whatever the filenames sort to, which is not a
  // decision anybody made.
  const highestApplied = [...applied].sort().pop();
  if (highestApplied !== undefined && !options.repair) {
    const late = files.filter((name) => !applied.has(name) && name < highestApplied);
    if (late.length > 0) {
      throw new Error(
        `Migrations out of order: ${late.join(', ')} sort before ${highestApplied}, `
        + 'which has already been applied.\n\n'
        + 'Two things cause this. A migration merged behind another branch\'s, in which '
        + 'case renumber it after the highest applied one and check the schema it now '
        + 'runs against. Or a ledger that lost rows, which is what an earlier release of '
        + 'this application did: its migration files carried their own COMMIT, so the '
        + 'schema was committed and the row recording it was not.\n\n'
        + 'If it is the second, every migration here is idempotent and re-running one '
        + 'against a schema that already has it changes nothing, so:\n'
        + '    node tools/migrate.mjs --repair\n'
        + 'Nothing has been changed.',
      );
    }
  }

  const prefixes = new Map<string, string[]>();
  for (const name of files) {
    const prefix = /^(\d+)/.exec(name)?.[1];
    if (!prefix) continue;
    prefixes.set(prefix, [...(prefixes.get(prefix) ?? []), name]);
  }
  const clashes = [...prefixes.values()].filter((group) => group.length > 1);
  if (clashes.length > 0) {
    throw new Error(
      'Two migrations share a version prefix, so their order is whatever the '
      + `filenames happen to sort to: ${clashes.map((g) => g.join(' and ')).join('; ')}. `
      + 'Renumber one of each pair. Nothing has been changed.',
    );
  }

  /**
   * Repair replays the whole sequence, not only what is pending.
   *
   * Idempotent per file does not mean safe in any order. A later migration
   * removes things an earlier one creates: 0004 takes row-level security off
   * the tenant registry, which is the platform's own list of customers and is
   * read unbound. Re-running only the pending 0001 put that policy back, after
   * the migration that removes it had already run, and the platform could then
   * read zero tenants. The schema was self-consistent and wrong.
   *
   * Replaying every file in order ends where a fresh install ends, because
   * each one is idempotent and the last writer for any object is the same one
   * it would be on a new database. That is the only ordering with a guarantee
   * attached to it.
   */
  const ran: string[] = [];
  for (const filename of files) {
    if (!options.repair && applied.has(filename)) continue;
    const sql = await readFile(resolve(directory, filename), 'utf8');
    const checksum = await digest(sql);
    await database.transaction(async (client) => {
      await client.query(sql);
      // The checksum is refreshed as well as the row inserted: a migration
      // whose content changed after it was applied would otherwise keep
      // reporting the checksum of a file that no longer exists, and the
      // rename adoption above reads it.
      await client.query(
        `INSERT INTO schema_migration (filename, checksum) VALUES ($1, $2)
         ON CONFLICT (filename) DO UPDATE SET checksum = EXCLUDED.checksum,
                                              applied_at = now()`,
        [filename, checksum],
      );
    });
    ran.push(filename);
  }
  return ran;
}

async function digest(text: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}

/**
 * The database from the environment, or nothing.
 *
 * Nothing is the honest answer when `DATABASE_URL` is unset: the caller then
 * runs on in-memory stores and says so at boot, rather than a connection being
 * invented to a database that does not exist.
 */
export function databaseFromEnvironment(
  env: Record<string, string | undefined> = process.env,
): Database | undefined {
  const connectionString = env['DATABASE_URL']?.trim();
  if (!connectionString) return undefined;
  return new Database({ connectionString });
}
