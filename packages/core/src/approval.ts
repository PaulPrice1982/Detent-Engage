/**
 * Approval state and provenance for generated configuration (section 38.4).
 *
 * The governing invariant, NFR-021: **zero unapproved generated content
 * reachable by a visitor.** `approved` defaults to false on every claim and
 * every price, so a generated price the tenant has not read cannot be quoted,
 * and the section 13.4 price authority rule survives the new onboarding path
 * intact.
 *
 * Risk 14 in the extension is that instant onboarding erodes the governance
 * position by making approval feel like friction to remove. The structural
 * answer is here: there is no bulk-approve-everything primitive in this file.
 * `approveAll` exists for a *reviewed* set and records who reviewed it.
 */
export type ApprovalState = 'DRAFT' | 'PARTIALLY_APPROVED' | 'APPROVED' | 'REJECTED';

export interface Provenance {
  /** The page the claim was extracted from. Shown beside every item at review. */
  readonly sourceUrl: string;
  /** Extraction confidence, 0..1. Low-confidence items default to excluded. */
  readonly confidence: number;
  readonly extractedAt: string;
}

export interface Approvable<T> {
  readonly value: T;
  readonly provenance: Provenance;
  readonly approved: boolean;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  /** Set when an item was excluded rather than merely left unapproved. */
  readonly excludedReason?: string;
}

/**
 * Below this, a generated item is excluded by default rather than merely
 * unapproved. The distinction matters at review: an excluded item is not in the
 * list a hurried tenant clicks through, so a low-confidence extraction cannot be
 * approved by momentum.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.7;

export function draft<T>(value: T, provenance: Provenance): Approvable<T> {
  const belowThreshold = provenance.confidence < LOW_CONFIDENCE_THRESHOLD;
  return {
    value,
    provenance,
    approved: false,
    ...(belowThreshold
      ? { excludedReason: `confidence ${provenance.confidence.toFixed(2)} is below the ${LOW_CONFIDENCE_THRESHOLD} threshold` }
      : {}),
  };
}

export function approve<T>(item: Approvable<T>, approvedBy: string, at: string): Approvable<T> {
  return { ...item, approved: true, approvedBy, approvedAt: at, excludedReason: undefined };
}

export function reject<T>(item: Approvable<T>, reason: string): Approvable<T> {
  return { ...item, approved: false, excludedReason: reason };
}

/** Only approved items are servable. Everything else is invisible to a visitor. */
export function approvedValues<T>(items: readonly Approvable<T>[]): T[] {
  return items.filter((item) => item.approved).map((item) => item.value);
}

export function stateOf(items: readonly Approvable<unknown>[]): ApprovalState {
  if (items.length === 0) return 'DRAFT';
  const approved = items.filter((item) => item.approved).length;
  if (approved === 0) return 'DRAFT';
  if (approved === items.length) return 'APPROVED';
  return 'PARTIALLY_APPROVED';
}

/** Approval coverage, reported in the compliance scorecard per risk 14. */
export function approvalCoverage(items: readonly Approvable<unknown>[]): number {
  if (items.length === 0) return 1;
  return items.filter((item) => item.approved).length / items.length;
}
