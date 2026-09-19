/**
 * Consent is evidence, not a boolean. Section 20.1 and 25.2 both turn on being
 * able to produce, months later, the exact wording a person was shown and the
 * choice they made. A ConsentEvent is therefore immutable once written.
 */

export type ConsentPurpose =
  | 'IDENTITY_RESOLUTION'
  | 'MARKETING'
  | 'RECORDING'
  | 'TRANSCRIPTION';

export type LawfulBasis =
  | 'CONSENT'
  | 'LEGITIMATE_INTEREST'
  | 'CONTRACT'
  | 'LEGAL_OBLIGATION';

export type ConsentChoice = 'GRANTED' | 'REFUSED' | 'WITHDRAWN';

/** Jurisdiction of the data subject, resolved at session open, never guessed later. */
export type Jurisdiction = 'UK' | 'EU' | 'US' | 'CA' | 'AU' | 'NZ' | 'OTHER';

export interface ConsentEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly subjectRef: string;
  readonly purpose: ConsentPurpose;
  readonly lawfulBasis: LawfulBasis;
  /** The exact text shown to the subject. Stored verbatim, never a key. */
  readonly wordingShown: string;
  readonly choice: ConsentChoice;
  readonly timestamp: string;
  /** Where the signal came from: the host consent platform, or our own prompt. */
  readonly source: 'HOST_CMP' | 'WIDGET_PROMPT' | 'VOICE_PROMPT' | 'TENANT_IMPORT';
  readonly jurisdiction: Jurisdiction;
  readonly correlationId: string;
}

export function isGranted(event: ConsentEvent | undefined): boolean {
  return event?.choice === 'GRANTED';
}

/**
 * Stricter-of resolution (sections 20 and 25.3). In a multi-tenant product the
 * tenant and the visitor are routinely in different jurisdictions, so the
 * platform never applies the tenant's home rule to someone else's recipient.
 */
const STRICTNESS: Record<Jurisdiction, number> = {
  CA: 5, // CASL: express consent, no implied path
  EU: 4,
  UK: 3,
  AU: 3,
  NZ: 2,
  US: 2,
  OTHER: 4, // unknown is treated as strict, never as permissive
};

export function stricterOf(a: Jurisdiction, b: Jurisdiction): Jurisdiction {
  return STRICTNESS[a] >= STRICTNESS[b] ? a : b;
}

/**
 * Recording law by jurisdiction (section 20, table 30). Every US visitor is
 * treated as all-party because Kearney v. Salomon Smith Barney applied
 * California law to an out-of-state recorder.
 */
export const RECORDING_REQUIRES_EXPLICIT_CONSENT: Readonly<Record<Jurisdiction, boolean>> = {
  UK: true,
  EU: true,
  US: true,
  CA: true,
  AU: true,
  NZ: true,
  OTHER: true,
};

/**
 * Marketing enrolment defaults (section 25.3, table 36). Every jurisdiction
 * requires an explicit consent event; the platform deliberately does not rely
 * on the UK corporate-subscriber carve-out.
 */
export const MARKETING_REQUIRES_EXPLICIT_CONSENT: Readonly<Record<Jurisdiction, boolean>> = {
  UK: true,
  EU: true,
  US: true,
  CA: true,
  AU: true,
  NZ: true,
  OTHER: true,
};
