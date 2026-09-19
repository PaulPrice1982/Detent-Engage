import { randomBytes } from 'node:crypto';
import { AwaError, type Clock, systemClock } from '@detent/awa-core';
import { checkPasswordStrength, hashPassword, needsRehash, verifyPassword } from './passwords.js';

/**
 * Identity for both sites.
 *
 * There are two entirely separate populations:
 *
 *  - **console**, Detent staff, who can see every customer's money.
 *  - **app**, customer users, who can see only their own tenant.
 *
 * They share this code and nothing else. A realm is part of the identity, part
 * of the session and part of every lookup, so a customer account can never
 * authenticate into the back office even if the two sites are served from the
 * same process, which they are in development. The realm check is not a
 * convenience: it is the boundary that stops the back office being visible to
 * end users.
 */

export type Realm = 'console' | 'app' | 'reseller';

export interface AuthUser {
  readonly userId: string;
  readonly realm: Realm;
  /** Stored lowercased; compared lowercased. */
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  /** Console roles, or customer-app roles. Interpreted by the site. */
  readonly roles: readonly string[];
  /** App users only. A console user belongs to no tenant, by design. */
  readonly tenantId?: string;
  readonly accountId?: string;
  /**
   * The reseller this user acts for, on a reseller-realm user.
   *
   * Their whole view is scoped by this. A reseller portal that decided what to
   * show from a query parameter would be one guessed id away from showing a
   * competitor's book.
   */
  readonly resellerId?: string;
  readonly active: boolean;
  readonly mfaEnrolled: boolean;
  readonly createdAt: string;
  readonly lastLoginAt?: string;
  /** Consecutive failures since the last success. Drives lockout. */
  readonly failedAttempts: number;
  readonly lockedUntil?: string;
  /** Set when an operator provisions the account and it is not yet claimed. */
  readonly mustChangePassword?: boolean;
}

export interface UserStore {
  findByEmail(realm: Realm, email: string): Promise<AuthUser | undefined>;
  findById(userId: string): Promise<AuthUser | undefined>;
  put(user: AuthUser): Promise<void>;
  listByTenant(tenantId: string): Promise<readonly AuthUser[]>;
  listByRealm(realm: Realm): Promise<readonly AuthUser[]>;
}

export class InMemoryUserStore implements UserStore {
  private readonly users = new Map<string, AuthUser>();
  private key(realm: Realm, email: string): string { return `${realm}:${email.toLowerCase()}`; }

  async findByEmail(realm: Realm, email: string): Promise<AuthUser | undefined> {
    return [...this.users.values()]
      .find((user) => this.key(user.realm, user.email) === this.key(realm, email));
  }
  async findById(userId: string): Promise<AuthUser | undefined> {
    return this.users.get(userId);
  }
  async put(user: AuthUser): Promise<void> {
    this.users.set(user.userId, user);
  }
  async listByTenant(tenantId: string): Promise<readonly AuthUser[]> {
    return [...this.users.values()].filter((user) => user.tenantId === tenantId);
  }
  async listByRealm(realm: Realm): Promise<readonly AuthUser[]> {
    return [...this.users.values()].filter((user) => user.realm === realm);
  }
}

export const MAX_FAILED_ATTEMPTS = 8;
export const LOCKOUT_MINUTES = 15;

export type LoginOutcome =
  | { readonly ok: true; readonly user: AuthUser }
  | { readonly ok: false; readonly reason: 'invalid' | 'locked' | 'disabled' };

export interface CreateUserInput {
  readonly realm: Realm;
  readonly email: string;
  readonly name: string;
  readonly password: string;
  readonly roles: readonly string[];
  readonly tenantId?: string;
  readonly accountId?: string;
  /** Set on a reseller-realm user, binding them to the book they may see. */
  readonly resellerId?: string;
  readonly mustChangePassword?: boolean;
}

