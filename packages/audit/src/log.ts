import { createHash, createHmac } from 'node:crypto';
import { newId, redactObject, type Clock, systemClock } from '@detent/awa-core';
import { canonicalJson } from './canonicalise.js';
import type { AuditEntry, AuditEntryInput, ChainVerification } from './types.js';

/**
 * Append-only, hash-chained audit log (section 29).
 *
 * The chain is per tenant. That is a deliberate isolation choice: a
 * platform-wide chain would let one tenant's export reveal the existence and
 * ordering of another tenant's activity, and would make a per-tenant erasure
 * or export request an operation on shared state.
 *
 * Two changes from the audit findings shape this file:
 *
 *  - PERF-2: verification was O(entire history) on every analytics call, and
 *    three services called it per dashboard load. Verification now runs
 *    incrementally from the last signed checkpoint, so routine verification is
 *    O(entries since the checkpoint) and a full walk is something an operator
 *    asks for explicitly.
 *  - PERF-5 and SEC-10: the per-tenant write queue never released its entries,
 *    and three callers used `void this.audit.write(...)` — a failed append on a
 *    config or lifecycle change was discarded silently, which contradicts the
 *    append-before-act guarantee stated everywhere else. Queue entries are now
 *    evicted when they drain, and the fire-and-forget writes have been replaced
 *    by awaited ones at their call sites.
 */
export const GENESIS_HASH = '0'.repeat(64);

export interface ListOptions {
  readonly limit?: number;
  readonly sinceSequence?: number;
  readonly toSequence?: number;
  /** Inclusive ISO lower bound on `recordedAt`. */
  readonly from?: string;
  /** Inclusive ISO upper bound on `recordedAt`. */
  readonly to?: string;
}

export interface AuditStore {
  append(entry: AuditEntry): Promise<void>;
  lastEntry(tenantId: string): Promise<AuditEntry | undefined>;
  /** Oldest entry, used to clamp an all-time reporting window to real data. */
  firstEntry(tenantId: string): Promise<AuditEntry | undefined>;
  list(tenantId: string, options?: ListOptions): Promise<AuditEntry[]>;
  findByCorrelation(tenantId: string, correlationId: string): Promise<AuditEntry[]>;
  /** Total entries for a tenant, for pagination metadata. */
  count(tenantId: string): Promise<number>;
}

export class InMemoryAuditStore implements AuditStore {
  private readonly byTenant = new Map<string, AuditEntry[]>();

  async append(entry: AuditEntry): Promise<void> {
    const list = this.byTenant.get(entry.tenantId) ?? [];
    list.push(entry);
    this.byTenant.set(entry.tenantId, list);
  }

  async lastEntry(tenantId: string): Promise<AuditEntry | undefined> {
    const list = this.byTenant.get(tenantId);
    return list?.[list.length - 1];
  }

  async firstEntry(tenantId: string): Promise<AuditEntry | undefined> {
    return this.byTenant.get(tenantId)?.[0];
  }

  async list(tenantId: string, options: ListOptions = {}): Promise<AuditEntry[]> {
    const all = this.byTenant.get(tenantId) ?? [];
    let filtered = all;
    if (options.sinceSequence !== undefined) {
      filtered = filtered.filter((entry) => entry.sequence > options.sinceSequence!);
    }
    if (options.toSequence !== undefined) {
      filtered = filtered.filter((entry) => entry.sequence <= options.toSequence!);
    }
    // Time bounds are applied in the store rather than by the caller so that a
    // Postgres adapter answers them from an index on (tenant_id, recorded_at)
    // instead of returning the tenant's entire history to be filtered in
    // application memory (audit PERF-2).
    if (options.from !== undefined) filtered = filtered.filter((entry) => entry.recordedAt >= options.from!);
    if (options.to !== undefined) filtered = filtered.filter((entry) => entry.recordedAt <= options.to!);
    return options.limit ? filtered.slice(0, options.limit) : [...filtered];
  }

  async findByCorrelation(tenantId: string, correlationId: string): Promise<AuditEntry[]> {
    return (this.byTenant.get(tenantId) ?? []).filter((e) => e.correlationId === correlationId);
  }

  async count(tenantId: string): Promise<number> {
    return (this.byTenant.get(tenantId) ?? []).length;
  }
}

/**
 * A signed statement that the chain was intact up to a sequence number.
 *
 * The signature is what makes a checkpoint worth trusting: without it, a
 * checkpoint is only a claim that the process which wrote it had verified the
 * chain, and an attacker who can write checkpoints can skip verification of
 * everything before one. With an HMAC under a key the application holds and the
 * database does not, a forged checkpoint fails to open.
 */
export interface ChainCheckpoint {
  readonly tenantId: string;
  readonly sequence: number;
  readonly hash: string;
  readonly verifiedAt: string;
  readonly signature: string;
}

