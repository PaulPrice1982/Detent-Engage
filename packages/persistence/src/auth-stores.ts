import type {
  AuthUser, Realm, ResetToken, ResetTokenStore, Session, SessionStore, UserStore,
} from '@detent/awa-auth';
import type { Database } from './database.js';

/**
 * Durable identity.
 *
 * These three are the stores whose loss is least tolerable and least obvious.
 * Losing accounts is visible immediately; losing *sessions* logs everybody out
 * at once, and losing reset tokens silently breaks the recovery path people
 * only use when they are already locked out.
 *
 * Each row keeps the whole record as jsonb and lifts out only what is looked
 * up. The application owns and validates these types; a column per field would
 * mean a migration every time one gains an option.
 */

export class PostgresUserStore implements UserStore {
  constructor(private readonly database: Database) {}

  async findByEmail(realm: Realm, email: string): Promise<AuthUser | undefined> {
    const rows = await this.database.query<{ document: AuthUser }>(
      'SELECT document FROM auth_user WHERE realm = $1 AND email = $2',
      [realm, email.trim().toLowerCase()],
    );
    return rows[0]?.document;
  }

  async findById(userId: string): Promise<AuthUser | undefined> {
    const rows = await this.database.query<{ document: AuthUser }>(
      'SELECT document FROM auth_user WHERE user_id = $1', [userId],
    );
    return rows[0]?.document;
  }

  async put(user: AuthUser): Promise<void> {
    // Upsert on the identifier rather than on (realm, email): changing an
    // address must move the row, not create a second one for the same person.
    await this.database.query(
      `INSERT INTO auth_user
         (user_id, realm, email, tenant_id, account_id, reseller_id, document)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         realm = EXCLUDED.realm, email = EXCLUDED.email,
         tenant_id = EXCLUDED.tenant_id, account_id = EXCLUDED.account_id,
         reseller_id = EXCLUDED.reseller_id, document = EXCLUDED.document,
         updated_at = now()`,
      [
        user.userId, user.realm, user.email.trim().toLowerCase(),
        user.tenantId ?? null, user.accountId ?? null, user.resellerId ?? null,
        JSON.stringify(user),
      ],
    );
  }

  async listByTenant(tenantId: string): Promise<readonly AuthUser[]> {
    const rows = await this.database.query<{ document: AuthUser }>(
      'SELECT document FROM auth_user WHERE tenant_id = $1 ORDER BY created_at', [tenantId],
    );
    return rows.map((row) => row.document);
  }

  async listByRealm(realm: Realm): Promise<readonly AuthUser[]> {
    const rows = await this.database.query<{ document: AuthUser }>(
      'SELECT document FROM auth_user WHERE realm = $1 ORDER BY created_at', [realm],
    );
    return rows.map((row) => row.document);
  }
}

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly database: Database) {}

  async get(sessionId: string): Promise<Session | undefined> {
    const rows = await this.database.query<{ document: Session }>(
      'SELECT document FROM auth_session WHERE session_id = $1', [sessionId],
    );
    return rows[0]?.document;
  }

  async put(session: Session): Promise<void> {
    await this.database.query(
      `INSERT INTO auth_session (session_id, user_id, realm, expires_at, document)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (session_id) DO UPDATE SET
         expires_at = EXCLUDED.expires_at, document = EXCLUDED.document`,
      [
        session.sessionId, session.userId, session.realm,
        session.expiresAt, JSON.stringify(session),
      ],
    );
  }

  async delete(sessionId: string): Promise<void> {
    await this.database.query('DELETE FROM auth_session WHERE session_id = $1', [sessionId]);
  }

  async deleteForUser(userId: string): Promise<void> {
    await this.database.query('DELETE FROM auth_session WHERE user_id = $1', [userId]);
  }

  /**
   * Removes sessions that have already expired.
   *
   * Expiry is enforced when a session is read, so this is housekeeping rather
   * than security, but a table nobody ever deletes from grows until it is a
   * problem at the worst moment.
   */
  async sweepExpired(nowIso: string): Promise<number> {
    const rows = await this.database.query<{ count: string }>(
      'WITH removed AS (DELETE FROM auth_session WHERE expires_at < $1 RETURNING 1) '
      + 'SELECT count(*)::text AS count FROM removed',
      [nowIso],
    );
    return Number(rows[0]?.count ?? 0);
  }
}

export class PostgresResetTokenStore implements ResetTokenStore {
  constructor(private readonly database: Database) {}

  async put(token: ResetToken): Promise<void> {
    await this.database.query(
      `INSERT INTO password_reset_token (token_hash, user_id, email, requested_at, document)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (token_hash) DO UPDATE SET document = EXCLUDED.document`,
      [
        token.tokenHash, token.userId, token.email.trim().toLowerCase(),
        token.createdAt, JSON.stringify(token),
      ],
    );
  }

  async find(tokenHash: string): Promise<ResetToken | undefined> {
    const rows = await this.database.query<{ document: ResetToken }>(
      'SELECT document FROM password_reset_token WHERE token_hash = $1', [tokenHash],
    );
    return rows[0]?.document;
  }

  async invalidateForUser(userId: string): Promise<void> {
    // Marked superseded rather than deleted. The rate limiter counts requests,
    // and deleting the row it counts would let somebody reset the limit by
    // triggering the invalidation it is meant to restrain.
    await this.database.query(
      `UPDATE password_reset_token
          SET document = jsonb_set(document, '{supersededAt}', to_jsonb(now()::text), true)
        WHERE user_id = $1
          AND document->>'usedAt' IS NULL
          AND document->>'supersededAt' IS NULL`,
      [userId],
    );
  }

  async countSince(email: string, sinceIso: string): Promise<number> {
    const rows = await this.database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM password_reset_token '
      + 'WHERE email = $1 AND requested_at >= $2',
      [email.trim().toLowerCase(), sinceIso],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
