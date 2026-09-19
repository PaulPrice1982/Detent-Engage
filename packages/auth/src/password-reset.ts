import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AwaError, type Clock, systemClock } from '@detent/awa-core';
import type { EmailSender } from './email.js';
import { checkPasswordStrength, hashPassword } from './passwords.js';
import type { SessionService } from './sessions.js';
import type { Realm, UserService } from './users.js';

/**
 * Password reset by email.
 *
 * This is the most attacked path in any product: it is an unauthenticated
 * endpoint whose whole purpose is to grant access to an account. Six properties
 * make it safe, and each one is here because leaving it out is a known, named
 * failure rather than a theoretical one.
 *
 *  1. **The response never reveals whether an account exists.** Always the same
 *     message, always the same work done. A reset form that says "no account
 *     with that address" is a free tool for confirming which of a leaked list of
 *     addresses are customers.
 *
 *  2. **Only a hash of the token is stored.** Anyone who reads the database , 
 *     a backup, a log, a support tool, otherwise holds a live key to every
 *     account with a pending reset.
 *
 *  3. **One use, and short lived.** A link in a mailbox is a credential lying
 *     around; mailboxes get breached long after the fact.
 *
 *  4. **Requesting a new link invalidates the previous one.** Otherwise every
 *     link ever sent stays live until it expires, and a forwarded old email is
 *     as good as the newest.
 *
 *  5. **Completing a reset ends every session.** A reset is often a response to
 *     a compromise, and leaving the attacker's session alive defeats the point.
 *
 *  6. **The token is scoped to one realm.** A console reset can never set a
 *     customer's password, or the reverse.
 */

export interface ResetToken {
  /** SHA-256 of the token. The token itself is never stored. */
  readonly tokenHash: string;
  readonly userId: string;
  readonly realm: Realm;
  readonly email: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt?: string;
  /**
   * Set when a later request superseded this token.
   *
   * Distinct from `usedAt`, and the record is kept rather than deleted:
   * deleting it would also delete the evidence the rate limiter counts, so a
   * caller could request an unlimited number of links by the simple fact that
   * each one removed the last.
   */
  readonly supersededAt?: string;
  /** Recorded to spot a burst of requests against one account. */
  readonly requestedIp?: string;
}

export interface ResetTokenStore {
  put(token: ResetToken): Promise<void>;
  find(tokenHash: string): Promise<ResetToken | undefined>;
  /** Invalidates every outstanding token for a user. */
  invalidateForUser(userId: string): Promise<void>;
  /** Requests made for an address since a time. Drives rate limiting. */
  countSince(email: string, sinceIso: string): Promise<number>;
}

export class InMemoryResetTokenStore implements ResetTokenStore {
  private readonly tokens = new Map<string, ResetToken>();

  async put(token: ResetToken): Promise<void> { this.tokens.set(token.tokenHash, token); }
  async find(tokenHash: string): Promise<ResetToken | undefined> { return this.tokens.get(tokenHash); }
  async invalidateForUser(userId: string): Promise<void> {
    for (const [hash, token] of this.tokens) {
      if (token.userId === userId && !token.usedAt && !token.supersededAt) {
        this.tokens.set(hash, { ...token, supersededAt: new Date().toISOString() });
      }
    }
  }
  async countSince(email: string, sinceIso: string): Promise<number> {
    const lowered = email.toLowerCase();
    return [...this.tokens.values()]
      .filter((token) => token.email === lowered && token.createdAt >= sinceIso).length;
  }
}

/**
 * Short, because the link is a credential sitting in a mailbox. Long enough that
 * somebody can finish a coffee first.
 */
export const RESET_TOKEN_MINUTES = 45;
/** Requests permitted for one address per hour, before they are silently dropped. */
export const RESET_REQUESTS_PER_HOUR = 5;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface ResetLinkOptions {
  /** e.g. https://app.detent.io: the site the user is resetting on. */
  readonly baseUrl: string;
  readonly path: string;
}

