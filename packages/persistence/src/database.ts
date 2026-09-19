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

export interface DatabaseOptions {
  readonly connectionString: string;
  /** Bounded so a burst cannot exhaust the server's connection slots. */
  readonly maxConnections?: number;
  readonly statementTimeoutMs?: number;
}

export class Database {
  private readonly pool: pg.Pool;

  constructor(options: DatabaseOptions) {
    this.pool = new Pool({
      connectionString: options.connectionString,
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
export async function migrate(database: Database, directory: string): Promise<string[]> {
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

  const applied = new Set(
    (await database.query<{ filename: string }>('SELECT filename FROM schema_migration'))
      .map((row) => row.filename),
  );

  const ran: string[] = [];
  for (const filename of files) {
    if (applied.has(filename)) continue;
    const sql = await readFile(resolve(directory, filename), 'utf8');
    const checksum = await digest(sql);
    await database.transaction(async (client) => {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migration (filename, checksum) VALUES ($1, $2)',
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
