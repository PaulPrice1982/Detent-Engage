import { newId, type Clock, systemClock } from '@detent/awa-core';

/**
 * Governed ingestion (section 15).
 *
 * Three rules are enforced structurally rather than by process discipline:
 * content enters as a DRAFT and must be approved by the tenant before it is
 * served; every published change is versioned and attributed, so "why did it
 * say that in March" is answerable; and unshipped capability is excluded from
 * the corpus entirely, because an assistant that can retrieve a roadmap item
 * will eventually sell it.
 */
export type ChunkState = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

export type SourceKind = 'uploaded_document' | 'approved_page' | 'service_catalogue' | 'faq' | 'case_study';

export interface KnowledgeChunk {
  readonly id: string;
  readonly tenantId: string;
  readonly corpusVersion: number;
  readonly state: ChunkState;
  readonly sourceKind: SourceKind;
  readonly sourceRef: string;
  readonly title: string;
  readonly text: string;
  /** Set by the tenant. Unshipped material is refused at ingestion. */
  readonly shipped: boolean;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly createdAt: string;
  readonly supersedes?: string;
}

export interface IngestInput {
  readonly tenantId: string;
  readonly sourceKind: SourceKind;
  readonly sourceRef: string;
  readonly title: string;
  readonly text: string;
  readonly shipped: boolean;
}

export class KnowledgeCorpus {
  private readonly chunks = new Map<string, KnowledgeChunk[]>();
  private readonly versions = new Map<string, number>();

  constructor(private readonly clock: Clock = systemClock) {}

  /** Ingest as DRAFT. Nothing is servable until a named tenant user approves it. */
  ingest(input: IngestInput): KnowledgeChunk {
    if (!input.shipped) {
      // An unshipped capability never enters the corpus. Queries about it are
      // qualified and handed to a human instead (section 15, table 20).
      throw new Error('unshipped capability cannot be ingested; it must be excluded from the corpus');
    }
    const chunk: KnowledgeChunk = {
      id: newId('kc', this.clock.nowMs()),
      tenantId: input.tenantId,
      corpusVersion: this.versions.get(input.tenantId) ?? 0,
      state: 'DRAFT',
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      title: input.title,
      text: input.text,
      shipped: true,
      createdAt: this.clock.iso(),
    };
    const list = this.chunks.get(input.tenantId) ?? [];
    list.push(chunk);
    this.chunks.set(input.tenantId, list);
    return chunk;
  }

  /** Publish a draft. Bumps the corpus version so a rollback target exists. */
  publish(tenantId: string, chunkId: string, approvedBy: string): KnowledgeChunk {
    const list = this.chunks.get(tenantId) ?? [];
    const index = list.findIndex((chunk) => chunk.id === chunkId);
    if (index < 0) throw new Error(`chunk ${chunkId} not found for tenant ${tenantId}`);

    const version = (this.versions.get(tenantId) ?? 0) + 1;
    this.versions.set(tenantId, version);

    const published: KnowledgeChunk = {
      ...list[index]!,
      state: 'PUBLISHED',
      corpusVersion: version,
      approvedBy,
      approvedAt: this.clock.iso(),
    };
    list[index] = published;
    return published;
  }

  /**
   * Retire a chunk. Bumps the corpus version, because retirement changes what
   * is served and anything caching an index keyed on the version must miss
   * (audit PERF-4). A cache that can serve a retired chunk is worse than no
   * cache at all.
   */
  retire(tenantId: string, chunkId: string): void {
    const list = this.chunks.get(tenantId) ?? [];
    const index = list.findIndex((chunk) => chunk.id === chunkId);
    if (index < 0) return;
    list[index] = { ...list[index]!, state: 'RETIRED' };
    this.versions.set(tenantId, (this.versions.get(tenantId) ?? 0) + 1);
  }

  /**
   * Read published chunks for exactly one tenant. The tenant id is a required
   * argument, not an optional filter — binding at query construction rather
   * than post-filtering is what makes cross-tenant isolation testable.
   */
  published(tenantId: string): KnowledgeChunk[] {
    return (this.chunks.get(tenantId) ?? []).filter((chunk) => chunk.state === 'PUBLISHED');
  }

  version(tenantId: string): number {
    return this.versions.get(tenantId) ?? 0;
  }

  all(tenantId: string): KnowledgeChunk[] {
    return [...(this.chunks.get(tenantId) ?? [])];
  }
}
