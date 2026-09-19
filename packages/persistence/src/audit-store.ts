import type { AuditEntry, AuditStore } from '@detent/awa-audit';
import type { Database } from './database.js';

/**
 * The audit trail, durable.
 *
 * The trail is hash-chained: each entry carries the hash of the one before it,
 * so an entry cannot be altered after the fact without breaking every entry
 * after it. That property is worth nothing if the chain does not survive a
 * restart: an unbroken chain that begins at the last deploy proves only that
 * nobody has tampered with it since lunchtime.
 *
 * Rows are inserted and never updated. There is no `put` here and no upsert:
 * an append-only table is the shape the guarantee requires, and a store that
 * offers to overwrite an entry invites somebody to.
 */
export class PostgresAuditStore implements AuditStore {
  constructor(private readonly database: Database) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.database.queryAs(
      entry.tenantId,
      `INSERT INTO audit_entry
         (id, tenant_id, sequence, type, correlation_id, session_id, actor,
          subject_ref, consent_event_id, payload, versions, previous_hash, hash, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        entry.id, entry.tenantId, entry.sequence, entry.type, entry.correlationId,
        entry.sessionId ?? null, entry.actor, entry.subjectRef ?? null,
        entry.consentEventId ?? null,
        entry.payload ? JSON.stringify(entry.payload) : null,
        entry.versions ? JSON.stringify(entry.versions) : null,
        entry.previousHash, entry.hash, entry.recordedAt,
      ],
    );
  }

  async lastEntry(tenantId: string): Promise<AuditEntry | undefined> {
    // By sequence, not by time. Two entries written in the same millisecond
    // have an order, and the chain is defined by it.
    const rows = await this.database.queryAs<AuditRow>(
      tenantId,
      'SELECT * FROM audit_entry WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1',
      [tenantId],
    );
    return rows[0] ? toEntry(rows[0]) : undefined;
  }

  async list(
    tenantId: string,
    options: { limit?: number; sinceSequence?: number } = {},
  ): Promise<AuditEntry[]> {
    const rows = await this.database.queryAs<AuditRow>(
      tenantId,
      `SELECT * FROM audit_entry
        WHERE tenant_id = $1 AND ($2::bigint IS NULL OR sequence > $2::bigint)
        ORDER BY sequence
        LIMIT $3`,
      [tenantId, options.sinceSequence ?? null, options.limit ?? 1000],
    );
    return rows.map(toEntry);
  }

  async findByCorrelation(tenantId: string, correlationId: string): Promise<AuditEntry[]> {
    const rows = await this.database.query<AuditRow>(
      'SELECT * FROM audit_entry WHERE tenant_id = $1 AND correlation_id = $2 ORDER BY sequence',
      [tenantId, correlationId],
    );
    return rows.map(toEntry);
  }
}

interface AuditRow {
  id: string;
  tenant_id: string;
  sequence: string;
  type: string;
  correlation_id: string;
  session_id: string | null;
  actor: string;
  subject_ref: string | null;
  consent_event_id: string | null;
  payload: Record<string, unknown> | null;
  versions: Record<string, unknown> | null;
  previous_hash: string;
  hash: string;
  recorded_at: Date;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    // bigint arrives as a string, because it can exceed what a JS number holds
    // exactly. Converted here rather than left to a comparison that would
    // silently order '10' before '9'.
    sequence: Number(row.sequence),
    type: row.type as AuditEntry['type'],
    correlationId: row.correlation_id,
    sessionId: row.session_id ?? undefined,
    actor: row.actor as AuditEntry['actor'],
    subjectRef: row.subject_ref ?? undefined,
    consentEventId: row.consent_event_id ?? undefined,
    payload: row.payload ?? undefined,
    versions: (row.versions ?? undefined) as AuditEntry['versions'],
    previousHash: row.previous_hash,
    hash: row.hash,
    recordedAt: row.recorded_at.toISOString(),
  };
}