export class UserService {
  constructor(
    private readonly store: UserStore,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: CreateUserInput): Promise<AuthUser> {
    const email = input.email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'That is not a valid email address.' });
    }
    if (await this.store.findByEmail(input.realm, email)) {
      throw new AwaError({ kind: 'CONFLICT', message: 'An account with that email already exists.' });
    }
    const problems = checkPasswordStrength(input.password, [email, input.name, input.tenantId ?? '']);
    if (problems.length > 0) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: problems[0]!.message });
    }
    // A console user without a tenant is the point: staff belong to Detent, not
    // to a customer, and giving them one would make cross-tenant access look
    // like ordinary access.
    if (input.realm === 'console' && input.tenantId) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'A console user must not belong to a tenant.' });
    }
    if (input.realm === 'app' && !input.tenantId) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'An app user must belong to a tenant.' });
    }

    const user: AuthUser = {
      userId: `usr_${randomBytes(9).toString('base64url')}`,
      realm: input.realm,
      email,
      name: input.name.trim(),
      passwordHash: await hashPassword(input.password),
      roles: input.roles,
      tenantId: input.tenantId,
      accountId: input.accountId,
      resellerId: input.resellerId,
      active: true,
      // Staff who can see every customer's money enrol in MFA. Customer users
      // are encouraged, not compelled: forcing it at signup loses the signup.
      mfaEnrolled: false,
      createdAt: this.clock.iso(),
      failedAttempts: 0,
      mustChangePassword: input.mustChangePassword,
    };
    await this.store.put(user);
    return user;
  }

  /**
   * Authenticates within one realm.
   *
   * Always does the password work, even for an unknown email, so the response
   * time does not reveal which addresses exist. Returns a reason for the caller
   * to log, and a single message for the screen.
   */
  async login(realm: Realm, email: string, password: string): Promise<LoginOutcome> {
    const user = await this.store.findByEmail(realm, email.trim().toLowerCase());
    if (!user) {
      // A hash comparison against a throwaway value, so an unknown address
      // takes the same time as a known one.
      await verifyPassword(password, DUMMY_HASH);
      return { ok: false, reason: 'invalid' };
    }
    if (!user.active) return { ok: false, reason: 'disabled' };
    if (user.lockedUntil && user.lockedUntil > this.clock.iso()) {
      return { ok: false, reason: 'locked' };
    }

    const correct = await verifyPassword(password, user.passwordHash);
    if (!correct) {
      const failedAttempts = user.failedAttempts + 1;
      await this.store.put({
        ...user,
        failedAttempts,
        lockedUntil: failedAttempts >= MAX_FAILED_ATTEMPTS
          ? new Date(this.clock.nowMs() + LOCKOUT_MINUTES * 60_000).toISOString()
          : user.lockedUntil,
      });
      return { ok: false, reason: 'invalid' };
    }

    // Parameters are raised over time; a correct password is the only moment we
    // hold the plaintext and can upgrade the stored hash.
    const passwordHash = needsRehash(user.passwordHash)
      ? await hashPassword(password)
      : user.passwordHash;

    const updated: AuthUser = {
      ...user, passwordHash, failedAttempts: 0,
      lockedUntil: undefined, lastLoginAt: this.clock.iso(),
    };
    await this.store.put(updated);
    return { ok: true, user: updated };
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.store.findById(userId);
    if (!user) throw new AwaError({ kind: 'NOT_FOUND', message: 'No such user.' });
    if (!(await verifyPassword(current, user.passwordHash))) {
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'The current password is wrong.' });
    }
    const problems = checkPasswordStrength(next, [user.email, user.name]);
    if (problems.length > 0) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: problems[0]!.message });
    }
    await this.store.put({
      ...user,
      passwordHash: await hashPassword(next),
      mustChangePassword: false,
    });
  }

  async setActive(userId: string, active: boolean): Promise<void> {
    const user = await this.store.findById(userId);
    if (!user) throw new AwaError({ kind: 'NOT_FOUND', message: 'No such user.' });
    await this.store.put({ ...user, active });
  }

  async byId(userId: string): Promise<AuthUser | undefined> {
    return this.store.findById(userId);
  }

  async byEmail(realm: Realm, email: string): Promise<AuthUser | undefined> {
    return this.store.findByEmail(realm, email.trim().toLowerCase());
  }

  /**
   * Sets a password hash directly, for a reset.
   *
   * Takes a hash rather than a password so this cannot become a way to set a
   * password without the strength check: the caller does that, and holds the
   * plaintext only long enough to hash it. Also clears any lockout: somebody
   * who has just proved control of the mailbox should not be kept out by
   * failed attempts that are the reason they are resetting.
   */
  async replacePassword(userId: string, passwordHash: string): Promise<void> {
    const user = await this.store.findById(userId);
    if (!user) throw new AwaError({ kind: 'NOT_FOUND', message: 'No such user.' });
    await this.store.put({
      ...user,
      passwordHash,
      failedAttempts: 0,
      lockedUntil: undefined,
      mustChangePassword: false,
    });
  }

  async listByRealm(realm: Realm): Promise<readonly AuthUser[]> {
    return this.store.listByRealm(realm);
  }

  async listByTenant(tenantId: string): Promise<readonly AuthUser[]> {
    return this.store.listByTenant(tenantId);
  }
}

/** A real hash of a value nobody knows, used to equalise timing. */
const DUMMY_HASH =
  'scrypt$16384$8$1$0000000000000000000000000000000000000000000000000000000000000000$'
  + '0'.repeat(128);
