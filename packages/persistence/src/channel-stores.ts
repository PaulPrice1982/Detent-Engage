import type {
  AccountLink, Reseller, ResellerStore, Territory, TerritoryStore,
} from '@detent/awa-reseller';
import type { SupportRequest, SupportRequestStore } from '@detent/awa-support';
import type { Database } from './database.js';

/**
 * The channel, durable.
 *
 * Two guarantees here are the database's rather than the application's, because
 * both are about money owed to somebody outside the company:
 *
 * A customer has at most one open link. Two would mean two resellers earning on
 * the same revenue, and the partial index enforcing it means no code path can
 * create that state, including one written next year by somebody who has not
 * read this comment.
 *
 * A postcode area has exactly one holder, because it is the primary key.
 * Exclusivity is the reason a reseller invests; it should not depend on the
 * application remembering to check.
 */

export class PostgresResellerStore implements ResellerStore {
  constructor(private readonly database: Database) {}

  async get(resellerId: string): Promise<Reseller | undefined> {
    const rows = await this.database.query<{ document: Reseller }>(
      'SELECT document FROM reseller WHERE reseller_id = $1', [resellerId],
    );
    return rows[0]?.document;
  }

  async byContactEmail(email: string): Promise<Reseller | undefined> {
    const rows = await this.database.query<{ document: Reseller }>(
      'SELECT document FROM reseller WHERE contact_email = $1', [email.trim().toLowerCase()],
    );
    return rows[0]?.document;
  }

  async put(reseller: Reseller): Promise<void> {
    await this.database.query(
      `INSERT INTO reseller (reseller_id, name, contact_email, status, document)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (reseller_id) DO UPDATE SET
         name = EXCLUDED.name, contact_email = EXCLUDED.contact_email,
         status = EXCLUDED.status, document = EXCLUDED.document, updated_at = now()`,
      [
        reseller.resellerId, reseller.name, reseller.contactEmail.trim().toLowerCase(),
        reseller.status, JSON.stringify(reseller),
      ],
    );
  }

  async list(): Promise<readonly Reseller[]> {
    const rows = await this.database.query<{ document: Reseller }>(
      'SELECT document FROM reseller ORDER BY name',
    );
    return rows.map((row) => row.document);
  }

  async linksForAccount(accountId: string): Promise<readonly AccountLink[]> {
    return this.readLinks(
      'SELECT * FROM reseller_account_link WHERE account_id = $1 ORDER BY since, link_id',
      [accountId],
    );
  }

  async linksForReseller(resellerId: string): Promise<readonly AccountLink[]> {
    return this.readLinks(
      'SELECT * FROM reseller_account_link WHERE reseller_id = $1 ORDER BY since, link_id',
      [resellerId],
    );
  }

  /**
   * Replaces one account's links in a single transaction.
   *
   * Delete-then-insert rather than a diff, because the caller has already
   * computed the whole history and the two statements must not be separable: a
   * failure between them would leave a customer with no reseller at all, which
   * silently stops commission accruing.
   */
  async replaceLinksForAccount(
    accountId: string,
    links: readonly AccountLink[],
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query('DELETE FROM reseller_account_link WHERE account_id = $1', [accountId]);
      for (const link of links) {
        await client.query(
          `INSERT INTO reseller_account_link
             (account_id, reseller_id, margin_basis_points, since, until, linked_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            link.accountId, link.resellerId, link.marginBasisPoints ?? null,
            link.since, link.until ?? null, link.linkedBy,
          ],
        );
      }
    });
  }

  private async readLinks(sql: string, values: readonly unknown[]): Promise<AccountLink[]> {
    const rows = await this.database.query<{
      account_id: string; reseller_id: string; margin_basis_points: number | null;
      since: Date; until: Date | null; linked_by: string;
    }>(sql, values);
    return rows.map((row) => ({
      accountId: row.account_id,
      resellerId: row.reseller_id,
      // Absent rather than null: an override that is not set means "use the
      // reseller's standard rate", and null would be read as a rate of zero.
      marginBasisPoints: row.margin_basis_points ?? undefined,
      since: row.since.toISOString(),
      until: row.until ? row.until.toISOString() : undefined,
      linkedBy: row.linked_by,
    }));
  }
}

export class PostgresTerritoryStore implements TerritoryStore {
  constructor(private readonly database: Database) {}

  async get(area: string): Promise<Territory | undefined> {
    const rows = await this.database.query<{
      area: string; reseller_id: string; granted_at: Date; granted_by: string;
    }>('SELECT * FROM reseller_territory WHERE area = $1', [area]);
    const row = rows[0];
    return row ? {
      area: row.area, resellerId: row.reseller_id,
      grantedAt: row.granted_at.toISOString(), grantedBy: row.granted_by,
    } : undefined;
  }

  async put(territory: Territory): Promise<void> {
    // The service checks for a clash and refuses; this is the second line, in
    // the one place a race between two grants could still collide.
    await this.database.query(
      `INSERT INTO reseller_territory (area, reseller_id, granted_at, granted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (area) DO UPDATE SET
         reseller_id = EXCLUDED.reseller_id, granted_at = EXCLUDED.granted_at,
         granted_by = EXCLUDED.granted_by
       WHERE reseller_territory.reseller_id = EXCLUDED.reseller_id`,
      [territory.area, territory.resellerId, territory.grantedAt, territory.grantedBy],
    );
  }

  async delete(area: string): Promise<void> {
    await this.database.query('DELETE FROM reseller_territory WHERE area = $1', [area]);
  }

  async all(): Promise<readonly Territory[]> {
    const rows = await this.database.query<{
      area: string; reseller_id: string; granted_at: Date; granted_by: string;
    }>('SELECT * FROM reseller_territory ORDER BY area');
    return rows.map((row) => ({
      area: row.area, resellerId: row.reseller_id,
      grantedAt: row.granted_at.toISOString(), grantedBy: row.granted_by,
    }));
  }
}

export class PostgresSupportRequestStore implements SupportRequestStore {
  constructor(private readonly database: Database) {}

  async put(request: SupportRequest): Promise<void> {
    await this.database.query(
      `INSERT INTO support_request (request_id, account_id, tenant_id, state, document)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (request_id) DO UPDATE SET
         state = EXCLUDED.state, document = EXCLUDED.document`,
      [
        request.requestId, request.accountId, request.tenantId,
        request.state, JSON.stringify(request),
      ],
    );
  }

  async get(requestId: string): Promise<SupportRequest | undefined> {
    const rows = await this.database.query<{ document: SupportRequest }>(
      'SELECT document FROM support_request WHERE request_id = $1', [requestId],
    );
    return rows[0]?.document;
  }

  async forAccount(accountId: string): Promise<readonly SupportRequest[]> {
    const rows = await this.database.query<{ document: SupportRequest }>(
      'SELECT document FROM support_request WHERE account_id = $1 ORDER BY created_at DESC',
      [accountId],
    );
    return rows.map((row) => row.document);
  }

  async open(): Promise<readonly SupportRequest[]> {
    const rows = await this.database.query<{ document: SupportRequest }>(
      "SELECT document FROM support_request WHERE state = 'open' ORDER BY created_at",
    );
    return rows.map((row) => row.document);
  }
}
