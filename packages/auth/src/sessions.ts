import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@detent/awa-core';
import { systemClock } from '@detent/awa-core';
import type { Realm } from './users.js';

/**
 * Browser sessions for both sites.
 *
 * Server-side sessions with an opaque identifier in a cookie, not a JWT. A JWT
 * cannot be revoked before it expires, and the one thing an operator must be
 * able to do when a laptop goes missing is end that person's session now.
 *
 * The cookie carries a signed identifier so a forged one is rejected without a
 * store lookup, and the store is the authority on whether the session is still
 * live.
 */

export interface Session {
  readonly sessionId: string;
  readonly userId: string;
  /** Part of the session, so a console cookie cannot be replayed at the app. */
  readonly realm: Realm;
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Rolled forward on use; a session dies of inactivity as well as of age. */
  readonly lastSeenAt: string;
  readonly userAgent?: string;
  readonly ip?: string;
}

export interface SessionStore {
  get(sessionId: string): Promise<Session | undefined>;
  put(session: Session): Promise<void>;
  delete(sessionId: string): Promise<void>;
  deleteForUser(userId: string): Promise<void>;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  async get(sessionId: string): Promise<Session | undefined> { return this.sessions.get(sessionId); }
  async put(session: Session): Promise<void> { this.sessions.set(session.sessionId, session); }
  async delete(sessionId: string): Promise<void> { this.sessions.delete(sessionId); }
  async deleteForUser(userId: string): Promise<void> {
    for (const [id, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(id);
    }
  }
}

/**
 * Console sessions are short because of what they can do; app sessions are
 * longer because a customer being logged out mid-task is a support ticket.
 */
export const SESSION_LIFETIME_MINUTES: Readonly<Record<Realm, number>> = {
  console: 8 * 60,
  app: 14 * 24 * 60,
  // A reseller sees commercial data about customers who are not them, so their
  // session sits between the two rather than with the customer's.
  reseller: 24 * 60,
};
export const IDLE_TIMEOUT_MINUTES: Readonly<Record<Realm, number>> = {
  console: 60,
  app: 7 * 24 * 60,
  reseller: 8 * 60,
};

const BASE_COOKIE_NAMES: Readonly<Record<Realm, string>> = {
  // Distinct names, so both sites can be served from one host in development
  // without one clobbering the other.
  console: 'detent_console',
  app: 'detent_app',
  reseller: 'detent_reseller',
};

/**
 * The cookie name, which depends on whether the connection is secure.
 *
 * The `__Host-` prefix binds a cookie to the exact origin and forbids a Domain
 * attribute, which is what stops a sibling subdomain from setting it. It is
 * only honoured on a cookie that is also `Secure`, and a browser silently
 * *discards* a `__Host-` cookie without it, so over plain HTTP the prefix does
 * not weaken security, it breaks sign-in entirely, with no error anywhere.
 * Development and preview servers are plain HTTP, so the prefix is applied only
 * where it can work.
 */
export function cookieNameFor(realm: Realm, secure = true): string {
  return secure ? `__Host-${BASE_COOKIE_NAMES[realm]}` : BASE_COOKIE_NAMES[realm];
}

/** Secure names, for callers that only ever run behind TLS. */
export const COOKIE_NAMES: Readonly<Record<Realm, string>> = {
  console: cookieNameFor('console', true),
  app: cookieNameFor('app', true),
  reseller: cookieNameFor('reseller', true),
};

export class SessionService {
  constructor(
    private readonly store: SessionStore,
    private readonly secret: string,
    private readonly clock: Clock = systemClock,
  ) {
    if (secret.length < 32) {
      throw new Error('The session secret must be at least 32 characters.');
    }
  }

  private sign(sessionId: string): string {
    return createHmac('sha256', this.secret).update(sessionId).digest('base64url');
  }

  /** `id.signature`. The signature is checked before the store is touched. */
  private token(sessionId: string): string {
    return `${sessionId}.${this.sign(sessionId)}`;
  }

