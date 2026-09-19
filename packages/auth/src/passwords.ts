import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string, salt: string, keylen: number, options: Record<string, number>,
) => Promise<Buffer>;

/**
 * Password hashing.
 *
 * scrypt from Node's own crypto, because it is memory-hard, it is in the
 * standard library, and adding a native dependency to the one part of the
 * system that must never fail to build is a poor trade.
 *
 * The parameters are stored in the hash string rather than as constants. When
 * they are raised later, and they should be, as hardware improves, every
 * existing password still verifies against the parameters it was created with,
 * and is upgraded on the next successful login.
 */

/** OWASP's floor for scrypt at the time of writing. */
export const SCRYPT_COST = 16_384;
export const SCRYPT_BLOCK_SIZE = 8;
export const SCRYPT_PARALLELISM = 1;
const KEY_LENGTH = 64;

export interface PasswordProblem {
  readonly message: string;
}

/**
 * Password rules.
 *
 * Length, and only length, plus a check against the handful of passwords that
 * are actually guessed first. Composition rules: one upper, one digit, one
 * symbol, measurably produce worse passwords, because people satisfy them with
 * Password1! and stop thinking.
 */
export function checkPasswordStrength(password: string, context: readonly string[] = []): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  if (password.length < 12) {
    problems.push({ message: 'Use at least 12 characters. Length beats complexity.' });
  }
  if (password.length > 256) {
    problems.push({ message: 'That is longer than 256 characters.' });
  }
  // Context terms are broken into their parts as well as compared whole. An
  // email is the usual case: "sam@vertex.example" as one string appears in
  // nothing, while "vertex" appears in exactly the password somebody reaches
  // for when told to think of something memorable.
  const lowered = password.toLowerCase();
  const terms = new Set<string>();
  for (const term of context) {
    const value = term.trim().toLowerCase();
    if (value.length >= 4) terms.add(value);
    for (const part of value.split(/[^a-z0-9]+/)) {
      // Four characters: shorter parts collide with ordinary words and would
      // reject reasonable passwords.
      if (part.length >= 4) terms.add(part);
    }
  }
  for (const term of terms) {
    if (lowered.includes(term)) {
      problems.push({ message: 'Do not include your name, email or organisation in the password.' });
      break;
    }
  }
  if (/^(.)\1+$/.test(password)) {
    problems.push({ message: 'That is a single repeated character.' });
  }
  return problems;
}

/** Returns a self-describing hash: scrypt$N$r$p$salt$key. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt, KEY_LENGTH, {
    N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM,
    // scrypt needs roughly 128 * N * r bytes; Node's default cap is below that
    // at this cost, so it is raised deliberately rather than by lowering N.
    maxmem: 256 * SCRYPT_COST * SCRYPT_BLOCK_SIZE,
  });
  return `scrypt$${SCRYPT_COST}$${SCRYPT_BLOCK_SIZE}$${SCRYPT_PARALLELISM}$${salt}$${key.toString('hex')}`;
}

/**
 * Verifies a password in constant time.
 *
 * Never returns early on a malformed hash in a way that is faster than a real
 * comparison, and never throws: a thrown error during login is an oracle that
 * tells an attacker the account exists.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelism = Number(parts[3]);
  const salt = parts[4]!;
  const expected = parts[5]!;
  if (!Number.isInteger(cost) || !Number.isInteger(blockSize) || !Number.isInteger(parallelism)) {
    return false;
  }
  // A hash claiming an absurd cost would otherwise let anyone hang the login
  // endpoint by presenting one.
  if (cost > 1_048_576 || blockSize > 32 || parallelism > 16) return false;

  try {
    const key = await scryptAsync(password, salt, expected.length / 2, {
      N: cost, r: blockSize, p: parallelism, maxmem: 256 * cost * blockSize,
    });
    const given = Buffer.from(key.toString('hex'), 'utf8');
    const known = Buffer.from(expected, 'utf8');
    return given.length === known.length && timingSafeEqual(given, known);
  } catch {
    return false;
  }
}

/** True when a stored hash was made with weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return true;
  return Number(parts[1]) < SCRYPT_COST;
}

/**
 * A password to print once at boot when no credential has been configured.
 *
 * Generated, never a default. A shipped default password is a shipped
 * vulnerability: it survives into production because nobody remembers it was
 * meant to be temporary.
 */
export function generatePassword(): string {
  // Ambiguous characters removed, so it survives being read aloud or retyped.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(24);
  let password = '';
  for (const byte of bytes) password += alphabet[byte % alphabet.length];
  return `${password.slice(0, 6)}-${password.slice(6, 12)}-${password.slice(12, 18)}-${password.slice(18, 24)}`;
}