export interface CheckpointStore {
  latest(tenantId: string): Promise<ChainCheckpoint | undefined>;
  put(checkpoint: ChainCheckpoint): Promise<void>;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly byTenant = new Map<string, ChainCheckpoint>();
  async latest(tenantId: string): Promise<ChainCheckpoint | undefined> { return this.byTenant.get(tenantId); }
  async put(checkpoint: ChainCheckpoint): Promise<void> { this.byTenant.set(checkpoint.tenantId, checkpoint); }
}

export function hashEntry(entry: Omit<AuditEntry, 'hash'>): string {
  // The hash covers the previous hash and every field of the entry, so
  // reordering, editing or deleting an entry breaks every entry after it.
  return createHash('sha256').update(canonicalJson(entry)).digest('hex');
}

export interface AuditLogOptions {
  readonly checkpoints?: CheckpointStore;
  /** HMAC key for checkpoint signatures. Held by the application, not the store. */
  readonly checkpointKey?: string;
  /** Entries between checkpoints. Lower means cheaper verification, more writes. */
  readonly checkpointInterval?: number;
  /** Idle milliseconds after which a drained write queue entry is evicted. */
  readonly queueIdleMs?: number;
}

export interface ExportPage {
  readonly entries: AuditEntry[];
  readonly verification: ChainVerification;
  readonly page: {
    readonly fromSequence: number;
    readonly toSequence: number;
    readonly returned: number;
    readonly total: number;
    /** Sequence to pass as `sinceSequence` for the next page, if any. */
    readonly nextCursor?: number;
  };
}

export class AuditLog {
  private readonly writeQueues = new Map<string, Promise<unknown>>();
  private readonly checkpoints?: CheckpointStore;
  private readonly checkpointKey: string;
  private readonly checkpointInterval: number;

  constructor(
    private readonly store: AuditStore,
    private readonly clock: Clock = systemClock,
    options: AuditLogOptions = {},
  ) {
    this.checkpoints = options.checkpoints;
    this.checkpointKey = options.checkpointKey ?? 'awa-dev-checkpoint-key';
    this.checkpointInterval = options.checkpointInterval ?? 500;
  }

  /**
   * Append an entry. Writes for a single tenant are serialised through a
   * per-tenant promise chain: two concurrent appends reading the same
   * `previousHash` would fork the chain and both would verify individually
   * while the log as a whole became unreconstructable.
   */
  async write(input: AuditEntryInput): Promise<AuditEntry> {
    const previous = this.writeQueues.get(input.tenantId) ?? Promise.resolve();
    const next = previous.then(() => this.appendSerialised(input));
    // Swallow rejection on the queue itself so one failed append does not
    // poison every later append for that tenant.
    const queued = next.then(() => undefined, () => undefined).then(() => {
      // Evict once drained. The map used to grow one entry per tenant forever,
      // which on a platform with many tenants is an unbounded leak in the one
      // component that must never run out of memory.
      if (this.writeQueues.get(input.tenantId) === queued) this.writeQueues.delete(input.tenantId);
    });
    this.writeQueues.set(input.tenantId, queued);
    return next;
  }

  /** Queued-but-not-yet-written appends. Exposed for shutdown and for tests. */
  async drain(tenantId?: string): Promise<void> {
    const queues = tenantId
      ? [this.writeQueues.get(tenantId)].filter(Boolean)
      : [...this.writeQueues.values()];
    await Promise.all(queues.map((queue) => queue!.catch(() => undefined)));
  }

  private async appendSerialised(input: AuditEntryInput): Promise<AuditEntry> {
    const last = await this.store.lastEntry(input.tenantId);
    const unhashed: Omit<AuditEntry, 'hash'> = {
      ...input,
      payload: input.payload ? (redactObject(input.payload) as Record<string, unknown>) : undefined,
      id: newId('aud', this.clock.nowMs()),
      sequence: (last?.sequence ?? 0) + 1,
      recordedAt: this.clock.iso(),
      previousHash: last?.hash ?? GENESIS_HASH,
    };
    const entry: AuditEntry = { ...unhashed, hash: hashEntry(unhashed) };
    await this.store.append(entry);
    return entry;
  }

  private signCheckpoint(tenantId: string, sequence: number, hash: string, verifiedAt: string): string {
    return createHmac('sha256', this.checkpointKey)
      .update(`${tenantId}|${sequence}|${hash}|${verifiedAt}`)
      .digest('hex');
  }

  private checkpointValid(checkpoint: ChainCheckpoint): boolean {
    const expected = this.signCheckpoint(
      checkpoint.tenantId, checkpoint.sequence, checkpoint.hash, checkpoint.verifiedAt,
    );
    return expected === checkpoint.signature;
  }

