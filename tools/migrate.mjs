#!/usr/bin/env node
/**
 * Apply database migrations, for a deployment to run before it starts serving.
 *
 * Separate from the application's own boot on purpose. A container that
 * migrates on start will, on an autoscale event, run several migrations at
 * once against the same database; and a rollback then has application code
 * from one release meeting a schema from another with nothing recording which
 * combination was ever tested.
 *
 *   DATABASE_URL=postgres://... node tools/migrate.mjs           # apply
 *   DATABASE_URL=postgres://... node tools/migrate.mjs --status  # report only
 *   DATABASE_URL=postgres://... node tools/migrate.mjs --repair  # see below
 *
 * `--repair` applies pending migrations wherever they sort, instead of
 * refusing. It is the way out of a ledger that lost rows, which an earlier
 * release of this application caused by letting migration files carry their
 * own COMMIT: the schema was committed and the row recording it was not. Every
 * migration here is idempotent, so re-running one against a schema that
 * already has it changes nothing. It is never the default, because applying a
 * migration out of order is the thing the ordering guard exists to prevent.
 *
 * Exit codes: 0 applied or already current, 78 (EX_CONFIG) misconfigured,
 * 1 a migration failed. Nothing here prints a connection string: a URL carries
 * a password, and a password in a log is a password in whatever aggregates
 * the logs.
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

register('./register-ts.mjs', pathToFileURL(`${here}/`));

const url = process.env['DATABASE_URL']?.trim();
if (!url) {
  process.stderr.write(
    'DATABASE_URL is not set. This applies the schema in db/migrations to a '
    + 'PostgreSQL database and cannot guess where that is.\n',
  );
  process.exit(78);
}

const { Database, migrate } = await import(
  pathToFileURL(resolve(root, 'packages/persistence/src/database.ts')).href
);

const database = new Database({ connectionString: url });
const directory = resolve(root, 'db/migrations');
const statusOnly = process.argv.includes('--status');
const repair = process.argv.includes('--repair');

try {
  if (statusOnly) {
    const rows = await database.query(
      'SELECT filename, applied_at FROM schema_migration ORDER BY filename',
    ).catch(() => []);
    if (rows.length === 0) {
      process.stdout.write('No migrations have been applied to this database.\n');
    } else {
      for (const row of rows) {
        process.stdout.write(`${row.filename}  ${row.applied_at.toISOString()}\n`);
      }
    }
  } else {
    if (repair) {
      process.stdout.write(
        'Repairing: applying pending migrations wherever they sort. Every migration\n'
        + 'here is idempotent, so one that is already in the schema changes nothing.\n',
      );
    }
    const ran = await migrate(database, directory, {
      repair,
      onNotice: (line) => process.stdout.write(`${line}\n`),
    });
    process.stdout.write(
      ran.length === 0
        ? 'Schema is already current; nothing to apply.\n'
        : `Applied ${ran.length}: ${ran.join(', ')}\n`,
    );
  }
} catch (error) {
  // The message, never the connection string it may have been built from.
  process.stderr.write(`Migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await database.close();
}
