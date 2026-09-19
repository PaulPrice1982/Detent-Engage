/**
 * Synthetic media marking (FR-068, EU AI Act Article 50(2)).
 *
 * Article 50(1) — telling a person they are interacting with an AI — is already
 * handled by the conversation disclosure. Article 50(2) is a separate duty: AI-
 * generated content must be marked in machine-readable form. This module exists
 * so that the marking cannot be forgotten when media is added, and so the
 * acceptance criterion "zero synthetic media without Article 50(2) marking"
 * has something to assert against.
 *
 * Section 44's compliance note is enforced here too: a synthetic likeness of a
 * named person crosses the impersonation boundary in section 13.3, so the
 * presenter kind is constrained rather than free text.
 */
export type MediaKind = 'video' | 'audio' | 'image';

export type PresenterKind =
  /** Plainly non-human: an illustrated or abstract presenter. */
  | 'NON_HUMAN'
  /** A real recorded person who consented to the recording. */
  | 'REAL_RECORDED_PERSON'
  /** A synthetic likeness. Refused: it crosses the impersonation boundary. */
  | 'SYNTHETIC_LIKENESS';

export interface SyntheticMediaMark {
  /** C2PA-style assertion label, machine-readable as Article 50(2) requires. */
  readonly assertion: 'c2pa.ai_generative_training' | 'c2pa.actions';
  readonly generatedBy: 'ai';
  readonly kind: MediaKind;
  readonly tenantId: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly presenter: Exclude<PresenterKind, 'SYNTHETIC_LIKENESS'>;
  /** Human-readable label rendered alongside the asset. */
  readonly visibleLabel: string;
}

export class ImpersonationBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImpersonationBoundaryError';
  }
}

export function markSyntheticMedia(input: {
  kind: MediaKind;
  tenantId: string;
  correlationId: string;
  presenter: PresenterKind;
  createdAt: string;
}): SyntheticMediaMark {
  if (input.presenter === 'SYNTHETIC_LIKENESS') {
    // Refused rather than marked. Marking does not cure impersonation, and a
    // synthetic likeness of a named employee is exactly what section 13.3
    // prohibits.
    throw new ImpersonationBoundaryError(
      'a synthetic likeness of a person may not be generated: use a plainly non-human presenter or a real recorded person',
    );
  }
  return {
    assertion: 'c2pa.actions',
    generatedBy: 'ai',
    kind: input.kind,
    tenantId: input.tenantId,
    correlationId: input.correlationId,
    createdAt: input.createdAt,
    presenter: input.presenter,
    visibleLabel: 'AI-generated',
  };
}

/** An asset without a mark must never be served. */
export function assertMarked(mark: SyntheticMediaMark | undefined, assetRef: string): asserts mark is SyntheticMediaMark {
  if (!mark) {
    throw new Error(`synthetic media ${assetRef} has no Article 50(2) marking and cannot be served`);
  }
}