  /**
   * Verify the chain.
   *
   * By default this resumes from the latest valid checkpoint: the expensive
   * part of verification is recomputing a SHA-256 over the canonical JSON of
   * every entry ever written, and an entry already covered by a signed
   * checkpoint does not need recomputing on every dashboard load. Pass
   * `{ full: true }` to walk the whole chain regardless — which is what a
   * nightly integrity job and a disputed-conversation review should do.
   */
  async verify(tenantId: string, options: { full?: boolean } = {}): Promise<ChainVerification> {
    const checkpoint = options.full ? undefined : await this.checkpoints?.latest(tenantId);
    const usable = checkpoint && this.checkpointValid(checkpoint) ? checkpoint : undefined;

    const entries = await this.store.list(
      tenantId,
      usable ? { sinceSequence: usable.sequence } : {},
    );
    let expectedPrevious = usable?.hash ?? GENESIS_HASH;
    let expectedSequence = (usable?.sequence ?? 0) + 1;

    for (const [index, entry] of entries.entries()) {
      if (entry.sequence !== expectedSequence + index) {
        return {
          valid: false,
          checked: (usable?.sequence ?? 0) + index,
          brokenAtSequence: entry.sequence,
          reason: 'sequence gap or reorder',
        };
      }
      if (entry.previousHash !== expectedPrevious) {
        return {
          valid: false,
          checked: (usable?.sequence ?? 0) + index,
          brokenAtSequence: entry.sequence,
          reason: 'previous hash mismatch',
        };
      }
      const { hash, ...rest } = entry;
      if (hashEntry(rest) !== hash) {
        return {
          valid: false,
          checked: (usable?.sequence ?? 0) + index,
          brokenAtSequence: entry.sequence,
          reason: 'entry content altered',
        };
      }
      expectedPrevious = hash;
    }

    const checked = (usable?.sequence ?? 0) + entries.length;
    await this.maybeCheckpoint(tenantId, checked, expectedPrevious, usable?.sequence ?? 0);
    return { valid: true, checked, ...(usable ? { resumedFromSequence: usable.sequence } : {}) } as ChainVerification;
  }

  private async maybeCheckpoint(
    tenantId: string,
    sequence: number,
    hash: string,
    previousSequence: number,
  ): Promise<void> {
    if (!this.checkpoints) return;
    if (sequence === 0) return;
    if (sequence - previousSequence < this.checkpointInterval) return;
    const verifiedAt = this.clock.iso();
    await this.checkpoints.put({
      tenantId, sequence, hash, verifiedAt,
      signature: this.signCheckpoint(tenantId, sequence, hash, verifiedAt),
    });
  }

  /** Force a checkpoint after a full verification. Used by the integrity job. */
  async checkpoint(tenantId: string): Promise<ChainCheckpoint | undefined> {
    if (!this.checkpoints) return undefined;
    const verification = await this.verify(tenantId, { full: true });
    if (!verification.valid) return undefined;
    const last = await this.store.lastEntry(tenantId);
    if (!last) return undefined;
    const verifiedAt = this.clock.iso();
    const checkpoint: ChainCheckpoint = {
      tenantId, sequence: last.sequence, hash: last.hash, verifiedAt,
      signature: this.signCheckpoint(tenantId, last.sequence, last.hash, verifiedAt),
    };
    await this.checkpoints.put(checkpoint);
    return checkpoint;
  }

  /**
   * Entries recorded within a time window, without walking or hashing anything
   * outside it. This is what the analytics services read; none of them needs
   * the chain recomputed, and all three used to force one on every call.
   */
  async entriesInWindow(tenantId: string, window: { from: string; to: string }): Promise<AuditEntry[]> {
    return this.store.list(tenantId, { from: window.from, to: window.to });
  }

  /** Oldest recorded entry, used to clamp an all-time window to real data. */
  async firstEntry(tenantId: string): Promise<AuditEntry | undefined> {
    return this.store.firstEntry(tenantId);
  }

  async lastEntry(tenantId: string): Promise<AuditEntry | undefined> {
    return this.store.lastEntry(tenantId);
  }

  /**
   * Reconstruct everything the platform did under one correlation id. This is
   * the replayability that makes the governance claim in section 33.4
   * demonstrable to a buyer rather than merely asserted.
   */
  async replay(tenantId: string, correlationId: string): Promise<AuditEntry[]> {
    const entries = await this.store.findByCorrelation(tenantId, correlationId);
    return entries.sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Paginated export (audit SEC-10).
   *
   * The unpaginated version materialised a tenant's entire chain in one
   * response and then serialised it again in the HTTP layer — two copies of
   * every entry ever written, on a route a DPO is encouraged to use.
   */
  async export(
    tenantId: string,
    options: { sinceSequence?: number; toSequence?: number; limit?: number } = {},
  ): Promise<ExportPage> {
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 5_000);
    const entries = await this.store.list(tenantId, {
      sinceSequence: options.sinceSequence,
      toSequence: options.toSequence,
      limit: limit + 1,
    });
    const hasMore = entries.length > limit;
    const page = hasMore ? entries.slice(0, limit) : entries;
    const verification = await this.verify(tenantId);
    const total = await this.store.count(tenantId);

    return {
      entries: page,
      verification,
      page: {
        fromSequence: page[0]?.sequence ?? 0,
        toSequence: page[page.length - 1]?.sequence ?? 0,
        returned: page.length,
        total,
        nextCursor: hasMore ? page[page.length - 1]!.sequence : undefined,
      },
    };
  }
}
