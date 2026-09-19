import { describe, expect, it } from 'vitest';
import {
  Database, IsolationProbePool, PostgresAuditStore, PostgresCheckpointStore,
  PostgresConsentStore, PostgresUsageStore,
} from '@detent/awa-db';

/**
 * CI gate: tenant isolation at the database boundary (audit SEC-3).
 *
 * Pass threshold: zero unbound queries, and an unbound read returns nothing.
 *
 * This runs against a fake that models the two properties the probe is about —
 * a policy keyed on a transaction-local binding, and `SET LOCAL` semantics that
 * do not survive a commit. It proves the adapters always bind, which is the
 * part that lives in this repository. It does not prove a production cluster is
 * configured correctly; the migrations in `db/migrations` do that, applied to a
 * real database by the deployment's own CI.
 */
describe('every adapter binds its tenant inside the transaction', () => {
  it('binds with SET LOCAL and releases the binding on commit', async () => {
    const pool = new IsolationProbePool();
    const db = new Database(pool);

    await db.withTenant('t_a', async (sql) => {
      await sql.query('SELECT * FROM audit_entry WHERE tenant_id = $1', ['t_a']);
    });

    const sequence = pool.statements.map((statement) => statement.sql.split(' ')[0]);
    expect(sequence[0]).toBe('BEGIN');
    expect(pool.statements[1]!.sql).toContain('set_config');
    expect(sequence[sequence.length - 1]).toBe('COMMIT');
  });

  it('does not let a binding survive a commit onto the pooled connection', async () => {
    const pool = new IsolationProbePool();
    pool.seed('audit_entry', [{ tenant_id: 't_a', id: 'aud_a' }]);

    // Both transactions run on the same checked-out connection, which is what a
    // pool does. A plain `SET` would leave `app.tenant_id` set and the second
    // read would return the first tenant's rows — the single most dangerous
    // mistake available in this design.
    const afterCommit = await pool.connect(async (sql) => {
      await sql.query('BEGIN');
      await sql.query('SELECT set_config($1, $2, true)', ['app.tenant_id', 't_a']);
      await sql.query('COMMIT');
      return sql.query('SELECT * FROM audit_entry');
    });

    expect(afterCommit).toEqual([]);
    expect(pool.unboundReads).toHaveLength(1);
  });

  it('returns zero rows for a query issued with no binding', async () => {
    const pool = new IsolationProbePool();
    pool.seed('audit_entry', [{ tenant_id: 't_a', id: 'aud_1' }]);
    const db = new Database(pool);

    const rows = await db.unbound(async (sql) => sql.query('SELECT * FROM audit_entry'));

    expect(rows).toEqual([]);
    expect(pool.everyQueryWasBound).toBe(false);
  });

  it('returns only the bound tenant rows', async () => {
    const pool = new IsolationProbePool();
    pool.seed('audit_entry', [
      { tenant_id: 't_a', id: 'aud_a' },
      { tenant_id: 't_b', id: 'aud_b' },
    ]);
    const db = new Database(pool);

    const rows = await db.withTenant('t_a', async (sql) => sql.query('SELECT * FROM audit_entry'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!['id']).toBe('aud_a');
  });

  it('rolls back and clears the binding when the callback throws', async () => {
    const pool = new IsolationProbePool();
    const db = new Database(pool);

    await expect(db.withTenant('t_a', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(pool.statements.some((statement) => statement.sql === 'ROLLBACK')).toBe(true);
  });

  it('refuses to bind an implausible tenant id', async () => {
    const db = new Database(new IsolationProbePool());
    await expect(db.withTenant("t_a'; DROP TABLE tenant; --", async () => undefined))
      .rejects.toThrowError(/implausible tenant id/);
  });

  it('issues no unbound query from any store adapter', async () => {
    const pool = new IsolationProbePool();
    const db = new Database(pool);

    const audit = new PostgresAuditStore(db);
    const consent = new PostgresConsentStore(db);
    const usage = new PostgresUsageStore(db);
    const checkpoints = new PostgresCheckpointStore(db);

    await audit.append({
      id: 'aud_1', tenantId: 't_a', sequence: 1, type: 'session_opened',
      correlationId: 'corr_1', actor: 'system', previousHash: '0'.repeat(64),
      hash: '1'.repeat(64), recordedAt: '2026-09-04T09:00:00.000Z',
    });
    await audit.lastEntry('t_a');
    await audit.firstEntry('t_a');
    await audit.list('t_a', { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z', limit: 10 });
    await audit.findByCorrelation('t_a', 'corr_1');
    await audit.count('t_a');

    await consent.put({
      id: 'cons_1', tenantId: 't_a', subjectRef: 'pers_1', purpose: 'IDENTITY_RESOLUTION',
      lawfulBasis: 'CONSENT', wordingShown: 'May we check whether we already know you?',
      choice: 'GRANTED', source: 'WIDGET_PROMPT', jurisdiction: 'UK',
      correlationId: 'corr_1', timestamp: '2026-09-04T09:00:00.000Z',
    });
    await consent.latest('t_a', 'pers_1', 'IDENTITY_RESOLUTION');
    await consent.allForSubject('t_a', 'pers_1');

    await usage.get('t_a', '2026-09');
    await checkpoints.latest('t_a');

    expect(pool.everyQueryWasBound).toBe(true);
    expect(pool.unboundReads).toEqual([]);
  });

  it('pushes the time bounds into the query rather than filtering in memory', async () => {
    const pool = new IsolationProbePool();
    const audit = new PostgresAuditStore(new Database(pool));
    await audit.list('t_a', { from: '2026-09-01T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' });

    const select = pool.statements.find((statement) => statement.sql.startsWith('SELECT * FROM audit_entry'));
    expect(select?.sql).toContain('recorded_at >=');
    expect(select?.sql).toContain('recorded_at <=');
  });

  it('increments usage counters in one statement, not read-modify-write', async () => {
    const pool = new IsolationProbePool();
    const usage = new PostgresUsageStore(new Database(pool));
    // The fake returns no rows, so the adapter throws when it reads the
    // RETURNING row back. What is being asserted is the statement it sent.
    await usage.increment('t_a', '2026-09', { textMessages: 1, spendPence: 0.24 }).catch(() => undefined);

    const statement = pool.statements.find((entry) => entry.sql.startsWith('INSERT INTO usage_period'));
    expect(statement?.sql).toContain('ON CONFLICT');
    expect(statement?.sql).toContain('text_messages       = u.text_messages + $4');
    expect(statement?.sql).toContain('RETURNING');
    expect(statement?.binding).toBe('t_a');
  });
});
