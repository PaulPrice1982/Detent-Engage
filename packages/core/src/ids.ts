import { randomBytes } from 'node:crypto';

/**
 * Lexicographically sortable, prefixed identifiers.
 *
 * Sortability matters operationally: correlation ids and audit entries are
 * routinely read in time order by an on-call engineer with no index available.
 * The encoding is Crockford base32 over a 48-bit millisecond timestamp plus 80
 * bits of randomness, i.e. a ULID with a human-readable type prefix.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const ID_PREFIXES = {
  tenant: 't',
  session: 'sess',
  conversation: 'conv',
  correlation: 'corr',
  consentEvent: 'ce',
  changeEvent: 'evt',
  writeReceipt: 'wr',
  auditEntry: 'aud',
  person: 'pers',
  organisation: 'org',
  knowledgeChunk: 'kc',
  knowledgeCorpus: 'corp',
  booking: 'bk',
  handoff: 'ho',
  task: 'task',
  apiKey: 'ak',
  /** One inbound HTTP request, so a log line and a response share an id. */
  request: 'req',
  reseller: 'rsl',
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

function encodeTime(ms: number, length: number): string {
  let out = '';
  let value = ms;
  for (let i = length - 1; i >= 0; i--) {
    out = ALPHABET[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % 32]!;
  return out;
}

/** Generate a prefixed ULID, e.g. `corr_01J8Q3...`. */
export function newId(prefix: IdPrefix, nowMs: number = Date.now()): string {
  return `${prefix}_${encodeTime(nowMs, 10)}${encodeRandom(16)}`;
}

const ID_PATTERN = /^[a-z]{1,8}_[0-9A-HJKMNP-TV-Z]{26}$/;

export function isId(value: unknown, prefix?: IdPrefix): value is string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) return false;
  if (prefix && !value.startsWith(`${prefix}_`)) return false;
  return true;
}

/**
 * Deterministic idempotency key. Section 16.5 requires every consequential
 * write to carry a key derived from the session and the operation, so that a
 * retry of the same logical write can never create a second record.
 */
export function idempotencyKey(sessionId: string, operation: string, sequence: number): string {
  return `${sessionId}:${operation}:${sequence}`;
}
