import { newId, WriteQueue, type Clock, systemClock } from '@detent/awa-core';

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

/**
 * Where a corpus keeps its chunks when the process is not running.
 *
 * Deliberately two methods. Anything wider invites a caller to read across
 * tenants: `loadFor` takes the tenant id as an argument rather than as an
 * optional filter, so a query that does not name whose knowledge it wants
 * does not typecheck. The Postgres implementation backs it with a table
 * carrying FORCE ROW LEVEL SECURITY, so the same rule holds at the database
 * even if a future caller gets it wrong here.
 */
export interface KnowledgeArchive {
  /** Upsert by chunk id. Called for every state change, in order per id. */
  save(chunk: KnowledgeChunk): Promise<void>;
  /** Every chunk the archive holds for one tenant. */
  loadFor(tenantId: string): Promise<readonly KnowledgeChunk[]>;
}

export interface RefreshOptions {
  readonly intervalMs: number;
  /** Which tenants to refresh, read fresh on each tick. */
  readonly tenants: () => readonly string[];
  readonly onError?: (error: unknown) => void;
}

export class KnowledgeCorpus {
  private readonly chunks = new Map<string, KnowledgeChunk[]>();
  private readonly versions = new Map<string, number>();
  /**
   * Per-chunk-id ordering for write-through saves. Ingest writes a draft and
   * approval writes it published microseconds later; un-awaited, those are two
   * promises racing and the draft can land last. See WriteQueue.
   */
  private readonly writes = new WriteQueue();
  private lastWriteError: unknown;

  constructor(
    private readonly clock: Clock = systemClock,
    private readonly archive?: KnowledgeArchive,
  ) {}

  /**
   * Queue a write-through save for one chunk. Never awaited by callers: the
   * in-memory model stays synchronous, and `flush()` is how a caller that
   * needs the save on disk (a test, a shutdown) waits for it.
   */
  private writeThrough(chunk: KnowledgeChunk): void {
    const archive = this.archive;
    if (!archive) return;
    this.writes.run(
      chunk.id,
      () => archive.save(chunk),
      (error) => { this.lastWriteError = error; },
    );
  }

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
    this.writeThrough(chunk);
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
    this.writeThrough(published);
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
    const retired: KnowledgeChunk = { ...list[index]!, state: 'RETIRED' };
    list[index] = retired;
    this.versions.set(tenantId, (this.versions.get(tenantId) ?? 0) + 1);
    this.writeThrough(retired);
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

  /**
   * Wait for every queued write-through save, then surface the last failure.
   *
   * Callers that need to know the corpus is on disk (shutdown, a test, the
   * step before reporting an approval back to a customer) await this. A save
   * that failed is raised here rather than swallowed, because the alternative
   * is telling a customer their answer is live when it is only in memory.
   */
  async flush(): Promise<void> {
    await this.writes.drain();
    const error = this.lastWriteError;
    if (error !== undefined) {
      this.lastWriteError = undefined;
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /**
   * Refill the in-memory index for the named tenants from the archive and
   * return how many chunks were loaded.
   *
   * The version counter is restored alongside the chunks. Without it a new
   * process starts counting from zero and the next publish reuses a version
   * number that already means something else, which makes "what did it say in
   * March" unanswerable.
   *
   * With no archive this is a no-op returning 0, so a caller does not have to
   * know whether it is running durably.
   */
  async rehydrate(tenantIds: readonly string[]): Promise<number> {
    const archive = this.archive;
    if (!archive) return 0;
    let loaded = 0;
    for (const tenantId of tenantIds) {
      // Load first, replace second. A failed load leaves the tenant's index
      // exactly as it was: stale beats gone, because an emptied index answers
      // nothing and reads to a visitor as an assistant that knows nothing.
      const stored = await archive.loadFor(tenantId);
      this.chunks.set(tenantId, [...stored]);
      let highest = 0;
      for (const chunk of stored) {
        if (chunk.corpusVersion > highest) highest = chunk.corpusVersion;
      }
      this.versions.set(tenantId, highest);
      loaded += stored.length;
    }
    return loaded;
  }

  /**
   * Poll the archive so a second instance of the same deployment catches up
   * without a restart.
   *
   * The index is in memory and was filled once, at boot. Knowledge approved on
   * one instance was invisible to the others until they happened to restart,
   * so a customer publishing an answer and testing it got "I do not know" from
   * whichever instance had not heard. On a three-instance autoscale deployment
   * that is two requests in three, and it reads as an unreliable assistant
   * rather than as a misconfigured platform.
   *
   * Returns the stop function. A refresh that throws is reported and skipped,
   * never allowed to empty the index.
   */
  startRefreshing(options: RefreshOptions): () => void {
    const timer = setInterval(() => {
      void this.rehydrate(options.tenants()).catch((error: unknown) => {
        options.onError?.(error);
      });
    }, options.intervalMs);
    // Refreshing must not be the reason a process stays alive at shutdown.
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }
}