  private parse(token: string): string | undefined {
    const dot = token.lastIndexOf('.');
    if (dot <= 0) return undefined;
    const sessionId = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1), 'utf8');
    const expected = Buffer.from(this.sign(sessionId), 'utf8');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    return sessionId;
  }

  async start(input: {
    readonly userId: string;
    readonly realm: Realm;
    readonly userAgent?: string;
    readonly ip?: string;
  }): Promise<{ readonly session: Session; readonly token: string }> {
    const now = this.clock.nowMs();
    const session: Session = {
      sessionId: randomBytes(24).toString('base64url'),
      userId: input.userId,
      realm: input.realm,
      createdAt: this.clock.iso(),
      lastSeenAt: this.clock.iso(),
      expiresAt: new Date(now + SESSION_LIFETIME_MINUTES[input.realm] * 60_000).toISOString(),
      userAgent: input.userAgent,
      ip: input.ip,
    };
    await this.store.put(session);
    return { session, token: this.token(session.sessionId) };
  }

  /**
   * Resolves a cookie to a live session.
   *
   * The realm is checked here, not by the caller. A console cookie presented to
   * the customer app resolves to nothing, which is the property that keeps the
   * back office invisible to end users even when one process serves both.
   */
  async resolve(realm: Realm, token: string | undefined): Promise<Session | undefined> {
    if (!token) return undefined;
    const sessionId = this.parse(token);
    if (!sessionId) return undefined;
    const session = await this.store.get(sessionId);
    if (!session) return undefined;
    if (session.realm !== realm) return undefined;

    const now = this.clock.iso();
    if (session.expiresAt <= now) {
      await this.store.delete(sessionId);
      return undefined;
    }
    const idleLimit = IDLE_TIMEOUT_MINUTES[realm] * 60_000;
    if (this.clock.nowMs() - Date.parse(session.lastSeenAt) > idleLimit) {
      await this.store.delete(sessionId);
      return undefined;
    }

    const refreshed: Session = { ...session, lastSeenAt: now };
    await this.store.put(refreshed);
    return refreshed;
  }

  async end(token: string | undefined): Promise<void> {
    if (!token) return;
    const sessionId = this.parse(token);
    if (sessionId) await this.store.delete(sessionId);
  }

  /** Ends every session for a user. Used when an account is disabled. */
  async endAllFor(userId: string): Promise<void> {
    await this.store.deleteForUser(userId);
  }

  /**
   * The Set-Cookie value.
   *
   * SameSite=Lax rather than Strict: Strict drops the cookie when a user
   * arrives from an email link and they see a login screen having just logged
   * in, which trains people to distrust the product. Lax still blocks the
   * cross-site POST that CSRF depends on.
   */
  cookie(realm: Realm, token: string, options: { readonly secure?: boolean } = {}): string {
    const maxAge = SESSION_LIFETIME_MINUTES[realm] * 60;
    const secure = options.secure !== false;
    return [
      `${cookieNameFor(realm, secure)}=${token}`,
      'Path=/',
      'HttpOnly',
      secure ? 'Secure' : '',
      'SameSite=Lax',
      `Max-Age=${maxAge}`,
    ].filter(Boolean).join('; ');
  }

  clearCookie(realm: Realm, options: { readonly secure?: boolean } = {}): string {
    const secure = options.secure !== false;
    return [
      `${cookieNameFor(realm, secure)}=`,
      'Path=/', 'HttpOnly', secure ? 'Secure' : '', 'SameSite=Lax', 'Max-Age=0',
    ].filter(Boolean).join('; ');
  }
}

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

/**
 * A CSRF token bound to the session.
 *
 * SameSite=Lax already blocks the cross-site POST, but it is one attribute
 * enforced by the browser, and a form that moves money should not rest on a
 * single control that an old browser or a redirect chain might not honour.
 */
export function csrfTokenFor(sessionId: string, secret: string): string {
  return createHmac('sha256', `${secret}:csrf`).update(sessionId).digest('base64url');
}

export function csrfValid(sessionId: string, secret: string, given: string | undefined): boolean {
  if (!given) return false;
  const expected = Buffer.from(csrfTokenFor(sessionId, secret), 'utf8');
  const actual = Buffer.from(given, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
