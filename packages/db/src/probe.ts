import { AwaError } from '@detent/awa-core';
import type { Pool, SqlExecutor, SqlRow } from './executor.js';

/**
 * The isolation probe (audit SEC-3).
 *
 * The audit's request was specific: "add an isolation probe test that asserts a
 * query issued without the binding returns zero rows". Doing that against a
 * live Postgres is right and belongs in the deployment's own CI; doing it in a
 * suite that must run with no dependencies needs a fake that models the two
 * things the probe is actually about.
 *
 * This fake models exactly those two:
 *
 *  - rows carry a `tenant_id`, and a SELECT returns only rows matching the
 *    binding set by `set_config('app.tenant_id', ..., true)` in the current
 *    transaction. With no binding, it returns nothing — the same failing-closed
 *    behaviour `current_setting('app.tenant_id', true)` produces under a
 *    `FORCE`d policy, because `tenant_id = NULL` is never true;
 *  - the binding is transaction-local. `COMMIT` and `ROLLBACK` clear it, so a
 *    connection returned to the pool carries no tenant context. A plain `SET`
 *    would not, which is the mistake this whole design is arranged to prevent.
 *
 * It is a fake, and it is honest about being one: it proves the adapters bind
 * and that an unbound read sees nothing. It does not prove the production
 * database is configured correctly — only a migration applied to a real cluster
 * does that, and `db/migrations` is where that lives.
 */
export interface ProbeRecord extends SqlRow {
  readonly tenant_id: string;
}

interface Connection extends SqlExecutor {
  binding?: string;
  inTransaction: boolean;
}

export class IsolationProbePool implements Pool {
  /** Table name → rows. Populated by the test. */
  readonly tables = new Map<string, ProbeRecord[]>();
  /** Every statement seen, in order, for assertions about binding. */
  readonly statements: { sql: string; binding?: string }[] = [];
  /** Statements that ran with no tenant binding and touched a tenant table. */
  readonly unboundReads: string[] = [];

  seed(table: string, rows: readonly ProbeRecord[]): void {
    this.tables.set(table, [...(this.tables.get(table) ?? []), ...rows]);
  }

  async connect<T>(fn: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const connection: Connection = {
      inTransaction: false,
      query: async <R extends SqlRow>(text: string, params: readonly unknown[] = []): Promise<R[]> => {
        const sql = text.trim();
        this.statements.push({ sql, binding: connection.binding });

        if (/^BEGIN/i.test(sql)) { connection.inTransaction = true; return [] as R[]; }
        if (/^(COMMIT|ROLLBACK)/i.test(sql)) {
          connection.inTransaction = false;
          // SET LOCAL semantics: the binding does not survive the transaction.
          connection.binding = undefined;
          return [] as R[];
        }
        if (/set_config/i.test(sql)) {
          if (!connection.inTransaction) {
            throw new AwaError({
              kind: 'INTERNAL',
              message: 'SET LOCAL outside a transaction has no effect and must never be issued',
            });
          }
          connection.binding = String(params[1] ?? '');
          return [] as R[];
        }

        const table = tableOf(sql);
        if (!table) return [] as R[];

        if (!connection.binding) {
          this.unboundReads.push(sql);
          // Fails closed, exactly as the policy does.
          return [] as R[];
        }

        const rows = this.tables.get(table) ?? [];
        return rows.filter((row) => row.tenant_id === connection.binding) as unknown as R[];
      },
    };
    return fn(connection);
  }

  /** True when every statement that touched a table ran under a binding. */
  get everyQueryWasBound(): boolean {
    return this.unboundReads.length === 0;
  }
}

function tableOf(sql: string): string | undefined {
  const match = /\b(?:FROM|INTO|UPDATE)\s+(?:AS\s+)?([a-z_][a-z0-9_]*)/i.exec(sql);
  return match?.[1]?.toLowerCase();
}
