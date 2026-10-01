import { AwaError } from '@detent/awa-core';
import type { PlanCatalogueStore, PlanVersion, PlanCode } from '@detent/awa-billing';
import type { Database } from './database.js';

/** Commercial terms never change in place; publication switches both states atomically. */
export class PostgresPlanCatalogueStore implements PlanCatalogueStore {
  constructor(private readonly db: Database) {}
  async get(code: PlanCode, version: number): Promise<PlanVersion | undefined> {
    return (await this.db.query<{ document: PlanVersion }>(
      'SELECT document FROM plan_version WHERE plan_code = $1 AND version = $2', [code, version],
    ))[0]?.document;
  }
  async put(version: PlanVersion): Promise<void> {
    const rows = await this.db.query(
      `INSERT INTO plan_version (plan_code, version, document) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (plan_code, version) DO UPDATE SET document = EXCLUDED.document
       WHERE plan_version.document->>'state' = 'draft'
         AND EXCLUDED.document->>'state' = 'withdrawn'
         AND (plan_version.document - 'state' - 'withdrawnAt') = (EXCLUDED.document - 'state' - 'withdrawnAt')
       RETURNING version`, [version.planCode, version.version, JSON.stringify(version)],
    );
    if (!rows.length) throw new AwaError({ kind: 'CONFLICT', message: 'Catalogue version already exists.' });
  }
  async listVersions(code: PlanCode): Promise<readonly PlanVersion[]> {
    return (await this.db.query<{ document: PlanVersion }>(
      'SELECT document FROM plan_version WHERE plan_code = $1 ORDER BY version DESC', [code],
    )).map(row => row.document);
  }
  async listAll(): Promise<readonly PlanVersion[]> {
    return (await this.db.query<{ document: PlanVersion }>(
      'SELECT document FROM plan_version ORDER BY plan_code, version DESC',
    )).map(row => row.document);
  }
  async publish(version: PlanVersion, previousVersion?: number): Promise<void> {
    await this.db.transaction(async client => {
      await client.query('SELECT pg_advisory_xact_lock(184238, hashtext($1))', [version.planCode]);
      const { rows } = await client.query<{ document: PlanVersion }>(
        'SELECT document FROM plan_version WHERE plan_code = $1 FOR UPDATE', [version.planCode],
      );
      const current = rows.find(row => row.document.state === 'published')?.document;
      const draft = rows.find(row => row.document.version === version.version)?.document;
      if (current?.version !== previousVersion || draft?.state !== 'draft') {
        throw new AwaError({ kind: 'CONFLICT', message: 'Catalogue changed; review publication again.' });
      }
      if (current) await client.query(
        'UPDATE plan_version SET document = $3::jsonb WHERE plan_code = $1 AND version = $2',
        [current.planCode, current.version, JSON.stringify({ ...current, state: 'withdrawn', withdrawnAt: version.publishedAt })],
      );
      // Use stored terms, never a caller-supplied replacement price.
      await client.query('UPDATE plan_version SET document = $3::jsonb WHERE plan_code = $1 AND version = $2',
        [version.planCode, version.version, JSON.stringify({ ...draft, state: 'published', publishedAt: version.publishedAt, publishedBy: version.publishedBy })]);
    });
  }
}
