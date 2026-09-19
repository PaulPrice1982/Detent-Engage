import type { AuditLog } from '@detent/awa-audit';
import type { WriteReceiptService } from '@detent/awa-connectors';
import { payloadOf, payloadString, type ReportWindow } from './window.js';

/**
 * The CRM data quality scorecard (section 41.2, FR-050).
 *
 * "The v1.0 specification's write fidelity work is invisible in a demo and
 * decisive in month three. This surface makes it visible in week one."
 *
 * The most important number on it is one that should always read zero: owner
 * overwrites blocked. Reading zero *is the point*, it is the difference
 * between a vendor claiming it protects ownership and a vendor showing a
 * counter that has never moved, derived from a log that verifies.
 *
 * No competitor publishes any of this, because no competitor can. It converts
 * section 28's failure handling from an engineering virtue into a renewal
 * argument.
 */
export interface PreventedDuplicate {
  readonly externalId: string;
  readonly operation: string;
  readonly at: string;
  readonly mechanism: 'idempotency_receipt' | 'native_upsert' | 'conflict_converted_to_update';
}

export interface BlockedProtection {
  readonly fields: readonly string[];
  readonly at: string;
  readonly correlationId: string;
}

export interface DataQualityScorecard {
  readonly tenantId: string;
  readonly window: ReportWindow;
  readonly generatedAt: string;

  /** Every upsert that resolved to an existing record instead of creating one. */
  readonly duplicatesPrevented: readonly PreventedDuplicate[];
  readonly duplicatesPreventedCount: number;

  /** Should always read zero. Reading zero is the point. */
  readonly ownerOverwritesBlocked: readonly BlockedProtection[];
  readonly lifecycleStageProtections: readonly BlockedProtection[];

  /** Cases where the assistant declined to guess, with the resolution. */
  readonly ambiguousMatchesEscalated: number;
  readonly suspectedDuplicatesRaised: number;

  /** Records improved by confirmed capture. */
  readonly fieldCompleteness: {
    readonly recordsWritten: number;
    readonly recordsCreated: number;
    readonly recordsUpdated: number;
  };

  /** Queued writes awaiting CRM recovery, and the age of the oldest. */
  readonly reconciliationBacklog: {
    readonly pending: number;
    readonly oldestAgeSeconds?: number;
  };

  /** Rolling measured precision on the tenant's own data, not a marketing claim. */
  readonly deduplicationPrecision: {
    readonly confidentMatchesActedOn: number;
    readonly ambiguousDeclined: number;
    /** Confident matches as a share of all resolutions that found a candidate. */
    readonly precisionPct: number | undefined;
    readonly note: string;
  };

  readonly evidence: { readonly chainVerified: boolean; readonly auditEntriesExamined: number };
}

export class DataQualityScorecardService {
  constructor(
    private readonly audit: AuditLog,
    private readonly receipts: WriteReceiptService,
  ) {}

  async build(tenantId: string, window: ReportWindow, generatedAt: string, nowMs: number): Promise<DataQualityScorecard> {
    // Ranged query plus checkpointed verification (audit PERF-2). This used to
    // export and re-hash the tenant's whole chain on every load.
    const entries = await this.audit.entriesInWindow(tenantId, window);
    const verification = await this.audit.verify(tenantId);

    const duplicatesPrevented: PreventedDuplicate[] = [];
    let recordsCreated = 0;
    let recordsUpdated = 0;

    for (const entry of entries) {
      if (entry.type !== 'crm_write_confirmed') continue;
      const payload = payloadOf(entry);
      const created = payload['created'] === true;
      const converted = payload['convertedFromCreate'] === true;
      const operation = String(payload['operation'] ?? 'unknown');
      const externalId = String(payload['externalId'] ?? '');

      if (created) {
        recordsCreated++;
        continue;
      }
      recordsUpdated++;

      // An upsert that resolved to an existing record is a duplicate that was
      // not created. Only person and organisation writes count: an updated note
      // is not a prevented duplicate.
      if (operation === 'upsert_person' || operation === 'upsert_organisation') {
        duplicatesPrevented.push({
          externalId,
          operation,
          at: entry.recordedAt,
          mechanism: converted ? 'conflict_converted_to_update' : 'native_upsert',
        });
      }
    }

    // Source-of-truth refusals. These are policy denials naming the fields.
    const ownerOverwritesBlocked: BlockedProtection[] = [];
    const lifecycleStageProtections: BlockedProtection[] = [];

    for (const entry of entries) {
      if (entry.type !== 'policy_denied' && entry.type !== 'tool_call_failed') continue;
      const serialised = JSON.stringify(payloadOf(entry));
      if (!/CRM-authoritative|forbidden/i.test(serialised)) continue;
      const fields = extractFields(serialised);
      const record: BlockedProtection = { fields, at: entry.recordedAt, correlationId: entry.correlationId };
      if (fields.some((field) => /owner/i.test(field))) ownerOverwritesBlocked.push(record);
      if (fields.some((field) => /lifecycle|pipeline|stage/i.test(field))) lifecycleStageProtections.push(record);
    }

    const ambiguous = entries.filter((entry) => entry.type === 'ambiguous_match').length;
    const suspected = entries.filter((entry) => entry.type === 'duplicate_suspected').length;
    const resolutionsComplete = entries.filter((entry) => entry.type === 'resolution_complete');
    const confident = resolutionsComplete.filter((entry) => {
      const classification = payloadString(entry, 'classification');
      return classification !== undefined && classification !== 'NEW_PROSPECT' && classification !== 'AMBIGUOUS';
    }).length;
    const withCandidate = confident + ambiguous;

    const pending = await this.receipts.pendingReconciliation(tenantId);
    const oldest = pending
      .map((receipt) => Date.parse(receipt.createdAt))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b)[0];

    return {
      tenantId,
      window,
      generatedAt,
      duplicatesPrevented,
      duplicatesPreventedCount: duplicatesPrevented.length,
      ownerOverwritesBlocked,
      lifecycleStageProtections,
      ambiguousMatchesEscalated: ambiguous,
      suspectedDuplicatesRaised: suspected,
      fieldCompleteness: {
        recordsWritten: recordsCreated + recordsUpdated,
        recordsCreated,
        recordsUpdated,
      },
      reconciliationBacklog: {
        pending: pending.length,
        oldestAgeSeconds: oldest === undefined ? undefined : Math.max(0, Math.round((nowMs - oldest) / 1000)),
      },
      deduplicationPrecision: {
        confidentMatchesActedOn: confident,
        ambiguousDeclined: ambiguous,
        precisionPct: withCandidate === 0 ? undefined : Math.round((confident / withCandidate) * 1000) / 10,
        // Stated plainly rather than dressed up: this is the rate at which the
        // matcher was confident enough to act, measured on this tenant's own
        // data. It is not the same as the CI precision gate, which is measured
        // against a labelled dataset, and conflating them would be dishonest.
        note: 'Share of resolutions with a candidate where the matcher was confident enough to act. Measured on this tenant\'s live data.',
      },
      evidence: { chainVerified: verification.valid, auditEntriesExamined: entries.length },
    };
  }
}

function extractFields(serialised: string): string[] {
  const match = /CRM-authoritative fields:\s*([a-zA-Z_, ]+)/.exec(serialised);
  if (match?.[1]) return match[1].split(',').map((field) => field.trim()).filter(Boolean);
  const offending = /"offending":\s*\[([^\]]*)\]/.exec(serialised);
  if (offending?.[1]) return offending[1].split(',').map((field) => field.replace(/["\s]/g, '')).filter(Boolean);
  return [];
}
