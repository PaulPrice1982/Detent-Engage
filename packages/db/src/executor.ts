import { AwaError } from '@detent/awa-core';

/**
 * The database boundary (audit SEC-3, PERF-1).
 *
 * The composition root said "the Postgres adapters in `db/` implement the same
 * interfaces with row-level security"; `db/` contained a README and one SQL
 * file, there was no adapter anywhere in the repository, and no `pg` dependency
 * in any manifest. Every store was an in-process Map, so a restart destroyed
 * the hash-chained audit log, every consent event, every spend counter and
 * every tenant configuration. The product's commercial claim is evidence, and
 * the evidence was volatile.
 *
 * These are those adapters. They are written against a two-method `SqlExecutor`
 * rather than against `pg` directly, for three reasons that all matter more
 * than the convenience:
 *
 *  - the platform keeps its zero-runtime-dependency property. A deployment
 *    supplies the driver it already trusts (`pg`, `postgres`, a pooler, a proxy)
 *    in twenty lines;
 *  - the isolation probe can run in CI without a database, against a fake that
 *    models the one thing worth proving in code — that no adapter ever issues a
 *    query outside a transaction that has bound `app.tenant_id`;
 *  - the failure mode is visible. `TenantBoundExecutor` refuses an unbound
 *    query rather than issuing it and trusting the database to return nothing.
 *    Defence in depth means both, not either.
 */
export interface SqlRow {
  readonly [column: string]: unknown;
}

export interface SqlExecutor {
  /** Run a parameterised statement. `$1`-style placeholders, as Postgres uses. */
  query<T extends SqlRow = SqlRow>(text: string, params?: readonly unknown[]): Promise<T[]>;
}

/**
 * A connection checked out for the duration of one transaction.
 *
 * `withTenant` hands one of these to its callback and nothing else, which is
 * what makes "every query is bound" a property of the type rather than of
 * reviewer attention.
 */
export interface TenantBoundExecutor extends SqlExecutor {
  readonly tenantId: string;
}

export interface Pool {
  /**
   * Check out a connection, run `fn` against it, and release it — whatever
   * happens. A leaked connection with `app.tenant_id` still set is the single
   * most dangerous object this design can produce.
   */
  connect<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T>;
}

/**
 * Bind a tenant and run statements inside one transaction.
 *
 * `SET LOCAL`, never a plain `SET`: a plain `SET` survives the transaction back
 * into the pooled connection, where it silently becomes the next request's
 * tenant context. That is the single most dangerous mistake available in this
 * design, and it is why the binding, the transaction and the release are one
 * function rather than three things a caller remembers to do.
 */
export class Database {
  constructor(private readonly pool: Pool) {}

  async withTenant<T>(tenantId: string, fn: (executor: TenantBoundExecutor) => Promise<T>): Promise<T> {
    if (!tenantId || /[^A-Za-z0-9_*.:-]/.test(tenantId)) {
      // The binding is sent as a parameter below, so this is belt and braces
      // rather than the control. A tenant id that is not an identifier is a bug
      // upstream, and failing here makes it visible immediately.
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: `refusing to bind an implausible tenant id` });
    }

    return this.pool.connect(async (connection) => {
      await connection.query('BEGIN');
      try {
        await connection.query('SELECT set_config($1, $2, true)', ['app.tenant_id', tenantId]);
        const bound: TenantBoundExecutor = {
          tenantId,
          query: (text, params) => connection.query(text, params),
        };
        const result = await fn(bound);
        await connection.query('COMMIT');
        return result;
      } catch (cause) {
        await connection.query('ROLLBACK').catch(() => undefined);
        throw cause;
      }
    });
  }

  /**
   * Run outside any tenant binding. Used only by migrations and by the
   * platform-wide chain (`*platform*`), and named so it is greppable in review.
   */
  async unbound<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    return this.pool.connect(fn);
  }
}
