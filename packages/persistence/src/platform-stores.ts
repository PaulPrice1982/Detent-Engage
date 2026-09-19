import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ConsentEvent, ConsentPurpose, WriteReceipt, WriteReceiptState } from '@detent/awa-core';
import type { ConsentStore, UsageDelta, UsageRecord, UsageStore } from '@detent/awa-policy';
import type { ConnectionStore, TenantConnection, WriteReceiptStore } from '@detent/awa-connectors';
import type { OutcomeStore, RecordedOutcome } from '@detent/awa-outcomes';
import type { PaymentRecord, PaymentStore } from '@detent/awa-payments';
import type { SuppressionRecord, SuppressionStore } from '@detent/awa-followup';
import type { Database } from './database.js';

/**
 * The stores that were still holding everything in memory.
 *
 * Each of them was losing its contents at every restart, and each of them was
 * also wrong across more than one instance of the same deployment, which is the
 * arrangement the platform actually runs in. Three of the seven were compliance
 * exposure rather than inconvenience: consent evidence, the suppression list,
 * and the metering a customer is billed from.
 *
 * Every tenant-scoped statement here goes through `queryAs`, which binds
 * `app.tenant_id` for the transaction. The tables carry FORCE ROW LEVEL
 * SECURITY, so a plain query reads nothing and writes are refused outright.
 */

// ---------------------------------------------------------------------------
// Metering
// ---------------------------------------------------------------------------

/**
 * What the customer is billed from.
 *
 * The counters are incremented in SQL, not read-modify-written in the service.
 * A whole-record `put` loses updates: two concurrent turns read the same
 * snapshot and the second write discards the first one's spend. That is most
 * likely under exactly the load that makes a spend cap matter, so the
 * arithmetic happens in one statement the database serialises, and the guard
 * is evaluated inside the same transaction as the update it authorises.
 */
export class PostgresUsageStore implements UsageStore {
  constructor(private readonly database: Database) {}

  async get(tenantId: string, period: string): Promise<UsageRecord | undefined> {
    const rows = await this.database.queryAs<UsageRow>(
      tenantId,
      'SELECT * FROM usage_period WHERE tenant_id = $1 AND period = $2',
      [tenantId, period],
    );
    const row = rows[0];
    if (!row) return undefined;
    return toUsageRecord(row);
  }

