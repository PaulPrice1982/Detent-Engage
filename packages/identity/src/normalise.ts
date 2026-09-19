/**
 * Normalisation (section 17.1 step 2, section 21.2).
 *
 * Every matching decision downstream assumes normalised input. Getting this
 * wrong produces duplicates, and duplicates are the one CRM outcome the
 * business objectives set at zero tolerance.
 */

/** Providers where the local part is a person, not an organisation. */
export const PUBLIC_MAILBOX_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk',
  'live.com', 'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com',
  'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com', 'msn.com',
  'btinternet.com', 'sky.com', 'talktalk.net', 'virginmedia.com', 'zoho.com',
  'yandex.com', 'fastmail.com', 'tutanota.com', 'hey.com',
]);

/** Providers whose plus-addressing and dot-insensitivity we can rely on. */
const PLUS_ADDRESSING_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'icloud.com', 'me.com', 'proton.me', 'protonmail.com', 'fastmail.com',
]);

export interface NormalisedEmail {
  readonly raw: string;
  /** Lower-cased, whitespace-trimmed. Used for storage and display. */
  readonly normalised: string;
  /**
   * Plus-suffix and (for Gmail) dots removed. Used for matching only — never
   * written to a CRM, because it is not the address the person gave us.
   */
  readonly matchKey: string;
  readonly domain: string;
  readonly isPublicMailbox: boolean;
  readonly valid: boolean;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normaliseEmail(input: string): NormalisedEmail {
  const trimmed = input.trim();
  const normalised = trimmed.toLowerCase();
  const valid = EMAIL_SHAPE.test(normalised);
  const atIndex = normalised.lastIndexOf('@');
  const domain = atIndex >= 0 ? normalised.slice(atIndex + 1) : '';
  let local = atIndex >= 0 ? normalised.slice(0, atIndex) : normalised;

  if (PLUS_ADDRESSING_DOMAINS.has(domain)) {
    const plus = local.indexOf('+');
    if (plus > 0) local = local.slice(0, plus);
    if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
  } else {
    // Non-Gmail plus-addressing is common enough to strip for matching, but
    // dots are significant elsewhere and are left alone.
    const plus = local.indexOf('+');
    if (plus > 0) local = local.slice(0, plus);
  }

  return {
    raw: trimmed,
    normalised,
    matchKey: `${local}@${domain}`,
    domain,
    isPublicMailbox: PUBLIC_MAILBOX_DOMAINS.has(domain),
    valid,
  };
}

/**
 * Convert a phone number to E.164. `defaultCallingCode` is the tenant's, used
 * only for a national-format number: an international number is never
 * reinterpreted against the tenant's country.
 */
export function normalisePhone(input: string, defaultCallingCode = '44'): string | undefined {
  const trimmed = input.trim();
  if (trimmed.startsWith('+')) {
    const digits = trimmed.slice(1).replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : undefined;
  }

  let digits = trimmed.replace(/\D/g, '');
  if (digits.startsWith('00')) {
    digits = digits.slice(2);
    return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : undefined;
  }
  // UK national format: 07700 900123 -> +447700900123.
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length < 6 || digits.length > 14) return undefined;
  return `+${defaultCallingCode}${digits}`;
}

/** Extract a corporate domain, excluding public mailboxes (which are person-level). */
export function extractCorporateDomain(email: string): string | undefined {
  const normalised = normaliseEmail(email);
  if (!normalised.valid || normalised.isPublicMailbox) return undefined;
  return normalised.domain;
}

/** Normalise an organisation name for comparison: legal suffixes are noise. */
export function normaliseOrganisationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(limited|ltd|llp|plc|inc|incorporated|corp|corporation|company|co|gmbh|s\.?a\.?|b\.?v\.?|pty|holdings|group)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Jaro-Winkler similarity, 0..1. Used only as a weak signal, never alone. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;

  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}
