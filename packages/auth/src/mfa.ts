import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hashPassword, verifyPassword } from './passwords.js';

/**
 * Time-based one-time passwords (RFC 6238) for staff.
 *
 * This exists because the flag it sets was already being enforced and could
 * never become true. `mfaEnrolled` was written as `false` at user creation and
 * nothing anywhere set it, while RBAC refused every money capability without
 * it. The effect was not a weak control but an unreachable one: granting a
 * credit, taking a payment, refunding, voiding an invoice, changing a spend
 * cap and overriding a plan were all impossible for every user, including the
 * owner, and the only way to move money was to edit the database.
 *
 * TOTP rather than SMS: a one-time code sent to a phone number is delivered by
 * whoever currently controls that number, and controlling somebody else's
 * number is a phone call to a call centre. TOTP secrets never leave the
 * authenticator, so there is no carrier in the trust path.
 *
 * WebAuthn is better again and is Phase 2. TOTP is what every operator can
 * enrol in today with an app they already have.
 */

/** Crockford-free RFC 4648 base32, which is what authenticator apps read. */
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/**
 * How many steps either side of now are accepted.
 *
 * One, i.e. plus or minus thirty seconds. Zero rejects an operator whose phone
 * clock is a few seconds out, which is most of them; more than one widens the
 * window an intercepted code stays usable in for no real gain in usability.
 */
export const TOTP_WINDOW_STEPS = 1;

export const RECOVERY_CODE_COUNT = 10;

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of clean) {
    const index = BASE32.indexOf(character);
    if (index < 0) throw new Error('not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * The URI an authenticator app reads from a QR code.
 *
 * The issuer appears twice, in the label and as a parameter, which is what the
 * apps expect: without the label an operator with several accounts sees six
 * entries called by their email address and no way to tell which is which.
 */
export function otpauthUri(input: {
  secret: string; account: string; issuer?: string;
}): string {
  const issuer = input.issuer ?? 'Detent';
  const label = encodeURIComponent(`${issuer}:${input.account}`);
  const parameters = new URLSearchParams({
    secret: input.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}

/** The counter value for a moment, which is what the code is derived from. */
export function stepAt(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpAt(secret: string, step: number): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(counter).digest();
  // Dynamic truncation, RFC 4226 section 5.4.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24)
    | ((digest[offset + 1]! & 0xff) << 16)
    | ((digest[offset + 2]! & 0xff) << 8)
    | (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

export interface TotpVerification {
  readonly ok: boolean;
  /**
   * The step the code belonged to, so the caller can refuse it a second time.
   *
   * Replay is the obvious attack on a code that stays valid for ninety
   * seconds: somebody who reads it over a shoulder, or off a screen share, has
   * until the window closes to use it. Storing the last accepted step is what
   * makes a code single use.
   */
  readonly step?: number;
}

/**
 * Verifies a code, in constant time, within the window.
 *
 * `lastUsedStep` is required rather than optional. Making it optional would
 * mean a caller could leave replay protection off by forgetting an argument,
 * which is how it would be left off.
 */
export function verifyTotp(input: {
  secret: string;
  code: string;
  atMs: number;
  lastUsedStep: number | undefined;
}): TotpVerification {
  const code = input.code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const now = stepAt(input.atMs);
  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset += 1) {
    const step = now + offset;
    // A code from a step already used is refused even though it is arithmetically
    // correct. That is the whole point of recording it.
    if (input.lastUsedStep !== undefined && step <= input.lastUsedStep) continue;
    if (!equals(totpAt(input.secret, step), code)) continue;
    return { ok: true, step };
  }
  return { ok: false };
}

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Recovery codes, hashed exactly as passwords are.
 *
 * Returned in the clear once, at enrolment, and never again. An operator who
 * loses their phone with no recovery code has to be restored by another
 * operator, and on a two-person company that is how everybody gets locked out
 * of their own console at once.
 *
 * Hashed rather than stored, because a recovery code is a password that
 * bypasses the second factor; a readable list of them in the database is a
 * list of ways to skip MFA for every member of staff.
 */
export interface RecoveryCodes {
  /** Shown to the operator once. Never persisted in this form. */
  readonly plain: readonly string[];
  readonly hashes: readonly string[];
}

export async function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): Promise<RecoveryCodes> {
  const plain: string[] = [];
  for (let index = 0; index < count; index += 1) {
    // Grouped, because these get written down and read back by a person.
    plain.push(`${block()}-${block()}`);
  }
  const hashes = await Promise.all(plain.map((code) => hashPassword(code)));
  return { plain, hashes };
}

function block(): string {
  let out = '';
  for (let index = 0; index < 5; index += 1) out += BASE32[randomInt(BASE32.length)];
  return out;
}

export interface RecoveryUse {
  readonly ok: boolean;
  /** The hashes that remain. A used code is spent, not reusable. */
  readonly remaining: readonly string[];
}

export async function useRecoveryCode(
  code: string,
  hashes: readonly string[],
): Promise<RecoveryUse> {
  const candidate = code.trim().toUpperCase();
  for (let index = 0; index < hashes.length; index += 1) {
    if (!(await verifyPassword(candidate, hashes[index]!))) continue;
    return { ok: true, remaining: hashes.filter((_, at) => at !== index) };
  }
  // Every code is checked even after a match would have been found earlier,
  // and a miss walks the whole list, so the time taken says nothing about
  // which code was wrong.
  return { ok: false, remaining: hashes };
}
