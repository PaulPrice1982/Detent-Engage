import type { TenantConfig } from '@detent/awa-core';
import type { KnowledgeArchive, KnowledgeChunk } from '@detent/awa-knowledge';
import type { Database } from './database.js';

/**
 * Tenants and their knowledge, durable.
 *
 * These are together because knowledge_chunk references tenant: a customer's
 * uploads cannot be saved unless the customer exists in the same database.
 * That reference is correct and worth keeping: it is what stops knowledge
 * outliving the tenant it belongs to, so the tenant is made durable first.
 *
 * Of everything that was in memory, this is the loss a customer would feel
 * first. Losing their knowledge means every answer they approved is gone and
 * the assistant says it does not know, which from the outside is
 * indistinguishable from a customer who never uploaded anything.
 */

export interface TenantArchive {
  save(config: TenantConfig): Promise<void>;
  loadAll(): Promise<readonly TenantConfig[]>;
}

export class PostgresTenantArchive implements TenantArchive {
  /**
   * Survives a restart, which is what `Platform.durable` measures rather than
   * takes on trust from the deployment.
   */
  readonly durable = true;
  constructor(private readonly database: Database) {}

  async save(config: TenantConfig): Promise<void> {
    // The whole row every time, not a patch. The table's lifecycle constraints
    // relate state to its timestamps, so a partial update can produce a row
    // the database is right to reject: a tenant CRM-connected with no DPA.
    await this.database.query(
      `INSERT INTO tenant
         (tenant_id, name, state, residency, home_jurisdiction, connector,
          config_version, config, dpa_signed_at, field_mapping_accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tenant_id) DO UPDATE SET
         name = EXCLUDED.name, state = EXCLUDED.state,
         residency = EXCLUDED.residency,
         home_jurisdiction = EXCLUDED.home_jurisdiction,
         connector = EXCLUDED.connector,
         config_version = EXCLUDED.config_version, config = EXCLUDED.config,
         dpa_signed_at = EXCLUDED.dpa_signed_at,
         field_mapping_accepted_at = EXCLUDED.field_mapping_accepted_at,
         updated_at = now()`,
      [
        config.tenantId, config.name, config.state, config.residency,
        config.homeJurisdiction, config.connector, config.version,
        JSON.stringify(config),
        // Lifted out of the config rather than passed separately: the
        // table's lifecycle constraints are stated in terms of them, and two
        // sources for one fact is how they come to disagree.
        (config as { dpaSignedAt?: string }).dpaSignedAt ?? null,
        (config as { fieldMappingAcceptedAt?: string }).fieldMappingAcceptedAt ?? null,
      ],
    );
  }

  async loadAll(): Promise<readonly TenantConfig[]> {
    const rows = await this.database.query<{ config: TenantConfig }>(
      'SELECT config FROM tenant ORDER BY created_at',
    );
    return rows.map((row) => row.config);
  }
}

export class PostgresKnowledgeArchive implements KnowledgeArchive {
  /**
   * Survives a restart, which is what `Platform.durable` measures rather than
   * takes on trust from the deployment.
   */
  readonly durable = true;
  constructor(private readonly database: Database) {}

  async save(chunk: KnowledgeChunk): Promise<void> {
    await this.database.queryAs(
      chunk.tenantId,
      `INSERT INTO knowledge_chunk
         (id, tenant_id, corpus_version, state, source_kind, source_ref,
          title, body, approved_by, approved_at, supersedes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (id) DO UPDATE SET
         corpus_version = EXCLUDED.corpus_version, state = EXCLUDED.state,
         title = EXCLUDED.title, body = EXCLUDED.body,
         approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at`,
      [
        chunk.id, chunk.tenantId, chunk.corpusVersion, chunk.state,
        chunk.sourceKind, chunk.sourceRef, chunk.title, chunk.text,
        chunk.approvedBy ?? null, chunk.approvedAt ?? null,
        chunk.supersedes ?? null, chunk.createdAt,
      ],
    );
  }

  async loadFor(tenantId: string): Promise<readonly KnowledgeChunk[]> {
    // Ordered by creation, so a rehydrated corpus lists a tenant's chunks in
    // the order they were added rather than in whatever order the table
    // happens to return.
    const rows = await this.database.queryAs<{
      id: string; tenant_id: string; corpus_version: number; state: string;
      source_kind: string; source_ref: string; title: string; body: string;
      approved_by: string | null; approved_at: Date | null;
      supersedes: string | null; created_at: Date;
    }>(
      tenantId,
      'SELECT * FROM knowledge_chunk WHERE tenant_id = $1 ORDER BY created_at',
      [tenantId],
    );

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      corpusVersion: row.corpus_version,
      state: row.state as KnowledgeChunk['state'],
      sourceKind: row.source_kind as KnowledgeChunk['sourceKind'],
      sourceRef: row.source_ref,
      title: row.title,
      text: row.body,
      // Anything in the corpus was shipped when it was ingested; unshipped
      // material is refused at ingestion and never reaches this table.
      shipped: true,
      approvedBy: row.approved_by ?? undefined,
      approvedAt: row.approved_at?.toISOString(),
      supersedes: row.supersedes ?? undefined,
      createdAt: row.created_at.toISOString(),
    }));
  }
}