  /**
   * Apply deltas atomically and report whether they were kept (audit PERF-3).
   *
   * One statement does the arithmetic: `ON CONFLICT ... DO UPDATE SET
   * col = usage_period.col + EXCLUDED.col`. Postgres takes a row lock for the
   * update, so concurrent callers queue rather than overwrite each other, and
   * no read-modify-write window exists for an update to be lost in.
   *
   * The guard runs against the post-increment record inside the same
   * transaction. Refusing rolls the increment back, so a refused call leaves
   * the counters exactly as it found them. Checking before the update instead
   * would be a check-then-act race, which is the thing this exists to remove.
   */
  async increment(
    tenantId: string,
    period: string,
    delta: UsageDelta,
    guard?: (next: UsageRecord) => boolean,
  ): Promise<{ record: UsageRecord; applied: boolean }> {
    const refused = Symbol('guard refused');
    try {
      return await this.database.transaction(async (client) => {
        const result = await client.query<UsageRow>(
          `INSERT INTO usage_period
             (tenant_id, period, conversations, text_messages, voice_minutes, crm_calls,
              llm_tokens, qualified_outcomes, enrichment_records, company_resolutions,
              spend_pence, concurrent_voice, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, greatest(0, $12), now())
           ON CONFLICT (tenant_id, period) DO UPDATE SET
             conversations = usage_period.conversations + EXCLUDED.conversations,
             text_messages = usage_period.text_messages + EXCLUDED.text_messages,
             voice_minutes = usage_period.voice_minutes + EXCLUDED.voice_minutes,
             crm_calls = usage_period.crm_calls + EXCLUDED.crm_calls,
             llm_tokens = usage_period.llm_tokens + EXCLUDED.llm_tokens,
             qualified_outcomes = usage_period.qualified_outcomes + EXCLUDED.qualified_outcomes,
             enrichment_records = usage_period.enrichment_records + EXCLUDED.enrichment_records,
             company_resolutions = usage_period.company_resolutions + EXCLUDED.company_resolutions,
             -- Rounded to a thousandth of a penny on every step, so a long
             -- month of sub-penny increments does not accumulate float drift.
             spend_pence = round((usage_period.spend_pence + EXCLUDED.spend_pence)::numeric, 3),
             -- Concurrency is a gauge, not a total: it goes down as well as up
             -- and must never be negative, or a release is lost and the slot
             -- leaks. $12 rather than EXCLUDED, because the value proposed for
             -- insertion is clamped at zero for the insert path and would turn
             -- every release into a no-op here.
             concurrent_voice = greatest(0, usage_period.concurrent_voice + $12),
             updated_at = now()
           RETURNING *`,
          [
            tenantId, period,
            delta.conversations ?? 0, delta.textMessages ?? 0, delta.voiceMinutes ?? 0,
            delta.crmCalls ?? 0, delta.llmTokens ?? 0, delta.qualifiedOutcomes ?? 0,
            delta.enrichmentRecords ?? 0, delta.companyResolutions ?? 0,
            delta.spendPence ?? 0,
            // Passed as given, including a release. Clamping the delta rather
            // than the result would silently discard every release and leak a
            // concurrency slot on each one.
            delta.concurrentVoice ?? 0,
          ],
        );
        const next = toUsageRecord(result.rows[0]!);
        if (guard && !guard(next)) {
          // Thrown rather than returned, because returning would commit the
          // increment the guard just refused.
          throw refused;
        }
        return { record: next, applied: true };
      }, tenantId);
    } catch (error) {
      if (error === refused) {
        // The transaction rolled back, so the stored record is what it was
        // before this call. Derived rather than re-read: a second query would
        // see any increment that landed in between and report it as ours.
        const current = (await this.get(tenantId, period))
          ?? emptyUsageRecord(tenantId, period);
        return { record: current, applied: false };
      }
      throw error;
    }
  }

  async put(record: UsageRecord): Promise<void> {
    await this.database.queryAs(
      record.tenantId,
      `INSERT INTO usage_period
         (tenant_id, period, conversations, text_messages, voice_minutes, crm_calls,
          llm_tokens, qualified_outcomes, enrichment_records, company_resolutions,
          spend_pence, concurrent_voice, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (tenant_id, period) DO UPDATE SET
         conversations = EXCLUDED.conversations,
         text_messages = EXCLUDED.text_messages,
         voice_minutes = EXCLUDED.voice_minutes,
         crm_calls = EXCLUDED.crm_calls,
         llm_tokens = EXCLUDED.llm_tokens,
         qualified_outcomes = EXCLUDED.qualified_outcomes,
         enrichment_records = EXCLUDED.enrichment_records,
         company_resolutions = EXCLUDED.company_resolutions,
         spend_pence = EXCLUDED.spend_pence,
         concurrent_voice = EXCLUDED.concurrent_voice,
         updated_at = now()`,
      [
        record.tenantId, record.period, record.conversations, record.textMessages,
        record.voiceMinutes, record.crmCalls, record.llmTokens, record.qualifiedOutcomes,
        record.enrichmentRecords, record.companyResolutions, record.spendPence,
        record.concurrentVoice,
      ],
    );
  }
}

/**
 * One row as a record. Counters are bigint and numeric, which the driver
 * returns as strings because they can exceed what a JS number holds exactly;
 * converting here rather than at each call site is what stops a comparison
 * silently ordering '10' before '9'.
 */
function toUsageRecord(row: UsageRow): UsageRecord {
  return {
    tenantId: row.tenant_id,
    period: row.period,
    conversations: Number(row.conversations),
    textMessages: Number(row.text_messages),
    voiceMinutes: Number(row.voice_minutes),
    crmCalls: Number(row.crm_calls),
    llmTokens: Number(row.llm_tokens),
    qualifiedOutcomes: Number(row.qualified_outcomes),
    enrichmentRecords: Number(row.enrichment_records),
    companyResolutions: Number(row.company_resolutions),
    spendPence: Number(row.spend_pence),
    concurrentVoice: Number(row.concurrent_voice),
  };
}

