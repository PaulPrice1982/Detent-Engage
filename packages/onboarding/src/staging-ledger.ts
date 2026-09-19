import { newId, type CanonicalWriteEnvelope, type Clock, systemClock } from '@detent/awa-core';

/**
 * Dry-run staging ledger (FR-036, section 38.3 step 8).
 *
 * "The first 10 conversations write to a staging ledger, not the CRM."
 *
 * The point is that the writes are *real*: fully validated, fully policied,
 * fully formed canonical envelopes that the adapter would have executed. They
 * simply land here instead, so the tenant sees exactly what would have happened
 * to their CRM before anything does. A preview that showed a simulation rather
 * than the actual envelope would be reassuring and worthless.
 */
export interface StagedWrite {
  readonly id: string;
  readonly tenantId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly operation: string;
  readonly envelope: CanonicalWriteEnvelope;
  readonly stagedAt: string;
  /** Set once the tenant accepts the diff and the write is replayed for real. */
  readonly appliedAt?: string;
}

export interface WriteDiffLine {
  readonly operation: string;
  readonly objectType: string;
  readonly summary: string;
  readonly fields: Readonly<Record<string, unknown>>;
  /** Fields the write will not touch, named so their absence is visible. */
  readonly untouched: readonly string[];
}

export interface WriteDiff {
  readonly tenantId: string;
  readonly writes: readonly WriteDiffLine[];
  readonly totalWrites: number;
  readonly conversationsCovered: number;
}

export class StagingLedger {
  private readonly staged = new Map<string, StagedWrite[]>();

  constructor(private readonly clock: Clock = systemClock) {}

  stage(envelope: CanonicalWriteEnvelope): StagedWrite {
    const entry: StagedWrite = {
      id: newId('wr', this.clock.nowMs()),
      tenantId: envelope.tenantId,
      correlationId: envelope.correlationId,
      idempotencyKey: envelope.idempotencyKey,
      operation: envelope.operation,
      envelope,
      stagedAt: this.clock.iso(),
    };
    const list = this.staged.get(envelope.tenantId) ?? [];
    list.push(entry);
    this.staged.set(envelope.tenantId, list);
    return entry;
  }

  pending(tenantId: string): StagedWrite[] {
    return (this.staged.get(tenantId) ?? []).filter((entry) => !entry.appliedAt);
  }

  /**
   * The diff the tenant reads before go-live. It names the fields that will be
   * written and, deliberately, the fields that will not: "owner: not touched"
   * is the line that answers the RevOps buyer's actual question.
   */
  diff(tenantId: string): WriteDiff {
    const pending = this.pending(tenantId);
    const correlations = new Set(pending.map((entry) => entry.correlationId));

    return {
      tenantId,
      totalWrites: pending.length,
      conversationsCovered: correlations.size,
      writes: pending.map((entry) => {
        const canonical = entry.envelope.canonical as unknown as Record<string, unknown>;
        const fields = Object.fromEntries(
          Object.entries(canonical).filter(([, value]) => value !== undefined),
        );
        return {
          operation: entry.operation,
          objectType: describeObject(entry.operation),
          summary: summarise(entry.operation, canonical),
          fields,
          untouched: [...entry.envelope.forbiddenFields],
        };
      }),
    };
  }

  /** Mark staged writes applied once the tenant has accepted the diff. */
  accept(tenantId: string): StagedWrite[] {
    const pending = this.pending(tenantId);
    const applied = pending.map((entry) => ({ ...entry, appliedAt: this.clock.iso() }));
    const remaining = (this.staged.get(tenantId) ?? []).filter((entry) => entry.appliedAt);
    this.staged.set(tenantId, [...remaining, ...applied]);
    return applied;
  }

  /** Discard staged writes without applying them, e.g. after a mapping change. */
  discard(tenantId: string): number {
    const pending = this.pending(tenantId);
    this.staged.set(tenantId, (this.staged.get(tenantId) ?? []).filter((entry) => entry.appliedAt));
    return pending.length;
  }
}

function describeObject(operation: string): string {
  if (operation.includes('person')) return 'person';
  if (operation.includes('organisation')) return 'organisation';
  if (operation.includes('note')) return 'note';
  if (operation.includes('task')) return 'task';
  if (operation.includes('meeting')) return 'meeting';
  return operation;
}

function summarise(operation: string, canonical: Record<string, unknown>): string {
  const emails = canonical['emails'];
  if (Array.isArray(emails) && emails[0]) return `${operation} for ${String(emails[0])}`;
  const subject = canonical['subject'];
  if (typeof subject === 'string') return `${operation}: ${subject}`;
  const domains = canonical['domains'];
  if (Array.isArray(domains) && domains[0]) return `${operation} for ${String(domains[0])}`;
  return operation;
}
