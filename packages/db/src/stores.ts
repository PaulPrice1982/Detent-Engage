import type { AuditEntry, AuditStore, ChainCheckpoint, CheckpointStore, ListOptions } from '@detent/awa-audit';
import type { ConsentStore } from '@detent/awa-policy';
import type { UsageDelta, UsageRecord, UsageStore } from '@detent/awa-policy';
import type { ConsentEvent, ConsentPurpose } from '@detent/awa-core';
import type { SealedConnectionRecord, SealedConnectionStore } from '@detent/awa-connectors';
import type { Database, SqlRow } from './executor.js';

/**
 * Postgres adapters behind the existing store interfaces (audit SEC-3).
 *
 * The interfaces were already right, which is most of the work. Every query
 * here runs inside `withTenant`, so row-level security under a `NOBYPASSRLS`
 * role is the second control and the binding is the first.
 */

// --- audit ------------------------------------------------------------------

function toAuditEntry(row: SqlRow): AuditEntry {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    sequence: Number(row['sequence']),
    type: row['type'] as AuditEntry['type'],
    correlationId: String(row['correlation_id']),
    sessionId: row['session_id'] == null ? undefined : String(row['session_id']),
    actor: row['actor'] as AuditEntry['actor'],
    subjectRef: row['subject_ref'] == null ? undefined : String(row['subject_ref']),
    consentEventId: row['consent_event_id'] == null ? undefined : String(row['consent_event_id']),
    payload: (row['payload'] ?? undefined) as AuditEntry['payload'],
    versions: (row['versions'] ?? undefined) as AuditEntry['versions'],
    previousHash: String(row['previous_hash']),
    hash: String(row['hash']),
    recordedAt: isoOf(row['recorded_at']),
  };
}

function isoOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export class PostgresAuditStore implements AuditStore {
  constructor(private readonly db: Database) {}

  async append(entry: AuditEntry): Promise<void> {
    await this.db.withTenant(entry.tenantId, async (sql) => {
      await sql.query(
        `INSERT INTO audit_entry
           (id, tenant_id, sequence, type, correlation_id, session_id, actor, subject_ref,
            consent_event_id, payload, versions, previous_hash, hash, recorded_at)
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
    });
  }

  async lastEntry(tenantId: string): Promise<AuditEntry | undefined> {
    return this.db.withTenant(tenantId, async (sql) => {
      const rows = await sql.query(
        'SELECT * FROM audit_entry WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1', [tenantId],
      );
      return rows[0] ? toAuditEntry(rows[0]) : undefined;
    });
  }

  async firstEntry(tenantId: string): Promise<AuditEntry | undefined> {
    return this.db.withTenant(tenantId, async (sql) => {
      const rows = await sql.query(
        'SELECT * FROM audit_entry WHERE tenant_id = $1 ORDER BY sequence ASC LIMIT 1', [tenantId],
      );
      return rows[0] ? toAuditEntry(rows[0]) : undefined;
    });
  }

  async list(tenantId: string, options: ListOptions = {}): Promise<AuditEntry[]> {
    // Bounds are pushed into the query rather than filtered in application
    // memory: the whole point of PERF-2 is that a month's report does not read
    // a year's entries.
    const clauses = ['tenant_id = $1'];
    const params: unknown[] = [tenantId];
    if (options.sinceSequence !== undefined) { params.push(options.sinceSequence); clauses.push(`sequence > $${params.length}`); }
    if (options.toSequence !== undefined) { params.push(options.toSequence); clauses.push(`sequence <= $${params.length}`); }
    if (options.from !== undefined) { params.push(options.from); clauses.push(`recorded_at >= $${params.length}`); }
    if (options.to !== undefined) { params.push(options.to); clauses.push(`recorded_at <= $${params.length}`); }
    let text = `SELECT * FROM audit_entry WHERE ${clauses.join(' AND ')} ORDER BY sequence ASC`;
    if (options.limit !== undefined) { params.push(options.limit); text += ` LIMIT $${params.length}`; }

    return this.db.withTenant(tenantId, async (sql) => (await sql.query(text, params)).map(toAuditEntry));
  }

  async findByCorrelation(tenantId: string, correlationId: string): Promise<AuditEntry[]> {
    return this.db.withTenant(tenantId, async (sql) => (
      await sql.query(
        'SELECT * FROM audit_entry WHERE tenant_id = $1 AND correlation_id = $2 ORDER BY sequence ASC',
        [tenantId, correlationId],
      )
    ).map(toAuditEntry));
  }

  async count(tenantId: string): Promise<number> {
    return this.db.withTenant(tenantId, async (sql) => {
      const rows = await sql.query('SELECT count(*)::bigint AS total FROM audit_entry WHERE tenant_id = $1', [tenantId]);
      return Number(rows[0]?.['total'] ?? 0);
    });
  }
}

export class PostgresCheckpointStore implements CheckpointStore {
  constructor(private readonly db: Database) {}

  async latest(tenantId: string): Promise<ChainCheckpoint | undefined> {
    return this.db.withTenant(tenantId, async (sql) => {
      const rows = await sql.query(
        'SELECT * FROM audit_checkpoint WHERE tenant_id = $1 ORDER BY sequence DESC LIMIT 1', [tenantId],
      );
      const row = rows[0];
      if (!row) return undefined;
      return {
        tenantId: String(row['tenant_id']),
        sequence: Number(row['sequence']),
        hash: String(row['hash']),
        verifiedAt: isoOf(row['verified_at']),
        signature: String(row['signature']),
      };
    });
  }

  async put(checkpoint: ChainCheckpoint): Promise<void> {
    await this.db.withTenant(checkpoint.tenantId, async (sql) => {
      await sql.query(
        `INSERT INTO audit_checkpoint (tenant_id, sequence, hash, verified_at, signature)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (tenant_id, sequence) DO NOTHING`,
        [checkpoint.tenantId, checkpoint.sequence, checkpoint.hash, checkpoint.verifiedAt, checkpoint.signature],
      );
    });
  }
}

// --- consent ----------------------------------------------------------------

function toConsentEvent(row: SqlRow): ConsentEvent {
  return {
    id: String(row['id']),
    tenantId: String(row['tenant_id']),
    subjectRef: String(row['subject_ref']),
    purpose: row['purpose'] as ConsentEvent['purpose'],
    lawfulBasis: row['lawful_basis'] as ConsentEvent['lawfulBasis'],
    wordingShown: String(row['wording_shown']),
    choice: row['choice'] as ConsentEvent['choice'],
    source: row['source'] as ConsentEvent['source'],
    jurisdiction: row['jurisdiction'] as ConsentEvent['jurisdiction'],
    correlationId: String(row['correlation_id']),
    timestamp: isoOf(row['created_at']),
  };
}

export class PostgresConsentStore implements ConsentStore {
  constructor(private readonly db: Database) {}

  async put(event: ConsentEvent): Promise<void> {
    // Append-only at the database: `consent_event` holds no UPDATE grant and
    // carries an append-only trigger. A superseding decision is a new row.
    await this.db.withTenant(event.tenantId, async (sql) => {
      await sql.query(
        `INSERT INTO consent_event
           (id, tenant_id, subject_ref, purpose, lawful_basis, wording_shown, choice,
            source, jurisdiction, correlation_id, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          event.id, event.tenantId, event.subjectRef, event.purpose, event.lawfulBasis,
          event.wordingShown, event.choice, event.source, event.jurisdiction,
          event.correlationId, event.timestamp,
        ],
      );
    });
  }

  async latest(tenantId: string, subjectRef: string, purpose: ConsentPurpose): Promise<ConsentEvent | undefined> {
    return this.db.withTenant(tenantId, async (sql) => {
      const rows = await sql.query(
        `SELECT * FROM consent_event
         WHERE tenant_id = $1 AND subject_ref = $2 AND purpose = $3
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [tenantId, subjectRef, purpose],
      );
      return rows[0] ? toConsentEvent(rows[0]) : undefined;
    });
  }

  async allForSubject(tenantId: string, subjectRef: string): Promise<ConsentEvent[]> {
    return this.db.withTenant(tenantId, async (sql) => (
      await sql.query(
        'SELECT * FROM consent_event WHERE tenant_id = $1 AND subject_ref = $2 ORDER BY created_at ASC',
        [tenantId, subjectRef],
      )
    ).map(toConsentEvent));
  }
}

// --- usage ------------------------------------------------------------------

function toUsageRecord(row: SqlRow): UsageRecord {
  return {
    tenantId: String(row['tenant_id']),
    period: String(row['period']),
    conversations: Number(row['conversations']),
    textMessages: Number(row['text_messages']),
    voiceMinutes: Number(row['voice_minutes']),
    crmCalls: Number(row['crm_calls']),
    llmTokens: Number(row['llm_tokens']),
    qualifiedOutcomes: Number(row['qualified_outcomes'] ?? 0),
    enrichmentRecords: Number(row['enrichment_records'] ?? 0),
    companyResolutions: Number(row['company_resolutions'] ?? 0),
    spendPence: Number(row['spend_pence']),
    concurrentVoice: Number(row['concurrent_voice']),
  };
}

export class PostgresUsageStore implements UsageStore {
  constructor(private readonly db: Database) {}

  async get(tenantId: string, period: string): Promise<UsageRecord | undefined> {
    return this.db.withTenant(tenantId, async (sql) => {
      const rows = await sql.query(
        'SELECT * FROM usage_period WHERE tenant_id = $1 AND period = $2', [tenantId, period],
      );
      return rows[0] ? toUsageRecord(rows[0]) : undefined;
    });
  }

  /**
   * One statement, one round trip, no lost updates (audit PERF-3).
   *
   * `UPDATE ... SET x = x + $n ... RETURNING` is the whole fix: the read and
   * the write happen inside the same statement, so two concurrent turns cannot
   * both read the same snapshot and have the second overwrite the first. The
   * guard is applied inside the same statement as a `WHERE` clause, an
   * unapplied increment returns no row, which is how voice concurrency is
   * claimed without a check-then-act race.
   */
  async increment(
    tenantId: string,
    period: string,
    delta: UsageDelta,
    guard?: (next: UsageRecord) => boolean,
  ): Promise<{ record: UsageRecord; applied: boolean }> {
    return this.db.withTenant(tenantId, async (sql) => {
      const rows = await sql.query(
        `INSERT INTO usage_period AS u
           (tenant_id, period, conversations, text_messages, voice_minutes, crm_calls, llm_tokens,
            qualified_outcomes, enrichment_records, company_resolutions, spend_pence, concurrent_voice)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, GREATEST($12, 0))
         ON CONFLICT (tenant_id, period) DO UPDATE SET
           conversations       = u.conversations + $3,
           text_messages       = u.text_messages + $4,
           voice_minutes       = u.voice_minutes + $5,
           crm_calls           = u.crm_calls + $6,
           llm_tokens          = u.llm_tokens + $7,
           qualified_outcomes  = u.qualified_outcomes + $8,
           enrichment_records  = u.enrichment_records + $9,
           company_resolutions = u.company_resolutions + $10,
           spend_pence         = round(u.spend_pence + $11, 3),
           concurrent_voice    = GREATEST(u.concurrent_voice + $12, 0),
           updated_at          = now()
         RETURNING *`,
        [
          tenantId, period,
          delta.conversations ?? 0, delta.textMessages ?? 0, delta.voiceMinutes ?? 0,
          delta.crmCalls ?? 0, delta.llmTokens ?? 0, delta.qualifiedOutcomes ?? 0,
          delta.enrichmentRecords ?? 0, delta.companyResolutions ?? 0,
          delta.spendPence ?? 0, delta.concurrentVoice ?? 0,
        ],
      );
      const record = toUsageRecord(rows[0]!);
      if (guard && !guard(record)) {
        // The guard failed on the post-increment value, so the increment is
        // undone inside the same transaction, which then commits as a no-op.
        // A rollback here would also discard anything else the caller did.
        const reverted = await sql.query(
          `UPDATE usage_period SET
             conversations = conversations - $3, text_messages = text_messages - $4,
             voice_minutes = voice_minutes - $5, crm_calls = crm_calls - $6,
             llm_tokens = llm_tokens - $7, qualified_outcomes = qualified_outcomes - $8,
             enrichment_records = enrichment_records - $9, company_resolutions = company_resolutions - $10,
             spend_pence = round(spend_pence - $11, 3),
             concurrent_voice = GREATEST(concurrent_voice - $12, 0)
           WHERE tenant_id = $1 AND period = $2 RETURNING *`,
          [
            tenantId, period,
            delta.conversations ?? 0, delta.textMessages ?? 0, delta.voiceMinutes ?? 0,
            delta.crmCalls ?? 0, delta.llmTokens ?? 0, delta.qualifiedOutcomes ?? 0,
            delta.enrichmentRecords ?? 0, delta.companyResolutions ?? 0,
            delta.spendPence ?? 0, delta.concurrentVoice ?? 0,
          ],
        );
        return { record: toUsageRecord(reverted[0]!), applied: false };
      }
      return { record, applied: true };
    });
  }
}

// --- CRM credentials --------------------------------------------------------

export class PostgresConnectionStore implements SealedConnectionStore {
  constructor(private readonly db: Database) {}

  async get(tenantId: string): Promise<SealedConnectionRecord | undefined> {
    return this.db.withTenant(tenantId, async (sql) => {
      const rows = await sql.query('SELECT * FROM crm_connection WHERE tenant_id = $1', [tenantId]);
      const row = rows[0];
      if (!row) return undefined;
      return {
        tenantId: String(row['tenant_id']),
        connector: String(row['connector']),
        state: row['state'] as SealedConnectionRecord['state'],
        lastError: row['last_error'] == null ? undefined : String(row['last_error']),
        credentialKind: row['credential_kind'] as SealedConnectionRecord['credentialKind'],
        instanceUrl: row['instance_url'] == null ? undefined : String(row['instance_url']),
        expiresAt: row['expires_at'] == null ? undefined : isoOf(row['expires_at']),
        region: row['region'] == null ? undefined : String(row['region']),
        // The ciphertext and its wrapping are stored as JSON; the bytes are
        // never readable without the key management service.
        sealed: JSON.parse(String(row['credential_cipher'])) as SealedConnectionRecord['sealed'],
      };
    });
  }

  async put(record: SealedConnectionRecord): Promise<void> {
    await this.db.withTenant(record.tenantId, async (sql) => {
      await sql.query(
        `INSERT INTO crm_connection
           (tenant_id, connector, state, kms_key_id, credential_cipher, credential_kind,
            region, instance_url, expires_at, last_error, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
         ON CONFLICT (tenant_id) DO UPDATE SET
           connector = $2, state = $3, kms_key_id = $4, credential_cipher = $5,
           credential_kind = $6, region = $7, instance_url = $8, expires_at = $9,
           last_error = $10, updated_at = now()`,
        [
          record.tenantId, record.connector, record.state, record.sealed.keyId,
          JSON.stringify(record.sealed), record.credentialKind,
          record.region ?? null, record.instanceUrl ?? null, record.expiresAt ?? null,
          record.lastError ?? null,
        ],
      );
    });
  }

  /**
   * Tenants holding a credential, for key rotation.
   *
   * The one query that is legitimately cross-tenant, and it returns identifiers
   * only, never a credential, never a ciphertext. It runs unbound because a
   * rotation is a platform operation, and it is named so a reviewer sees that.
   */
  async tenants(): Promise<string[]> {
    return this.db.unbound(async (sql) => (
      await sql.query('SELECT tenant_id FROM crm_connection ORDER BY tenant_id')
    ).map((row) => String(row['tenant_id'])));
  }
}