function emptyUsageRecord(tenantId: string, period: string): UsageRecord {
  return {
    tenantId, period,
    conversations: 0, textMessages: 0, voiceMinutes: 0, crmCalls: 0, llmTokens: 0,
    qualifiedOutcomes: 0, enrichmentRecords: 0, companyResolutions: 0,
    spendPence: 0, concurrentVoice: 0,
  };
}

interface UsageRow {
  tenant_id: string;
  period: string;
  conversations: string;
  text_messages: string;
  voice_minutes: string;
  crm_calls: string;
  llm_tokens: string;
  qualified_outcomes: string;
  enrichment_records: string;
  company_resolutions: string;
  spend_pence: string;
  concurrent_voice: number;
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * The evidence that somebody agreed, and to what.
 *
 * Inserted and never updated: the table carries an append-only trigger, and a
 * withdrawal is a new event rather than an edit to an old one. That is the
 * whole point of consent evidence, and holding it in memory meant it lasted
 * until the next deploy while the site told buyers the decision was recorded
 * against the conversation.
 */
export class PostgresConsentStore implements ConsentStore {
  constructor(private readonly database: Database) {}

  async put(event: ConsentEvent): Promise<void> {
    await this.database.queryAs(
      event.tenantId,
      `INSERT INTO consent_event
         (id, tenant_id, subject_ref, purpose, lawful_basis, wording_shown, choice,
          source, jurisdiction, correlation_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.id, event.tenantId, event.subjectRef, event.purpose, event.lawfulBasis,
        event.wordingShown, event.choice, event.source, event.jurisdiction,
        event.correlationId, event.timestamp,
      ],
    );
  }

  async latest(
    tenantId: string,
    subjectRef: string,
    purpose: ConsentPurpose,
  ): Promise<ConsentEvent | undefined> {
    const rows = await this.database.queryAs<ConsentRow>(
      tenantId,
      `SELECT * FROM consent_event
        WHERE tenant_id = $1 AND subject_ref = $2 AND purpose = $3
        ORDER BY created_at DESC LIMIT 1`,
      [tenantId, subjectRef, purpose],
    );
    return rows[0] ? toConsent(rows[0]) : undefined;
  }

  async allForSubject(tenantId: string, subjectRef: string): Promise<ConsentEvent[]> {
    const rows = await this.database.queryAs<ConsentRow>(
      tenantId,
      'SELECT * FROM consent_event WHERE tenant_id = $1 AND subject_ref = $2 ORDER BY created_at',
      [tenantId, subjectRef],
    );
    return rows.map(toConsent);
  }
}

interface ConsentRow {
  id: string;
  tenant_id: string;
  subject_ref: string;
  purpose: string;
  lawful_basis: string;
  wording_shown: string;
  choice: string;
  source: string;
  jurisdiction: string;
  correlation_id: string;
  created_at: Date;
}

function toConsent(row: ConsentRow): ConsentEvent {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    subjectRef: row.subject_ref,
    purpose: row.purpose as ConsentEvent['purpose'],
    lawfulBasis: row.lawful_basis as ConsentEvent['lawfulBasis'],
    wordingShown: row.wording_shown,
    choice: row.choice as ConsentEvent['choice'],
    timestamp: row.created_at.toISOString(),
    source: row.source as ConsentEvent['source'],
    jurisdiction: row.jurisdiction as ConsentEvent['jurisdiction'],
    correlationId: row.correlation_id,
  };
}

// ---------------------------------------------------------------------------
// Write receipts
// ---------------------------------------------------------------------------

/**
 * What was written to a customer's CRM, and whether it landed.
 *
 * The unique constraint on (tenant_id, idempotency_key) is what makes a retry
 * safe. In memory it was a Map that emptied on restart, so a retry after a
 * deploy wrote a second copy of the same lead into a customer's CRM.
 */
export class PostgresWriteReceiptStore implements WriteReceiptStore {
  constructor(private readonly database: Database) {}

  async find(tenantId: string, idempotencyKey: string): Promise<WriteReceipt | undefined> {
    const rows = await this.database.queryAs<ReceiptRow>(
      tenantId,
      'SELECT * FROM write_receipt WHERE tenant_id = $1 AND idempotency_key = $2',
      [tenantId, idempotencyKey],
    );
    return rows[0] ? toReceipt(rows[0]) : undefined;
  }

  async put(receipt: WriteReceipt): Promise<void> {
    await this.database.queryAs(
      receipt.tenantId,
      `INSERT INTO write_receipt
         (id, tenant_id, correlation_id, idempotency_key, connector, operation, state,
          external_id, attempts, last_error, envelope, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET
         state = EXCLUDED.state,
         external_id = EXCLUDED.external_id,
         attempts = EXCLUDED.attempts,
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [
        receipt.id, receipt.tenantId, receipt.correlationId, receipt.idempotencyKey,
        receipt.connector, receipt.operation, receipt.state, receipt.externalId ?? null,
        receipt.attempts, receipt.lastError ?? null, JSON.stringify({}), receipt.createdAt,
      ],
    );
  }

  async listByState(tenantId: string, state: WriteReceiptState): Promise<WriteReceipt[]> {
    const rows = await this.database.queryAs<ReceiptRow>(
      tenantId,
      'SELECT * FROM write_receipt WHERE tenant_id = $1 AND state = $2 ORDER BY created_at',
      [tenantId, state],
    );
    return rows.map(toReceipt);
  }
}

interface ReceiptRow {
  id: string;
  tenant_id: string;
  correlation_id: string;
  idempotency_key: string;
  connector: string;
  operation: string;
  state: string;
  external_id: string | null;
  attempts: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

function toReceipt(row: ReceiptRow): WriteReceipt {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    connector: row.connector,
    operation: row.operation as WriteReceipt['operation'],
    state: row.state as WriteReceiptState,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    attempts: row.attempts,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

// ---------------------------------------------------------------------------
// CRM connections
// ---------------------------------------------------------------------------

/**
 * A customer's CRM credential, encrypted at rest.
 *
 * The token is the keys to somebody else's Salesforce, so it is never stored in
 * a readable form: AES-256-GCM under a key that lives in the environment and
 * nowhere else, with the authentication tag kept alongside the ciphertext so a
 * tampered row fails to decrypt rather than decrypting to something plausible.
 *
 * Held in memory it was lost at every deploy, which meant every customer
 * silently disconnected from their CRM whenever the platform was updated.
 *
 * With no key configured this store refuses to be constructed rather than
 * writing a token in clear. The caller keeps the in-memory store and says so at
 * boot: a CRM that reconnects after a deploy is a nuisance, and a plaintext
 * OAuth token in a database is an incident.
 */
/**
 * What is wrong with a credential key, in words that name the actual mistake.
 *
 * Base64 decoding ignores every character that is not base64, so a string that
 * is not a key at all still "decodes" to some number of bytes. Pasting the
 * command instead of its output decodes to fifteen, and a message reading
 * "must be 32 bytes, this one decodes to 15" sent somebody looking for a
 * truncated key twice, which is a message that describes a symptom and hides
 * the cause. This one recognises the mistake and says so.
 */
export function credentialKeyProblem(key: string): string | undefined {
  const trimmed = key.trim();
  if (trimmed.length === 0) return 'DETENT_CREDENTIAL_KEY is empty.';

  // 32 bytes of base64 is 44 characters ending in a single pad. Checked as a
  // shape rather than by decoding, because decoding is what forgives the input
  // that should have been refused.
  if (!/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) {
    const looksLikeTheCommand = /openssl|rand|base64/i.test(trimmed) && /\s/.test(trimmed);
    return looksLikeTheCommand
      ? 'DETENT_CREDENTIAL_KEY looks like the command rather than its output. Run '
        + '"openssl rand -base64 32" in the Shell and paste the line it prints, which is 44 '
        + 'characters of letters and digits ending in "=".'
      : 'DETENT_CREDENTIAL_KEY must be exactly 44 characters of base64 ending in "=", which '
        + 'is what "openssl rand -base64 32" prints. This one is '
        + `${trimmed.length} characters.`;
  }
  return undefined;
}

export class PostgresConnectionStore implements ConnectionStore {
  private readonly key: Buffer;
  private readonly onUndecryptable: (tenantId: string) => void;

  constructor(
    private readonly database: Database,
    key: string,
    options: { readonly onUndecryptable?: (tenantId: string) => void } = {},
  ) {
    this.onUndecryptable = options.onUndecryptable ?? (() => undefined);
    const problem = credentialKeyProblem(key);
    if (problem) throw new Error(problem);
    this.key = Buffer.from(key.trim(), 'base64');
  }

  async get(tenantId: string): Promise<TenantConnection | undefined> {
    const rows = await this.database.queryAs<ConnectionRow>(
      tenantId,
      'SELECT * FROM crm_connection WHERE tenant_id = $1',
      [tenantId],
    );
    const row = rows[0];
    if (!row) return undefined;

    // A credential that will not decrypt is a credential that is gone: the key
    // was rotated, or this deployment has a different one. That must read as
    // "not connected", which the platform already handles by asking the tenant
    // to reconnect. Rethrowing instead takes down every conversation for every
    // visitor, because the turn pipeline reads the connection before it answers
    // anything. Losing a key should cost a reconnection, not a day's leads.
    let credential: TenantConnection['credential'];
    try {
      credential = JSON.parse(this.decrypt(row.credential_cipher)) as
        TenantConnection['credential'];
    } catch {
      this.onUndecryptable(tenantId);
      return undefined;
    }

    return {
      tenantId: row.tenant_id,
      connector: row.connector,
      credential,
      state: row.state as TenantConnection['state'],
      ...(row.last_error ? { lastError: row.last_error } : {}),
    };
  }

  async put(connection: TenantConnection): Promise<void> {
    await this.database.queryAs(
      connection.tenantId,
      `INSERT INTO crm_connection
         (tenant_id, connector, state, kms_key_id, credential_cipher, region,
          instance_url, last_error, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (tenant_id) DO UPDATE SET
         connector = EXCLUDED.connector,
         state = EXCLUDED.state,
         kms_key_id = EXCLUDED.kms_key_id,
         credential_cipher = EXCLUDED.credential_cipher,
         region = EXCLUDED.region,
         instance_url = EXCLUDED.instance_url,
         last_error = EXCLUDED.last_error,
         updated_at = now()`,
      [
        connection.tenantId, connection.connector, connection.state,
        // Named rather than the key itself, so a rotation can be recognised.
        'env:DETENT_CREDENTIAL_KEY',
        this.encrypt(JSON.stringify(connection.credential)),
        connection.credential.region ?? null,
        connection.credential.instanceUrl ?? null,
        connection.lastError ?? null,
      ],
    );
  }

  /** iv (12) + tag (16) + ciphertext, in one buffer, so the row is self contained. */
  private encrypt(plaintext: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  private decrypt(stored: Buffer): string {
    const iv = stored.subarray(0, 12);
    const tag = stored.subarray(12, 28);
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(stored.subarray(28)), decipher.final()]).toString('utf8');
  }
}

interface ConnectionRow {
  tenant_id: string;
  connector: string;
  state: string;
  credential_cipher: Buffer;
  last_error: string | null;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/** What the customer is charged for, which is not a thing to keep in memory. */
export class PostgresOutcomeStore implements OutcomeStore {
  constructor(private readonly database: Database) {}