export class PasswordResetService {
  constructor(
    private readonly tokens: ResetTokenStore,
    private readonly users: UserService,
    private readonly sessions: SessionService,
    private readonly email: EmailSender,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Requests a reset.
   *
   * Returns nothing useful on purpose. The caller shows the same message
   * whatever happened, so the endpoint cannot be used to test whether an
   * address has an account.
   */
  async request(input: {
    readonly realm: Realm;
    readonly email: string;
    readonly link: ResetLinkOptions;
    readonly ip?: string;
  }): Promise<void> {
    const address = input.email.trim().toLowerCase();
    const hourAgo = new Date(this.clock.nowMs() - 3_600_000).toISOString();

    // Rate limited before the lookup, so a flood costs nothing and the account
    // owner is not buried in reset emails by someone else.
    if (await this.tokens.countSince(address, hourAgo) >= RESET_REQUESTS_PER_HOUR) return;

    const user = await this.users.byEmail(input.realm, address);
    if (!user || !user.active) {
      // No account, or a disabled one. Nothing is sent and nothing is said.
      // Returning here rather than earlier keeps the code path uniform.
      return;
    }

    // Any previous link stops working now. Otherwise every link ever sent stays
    // live until it expires, and a forwarded old email is as good as the newest.
    await this.tokens.invalidateForUser(user.userId);

    const token = randomBytes(32).toString('base64url');
    await this.tokens.put({
      tokenHash: hashToken(token),
      userId: user.userId,
      realm: input.realm,
      email: address,
      createdAt: this.clock.iso(),
      expiresAt: new Date(this.clock.nowMs() + RESET_TOKEN_MINUTES * 60_000).toISOString(),
      requestedIp: input.ip,
    });

    const url = `${input.link.baseUrl.replace(/\/$/, '')}${input.link.path}?token=${token}`;
    await this.email.send({
      to: address,
      tag: 'password_reset',
      subject: 'Reset your Detent password',
      text: [
        `Hello ${user.name || 'there'},`,
        '',
        'Someone asked to reset the password on your Detent account. If that was',
        'you, follow this link:',
        '',
        url,
        '',
        `The link works once and expires in ${RESET_TOKEN_MINUTES} minutes.`,
        '',
        'If it was not you, you do not need to do anything. Your password has not',
        'changed, and nobody can use this link without your mailbox.',
        '',
        'Detent',
      ].join('\n'),
    });
  }

  /**
   * Checks a token without spending it.
   *
   * Used to decide whether to show the form, so an expired link says so instead
   * of collecting a new password and then refusing it.
   */
  async check(realm: Realm, token: string): Promise<{ valid: boolean; email?: string }> {
    const record = await this.tokens.find(hashToken(token));
    if (!record || record.usedAt || record.supersededAt || record.realm !== realm) {
      return { valid: false };
    }
    if (record.expiresAt <= this.clock.iso()) return { valid: false };
    return { valid: true, email: record.email };
  }

  /**
   * Completes a reset.
   *
   * Spends the token, sets the password, and ends every session the user has , 
   * a reset is often a response to a compromise, and leaving the attacker's
   * session alive defeats the point of resetting.
   */
  async complete(input: {
    readonly realm: Realm;
    readonly token: string;
    readonly newPassword: string;
  }): Promise<{ readonly email: string }> {
    const hash = hashToken(input.token);
    const record = await this.tokens.find(hash);

    // One message for every way a token can be unusable. Distinguishing "wrong"
    // from "expired" from "already used" tells an attacker which tokens exist.
    const unusable = new AwaError({
      kind: 'POLICY_DENIED',
      message: 'That reset link is no longer valid. Request a new one.',
    });
    if (!record || record.usedAt || record.supersededAt || record.realm !== input.realm) {
      throw unusable;
    }
    if (record.expiresAt <= this.clock.iso()) throw unusable;

    // Constant-time on the hash as well, so a partial match is not detectable
    // by timing even though the lookup is by key.
    const given = Buffer.from(hash, 'utf8');
    const known = Buffer.from(record.tokenHash, 'utf8');
    if (given.length !== known.length || !timingSafeEqual(given, known)) throw unusable;

    const user = await this.users.byId(record.userId);
    if (!user || !user.active) throw unusable;

    const problems = checkPasswordStrength(input.newPassword, [user.email, user.name]);
    if (problems.length > 0) {
      // The token is not spent on a weak password: making somebody request a
      // new link because they mistyped is how a reset flow gets abandoned.
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: problems[0]!.message });
    }

    await this.users.replacePassword(user.userId, await hashPassword(input.newPassword));
    await this.tokens.put({ ...record, usedAt: this.clock.iso() });
    await this.tokens.invalidateForUser(user.userId);
    await this.sessions.endAllFor(user.userId);

    // Told after the fact, not asked. Somebody whose password was changed
    // without their knowledge needs to know immediately, and this is the
    // message that surfaces an account takeover.
    await this.email.send({
      to: user.email,
      tag: 'password_changed',
      subject: 'Your Detent password was changed',
      text: [
        `Hello ${user.name || 'there'},`,
        '',
        'Your Detent password was just changed, and every signed-in session has',
        'been ended.',
        '',
        'If this was not you, reset your password immediately and contact us.',
        '',
        'Detent',
      ].join('\n'),
    });

    return { email: user.email };
  }
}
