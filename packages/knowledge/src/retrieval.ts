import type { KnowledgeChunk, KnowledgeCorpus } from './corpus.js';

/**
 * Retrieval with tenant binding applied at query construction (section 24.2).
 *
 * The scoring is BM25-style lexical matching over the published corpus. That is
 * a deliberate choice for the governed layer: it is deterministic, it explains
 * itself, and the retrieval abstraction can be swapped for the conversational
 * vendor's integrated vector search without any caller changing (table 20).
 *
 * Audit PERF-4: every visitor turn used to tokenise the entire published
 * corpus, rebuild the document-frequency map and recompute the average document
 * length before scoring, O(corpus) of pure CPU on the request path, per
 * message, single-threaded. The index and its length statistics are now built
 * once per corpus version and cached per tenant, and scoring walks only the
 * postings for the query's own terms. Same public interface, same scores, two
 * orders of magnitude less work on the turn.
 */
export interface RetrievedChunk {
  readonly chunk: KnowledgeChunk;
  readonly score: number;
}

export interface RetrievalOptions {
  readonly limit?: number;
  readonly minScore?: number;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'as', 'it', 'this',
  'that', 'do', 'does', 'did', 'can', 'could', 'you', 'your', 'we', 'our', 'i',
]);

export function tokenise(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9£$€%+.-]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

const K1 = 1.2;
const B = 0.75;

interface Posting {
  /** Index into the index's `chunks` array. */
  readonly doc: number;
  readonly frequency: number;
}

/**
 * The inverted index for one tenant at one corpus version.
 *
 * Immutable once built. A publish or retire bumps the corpus version, which
 * makes the cached index unreachable rather than stale; an index that can be
 * mutated in place is an index that can serve a retired chunk.
 */
interface CorpusIndex {
  readonly signature: string;
  readonly chunks: readonly KnowledgeChunk[];
  readonly lengths: readonly number[];
  readonly averageLength: number;
  readonly postings: ReadonlyMap<string, readonly Posting[]>;
}

function buildIndex(signature: string, chunks: readonly KnowledgeChunk[]): CorpusIndex {
  const postings = new Map<string, Posting[]>();
  const lengths: number[] = [];

  chunks.forEach((chunk, doc) => {
    const tokens = tokenise(`${chunk.title} ${chunk.text}`);
    lengths.push(tokens.length);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    for (const [token, frequency] of counts) {
      const list = postings.get(token) ?? [];
      list.push({ doc, frequency });
      postings.set(token, list);
    }
  });

  const totalLength = lengths.reduce((sum, length) => sum + length, 0);
  return {
    signature,
    chunks,
    lengths,
    averageLength: chunks.length === 0 ? 0 : totalLength / chunks.length,
    postings,
  };
}

export class RetrievalService {
  private readonly indexes = new Map<string, CorpusIndex>();

  constructor(
    private readonly corpus: KnowledgeCorpus,
    /** Tenants whose index is kept resident. Beyond this the least recent is dropped. */
    private readonly maxCachedTenants = 256,
  ) {}

  /**
   * The cached index for a tenant, rebuilt only when the corpus moves.
   *
   * The signature includes the published-chunk count as well as the corpus
   * version: the version is the authority, and the count is a cheap second
   * opinion that catches a store which forgets to bump it.
   */
  private index(tenantId: string): CorpusIndex {
    const chunks = this.corpus.published(tenantId);
    const signature = `${this.corpus.version(tenantId)}:${chunks.length}`;
    const cached = this.indexes.get(tenantId);
    if (cached && cached.signature === signature) return cached;

    const built = buildIndex(signature, chunks);
    if (this.indexes.size >= this.maxCachedTenants && !this.indexes.has(tenantId)) {
      // Insertion-ordered map: the first key is the least recently built.
      const oldest = this.indexes.keys().next();
      if (!oldest.done) this.indexes.delete(oldest.value);
    }
    this.indexes.set(tenantId, built);
    return built;
  }

  /** Drop a tenant's cached index. Used by erasure and by offboarding. */
  invalidate(tenantId: string): void {
    this.indexes.delete(tenantId);
  }

  /**
   * Retrieve for one tenant. There is no overload that omits the tenant id and
   * no default: a caller that forgets it does not compile.
   */
  retrieve(tenantId: string, query: string, options: RetrievalOptions = {}): RetrievedChunk[] {
    const index = this.index(tenantId);
    if (index.chunks.length === 0) return [];

    const queryTokens = tokenise(query);
    if (queryTokens.length === 0) return [];

    // Only documents that contain at least one query term are scored. The old
    // implementation scored every document in the corpus, including the ones
    // whose score was arithmetically guaranteed to be zero.
    const scores = new Map<number, number>();
    const documentCount = index.chunks.length;

    // Query-term frequency is carried through rather than de-duplicated, so a
    // repeated term weighs the same as it did before the index existed.
    const queryFrequency = new Map<string, number>();
    for (const token of queryTokens) queryFrequency.set(token, (queryFrequency.get(token) ?? 0) + 1);

    for (const [queryToken, occurrences] of queryFrequency) {
      const postings = index.postings.get(queryToken);
      if (!postings) continue;
      const df = postings.length;
      const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5));
      for (const posting of postings) {
        const length = index.lengths[posting.doc]!;
        const denominator = posting.frequency + K1 * (1 - B + (B * length) / (index.averageLength || 1));
        const contribution = occurrences * idf * ((posting.frequency * (K1 + 1)) / denominator);
        scores.set(posting.doc, (scores.get(posting.doc) ?? 0) + contribution);
      }
    }

    const minScore = options.minScore ?? 0.15;
    const results: { doc: number; chunk: KnowledgeChunk; score: number }[] = [];
    for (const [doc, raw] of scores) {
      const score = Math.round(raw * 1000) / 1000;
      if (score < minScore) continue;
      results.push({ doc, chunk: index.chunks[doc]!, score });
    }

    // Ties break on corpus order, as they did when every chunk was scored in
    // order, a retrieval that reorders equal-scoring chunks between calls is a
    // conversation that answers differently for no reason anyone can explain.
    return results
      .sort((a, b) => b.score - a.score || a.doc - b.doc)
      .map(({ chunk, score }) => ({ chunk, score }))
      .slice(0, options.limit ?? 4);
  }
}