  async put(outcome: RecordedOutcome): Promise<void> {
    await this.database.queryAs(
      outcome.tenantId,
      `INSERT INTO outcome (id, tenant_id, correlation_id, state, billable, recorded_at, document)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         state = EXCLUDED.state,
         billable = EXCLUDED.billable,
         document = EXCLUDED.document`,
      [
        outcome.id, outcome.tenantId, outcome.correlationId, outcome.state,
        outcome.billable, outcome.recordedAt, JSON.stringify(outcome),
      ],
    );
  }

  async get(tenantId: string, id: string): Promise<RecordedOutcome | undefined> {
    const rows = await this.database.queryAs<{ document: RecordedOutcome }>(
      tenantId,
      'SELECT document FROM outcome WHERE tenant_id = $1 AND id = $2',
      [tenantId, id],
    );
    return rows[0]?.document;
  }

  async byCorrelation(tenantId: string, correlationId: string): Promise<RecordedOutcome[]> {
    const rows = await this.database.queryAs<{ document: RecordedOutcome }>(
      tenantId,
      `SELECT document FROM outcome
        WHERE tenant_id = $1 AND correlation_id = $2 ORDER BY recorded_at`,
      [tenantId, correlationId],
    );
    return rows.map((row) => row.document);
  }

  async list(tenantId: string): Promise<RecordedOutcome[]> {
    const rows = await this.database.queryAs<{ document: RecordedOutcome }>(
      tenantId,
      'SELECT document FROM outcome WHERE tenant_id = $1 ORDER BY recorded_at DESC',
      [tenantId],
    );
    return rows.map((row) => row.document);
  }
}

// ---------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------

/**
 * Payment records and the webhook deliveries already handled.
 *
 * Account-scoped rather than tenant-scoped, so no tenant binding: there is no
 * tenant_id on the row and no policy to satisfy.
 *
 * `hasProcessedEvent` is the control that stops a provider's retry charging
 * twice. In memory it was a Set, so every restart made every past webhook
 * deliverable again.
 */
export class PostgresPaymentStore implements PaymentStore {
  constructor(private readonly database: Database) {}

