import { AwaError, type CanonicalWriteEnvelope, type Clock, type Logger, silentLogger, systemClock } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import type { CrmAdapter } from './adapter.js';
import type { WriteReceiptService } from './receipts.js';

/**
 * Reconciliation of parked CRM writes (audit PERF-8).
 *
 * The finding: "reconciliation of parked writes is an in-memory list with no
 * worker". The receipt survived a failure, and an operator could list what was
 * waiting, but nothing ever retried it, so a CRM outage turned into a queue
 * somebody had to work by hand.
 *
 * Replay is safe because of the design that was already there: every write
 * carries an idempotency key, the receipt is claimed before the external call,
 * and a confirmed receipt short-circuits the call and returns the original
 * external id. A replayed write therefore produces one CRM record or none,
 * never a duplicate. That property is why the worker can be blunt.
 *
 * What the worker will not do is the important half. It never replays a write
 * whose failure was final rather than retryable (those are `FAILED`, not
 * `RECONCILING`); it stops after a bounded number of attempts and leaves the
 * receipt for a human rather than hammering a broken integration forever; and
 * it never invents an envelope it does not hold.
 */
export interface ParkedWrite {
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly envelope: CanonicalWriteEnvelope;
  readonly parkedAt: string;
  attempts: number;
  lastError?: string;
}

export interface ParkedWriteStore {
  put(parked: ParkedWrite): Promise<void>;
  remove(tenantId: string, idempotencyKey: string): Promise<void>;
  list(tenantId: string): Promise<ParkedWrite[]>;
  /** Tenants with anything parked, so the worker does not scan every tenant. */
  tenants(): Promise<string[]>;
}

export class InMemoryParkedWriteStore implements ParkedWriteStore {
  private readonly parked = new Map<string, ParkedWrite>();
  private key(tenantId: string, idempotencyKey: string): string { return `${tenantId}::${idempotencyKey}`; }

  async put(parked: ParkedWrite): Promise<void> {
    const key = this.key(parked.tenantId, parked.idempotencyKey);
    const existing = this.parked.get(key);
    this.parked.set(key, existing ? { ...existing, attempts: parked.attempts, lastError: parked.lastError } : parked);
  }

  async remove(tenantId: string, idempotencyKey: string): Promise<void> {
    this.parked.delete(this.key(tenantId, idempotencyKey));
  }

  async list(tenantId: string): Promise<ParkedWrite[]> {
    return [...this.parked.values()].filter((parked) => parked.tenantId === tenantId);
  }

  async tenants(): Promise<string[]> {
    return [...new Set([...this.parked.values()].map((parked) => parked.tenantId))];
  }
}

export interface ReconciliationResult {
  readonly attempted: number;
  readonly reconciled: number;
  readonly stillParked: number;
  readonly abandoned: number;
}

export interface ReconciliationOptions {
  /** Attempts before a parked write is left for a human. */
  readonly maxAttempts?: number;
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export class ReconciliationWorker {
  private readonly maxAttempts: number;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private running = false;

  constructor(
    private readonly adapter: CrmAdapter,
    private readonly parked: ParkedWriteStore,
    private readonly receipts: WriteReceiptService,
    private readonly audit: AuditLog,
    options: ReconciliationOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 8;
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? silentLogger;
  }

  /** Replay everything parked for one tenant. */
  async runForTenant(tenantId: string): Promise<ReconciliationResult> {
    const queue = await this.parked.list(tenantId);
    let reconciled = 0;
    let abandoned = 0;

    for (const item of queue) {
      // A connection that is still degraded fails every write in the queue, so
      // stop at the first refusal rather than burning the whole backlog's
      // attempt budget on one outage.
      const state = await this.adapter.connectionState(tenantId);
      if (state !== 'CONNECTED') break;

      try {
        const result = await this.adapter.write(item.envelope);
        await this.parked.remove(tenantId, item.idempotencyKey);
        reconciled += 1;
        await this.audit.write({
          tenantId,
          type: 'crm_write_reconciled',
          correlationId: item.envelope.correlationId,
          actor: 'system',
          payload: {
            operation: item.envelope.operation,
            externalId: result.externalId,
            created: result.created,
            attempts: item.attempts + 1,
            parkedAt: item.parkedAt,
          },
        });
      } catch (cause) {
        const error = cause instanceof AwaError ? cause : new AwaError({ kind: 'INTERNAL', message: String(cause), cause });
        const attempts = item.attempts + 1;
        if (attempts >= this.maxAttempts || !error.retryable) {
          // Left for a human, with the reason, rather than retried forever or
          // dropped. A parked write that silently disappears is worse than one
          // that needs attention.
          await this.parked.remove(tenantId, item.idempotencyKey);
          abandoned += 1;
          this.logger.warn('parked CRM write abandoned', {
            tenantId, correlationId: item.envelope.correlationId,
            operation: item.envelope.operation, attempts, error: error.message,
          });
          await this.audit.write({
            tenantId,
            type: 'tool_call_failed',
            correlationId: item.envelope.correlationId,
            actor: 'system',
            payload: { stage: 'reconciliation', operation: item.envelope.operation, attempts, kind: error.kind },
          });
        } else {
          await this.parked.put({ ...item, attempts, lastError: error.message });
        }
      }
    }

    const remaining = await this.parked.list(tenantId);
    return { attempted: queue.length, reconciled, stillParked: remaining.length, abandoned };
  }

  /**
   * One pass over every tenant with a backlog.
   *
   * Guarded against overlapping runs: a slow CRM plus a short timer is how a
   * reconciliation worker turns into a self-inflicted flood.
   */
  async runOnce(): Promise<ReconciliationResult> {
    if (this.running) return { attempted: 0, reconciled: 0, stillParked: 0, abandoned: 0 };
    this.running = true;
    const total = { attempted: 0, reconciled: 0, stillParked: 0, abandoned: 0 };
    try {
      for (const tenantId of await this.parked.tenants()) {
        const result = await this.runForTenant(tenantId);
        total.attempted += result.attempted;
        total.reconciled += result.reconciled;
        total.stillParked += result.stillParked;
        total.abandoned += result.abandoned;
      }
    } finally {
      this.running = false;
    }
    return total;
  }

  /** Oldest parked write for a tenant, in seconds. Drives the backlog alert. */
  async oldestAgeSeconds(tenantId: string): Promise<number | undefined> {
    const queue = await this.parked.list(tenantId);
    if (queue.length === 0) return undefined;
    const oldest = queue.reduce((a, b) => (a.parkedAt <= b.parkedAt ? a : b));
    return Math.max(0, Math.round((this.clock.nowMs() - Date.parse(oldest.parkedAt)) / 1000));
  }

  /** Receipts waiting on reconciliation, for the operator endpoint. */
  async backlog(tenantId: string): Promise<{ pending: number; oldestAgeSeconds?: number }> {
    const receipts = await this.receipts.pendingReconciliation(tenantId);
    return { pending: receipts.length, oldestAgeSeconds: await this.oldestAgeSeconds(tenantId) };
  }
}