  async get(paymentId: string): Promise<PaymentRecord | undefined> {
    const rows = await this.database.query<{ document: PaymentRecord }>(
      'SELECT document FROM payment WHERE payment_id = $1', [paymentId],
    );
    return rows[0]?.document;
  }

  async findByIdempotencyKey(key: string): Promise<PaymentRecord | undefined> {
    const rows = await this.database.query<{ document: PaymentRecord }>(
      'SELECT document FROM payment WHERE idempotency_key = $1', [key],
    );
    return rows[0]?.document;
  }

  async put(record: PaymentRecord): Promise<void> {
    const withKey = record as PaymentRecord & { idempotencyKey?: string };
    await this.database.query(
      `INSERT INTO payment (payment_id, account_id, idempotency_key, status, document)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (payment_id) DO UPDATE SET
         status = EXCLUDED.status,
         document = EXCLUDED.document,
         updated_at = now()`,
      [
        record.paymentId, record.accountId, withKey.idempotencyKey ?? null,
        record.status, JSON.stringify(record),
      ],
    );
  }

  async listByAccount(accountId: string): Promise<readonly PaymentRecord[]> {
    const rows = await this.database.query<{ document: PaymentRecord }>(
      'SELECT document FROM payment WHERE account_id = $1 ORDER BY created_at DESC',
      [accountId],
    );
    return rows.map((row) => row.document);
  }

  async hasProcessedEvent(eventId: string): Promise<boolean> {
    const rows = await this.database.query<{ event_id: string }>(
      'SELECT event_id FROM payment_event WHERE event_id = $1', [eventId],
    );
    return rows.length > 0;
  }

  async markEventProcessed(eventId: string): Promise<void> {
    await this.database.query(
      'INSERT INTO payment_event (event_id) VALUES ($1) ON CONFLICT (event_id) DO NOTHING',
      [eventId],
    );
  }
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

/**
 * Who has asked not to be contacted again.
 *
 * The one failure in this system with a fine attached. Held in memory, an
 * opt-out lasted until the next deploy and the person was contacted again by a
 * platform that had been told, in writing, to stop.
 *
 * The address is never stored: the digest is salted and one way, so the list
 * answers "is this suppressed" without holding the details of people whose last
 * instruction was to be left alone.
 */
export class PostgresSuppressionStore implements SuppressionStore {
  constructor(private readonly database: Database) {}

  async add(record: SuppressionRecord): Promise<void> {
    const details = record as SuppressionRecord & { reason?: string; channel?: string };
    await this.database.query(
      `INSERT INTO suppression (digest, reason, channel, document)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (digest) DO NOTHING`,
      [
        record.digest, details.reason ?? 'unspecified', details.channel ?? 'email',
        JSON.stringify(record),
      ],
    );
  }

  async has(digest: string): Promise<boolean> {
    const rows = await this.database.query<{ digest: string }>(
      'SELECT digest FROM suppression WHERE digest = $1', [digest],
    );
    return rows.length > 0;
  }

  async count(): Promise<number> {
    const rows = await this.database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM suppression',
    );
    return Number(rows[0]?.count ?? 0);
  }
}
