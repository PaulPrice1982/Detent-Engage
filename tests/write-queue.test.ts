import { describe, expect, it } from 'vitest';
import { WriteQueue } from '@detent/awa-core';
import { KnowledgeCorpus, type KnowledgeArchive, type KnowledgeChunk } from '@detent/awa-knowledge';

/**
 * Ordering of write-through saves.
 *
 * The bug this exists for: a synchronous in-memory model that writes through
 * without awaiting fires two promises for the same record and takes whichever
 * finishes last. Ingesting a chunk saves it as a draft and approving it saves
 * it published, microseconds apart, and five of fourteen chunks came back
 * from a restart as drafts, correct in memory and wrong on disk.
 */

describe('the write queue', () => {
  it('runs same-key writes in the order they were queued', async () => {
    const queue = new WriteQueue();
    const done: string[] = [];
    const after = (ms: number, label: string) => () =>
      new Promise<void>((resolve) => setTimeout(() => { done.push(label); resolve(); }, ms));

    // The first write is slow and the second is instant. Unordered, the second
    // would land first and be overwritten by the first.
    queue.run('same', after(40, 'first'), () => {});
    queue.run('same', after(0, 'second'), () => {});
    await queue.drain();

    expect(done).toEqual(['first', 'second']);
  });

  it('does not make writes to different keys wait for each other', async () => {
    const queue = new WriteQueue();
    const done: string[] = [];
    queue.run('a', () => new Promise<void>((r) => setTimeout(() => { done.push('slow'); r(); }, 40)), () => {});
    queue.run('b', () => { done.push('quick'); return Promise.resolve(); }, () => {});
    await queue.drain();
    // Only same-key writes queue. Serialising everything would make one slow
    // save hold up every unrelated one.
    expect(done).toEqual(['quick', 'slow']);
  });

  it('keeps going after a failed write, and reports it', async () => {
    const queue = new WriteQueue();
    const errors: unknown[] = [];
    const done: string[] = [];
    queue.run('k', () => Promise.reject(new Error('disk full')), (error) => errors.push(error));
    queue.run('k', () => { done.push('later'); return Promise.resolve(); }, () => {});
    await queue.drain();

    // One failed save must not silently stop every later save for that record.
    expect(errors).toHaveLength(1);
    expect(done).toEqual(['later']);
  });
});

/**
 * An archive shared between corpus instances, as a real one is.
 *
 * Declared here rather than inside one describe because two suites need it:
 * the write-through ordering, and what a second instance of the same
 * deployment can see.
 */
class SlowFirstArchive implements KnowledgeArchive {
  readonly saved: KnowledgeChunk[] = [];
  failLoads = false;
  private first = true;
  async save(chunk: KnowledgeChunk): Promise<void> {
    const delay = this.first ? 30 : 0;
    this.first = false;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
    this.saved.push(chunk);
  }
  async loadFor(tenantId: string): Promise<readonly KnowledgeChunk[]> {
    if (this.failLoads) throw new Error('the archive is unavailable');
    // Last write wins per id, which is what a real upsert does. Scoped to one
    // tenant, as the real archive is: the table it reads carries FORCE ROW
    // LEVEL SECURITY and a query has to name whose knowledge it wants.
    const byId = new Map<string, KnowledgeChunk>();
    for (const chunk of this.saved) {
      if (chunk.tenantId === tenantId) byId.set(chunk.id, chunk);
    }
    return [...byId.values()];
  }
}

describe('a corpus that writes through to an archive', () => {
  /** An archive whose saves finish out of order, as real ones do. */

  it('saves an approved chunk as approved, not as the draft it started as', async () => {
    const archive = new SlowFirstArchive();
    const corpus = new KnowledgeCorpus(undefined, archive);
    const chunk = corpus.ingest({
      tenantId: 't_1', sourceKind: 'faq', sourceRef: 'test',
      title: 'Refunds', text: 'Five days.', shipped: true,
    });
    corpus.publish('t_1', chunk.id, 'someone');
    await corpus.flush();

    const stored = await archive.loadFor('t_1');
    expect(stored).toHaveLength(1);
    expect(stored[0]?.state).toBe('PUBLISHED');
    expect(stored[0]?.approvedBy).toBe('someone');
  });

  it('comes back from the archive with its answers still published', async () => {
    const archive = new SlowFirstArchive();
    const first = new KnowledgeCorpus(undefined, archive);
    const chunk = first.ingest({
      tenantId: 't_1', sourceKind: 'faq', sourceRef: 'test',
      title: 'Refunds', text: 'Five days.', shipped: true,
    });
    first.publish('t_1', chunk.id, 'someone');
    await first.flush();

    // A new process, same archive.
    const second = new KnowledgeCorpus(undefined, archive);
    expect(await second.rehydrate(['t_1'])).toBe(1);
    expect(second.published('t_1')).toHaveLength(1);
    // The version counter has to come back too, or the next publish reuses a
    // number that already means something else.
    expect(second.version('t_1')).toBe(first.version('t_1'));
  });

  it('works with no archive at all', async () => {
    const corpus = new KnowledgeCorpus();
    const chunk = corpus.ingest({
      tenantId: 't_1', sourceKind: 'faq', sourceRef: 'test',
      title: 'x', text: 'y', shipped: true,
    });
    corpus.publish('t_1', chunk.id, 'someone');
    expect(corpus.published('t_1')).toHaveLength(1);
    expect(await corpus.rehydrate(['t_1'])).toBe(0);
  });
});

/**
 * Two instances of the same deployment, which is how this actually runs.
 *
 * The index is in memory and was filled once, at boot. Knowledge approved on
 * one instance was invisible to the others until they happened to restart, so a
 * customer publishing an answer and testing it got "I do not know" from
 * whichever instance had not heard. On a three instance autoscale deployment
 * that is two requests in three, and it reads as an unreliable assistant rather
 * than as a misconfigured platform.
 */
describe('a second instance of the same deployment', () => {
  it('does not see an approval made on the first until it refreshes', async () => {
    const archive = new SlowFirstArchive();
    const first = new KnowledgeCorpus(undefined, archive);
    const second = new KnowledgeCorpus(undefined, archive);
    await second.rehydrate(['t_1']);

    const chunk = first.ingest({
      tenantId: 't_1', sourceKind: 'faq', sourceRef: 'test',
      title: 'Refunds', text: 'Fourteen days.', shipped: true,
    });
    first.publish('t_1', chunk.id, 'someone');
    await first.flush();

    // The state this exists to describe, asserted rather than assumed.
    expect(second.published('t_1')).toHaveLength(0);

    await second.rehydrate(['t_1']);
    expect(second.published('t_1')).toHaveLength(1);
  });

  it('catches up on its own, without a restart', async () => {
    const archive = new SlowFirstArchive();
    const first = new KnowledgeCorpus(undefined, archive);
    const second = new KnowledgeCorpus(undefined, archive);
    const stop = second.startRefreshing({ intervalMs: 10, tenants: () => ['t_1'] });
    try {
      const chunk = first.ingest({
        tenantId: 't_1', sourceKind: 'faq', sourceRef: 'test',
        title: 'Delivery', text: 'Next day.', shipped: true,
      });
      first.publish('t_1', chunk.id, 'someone');
      await first.flush();

      const deadline = Date.now() + 2000;
      while (second.published('t_1').length === 0 && Date.now() < deadline) {
        await new Promise((wake) => setTimeout(wake, 10));
      }
      expect(second.published('t_1')).toHaveLength(1);
    } finally {
      stop();
    }
  });

  it('keeps serving the index it has when a refresh fails', async () => {
    const archive = new SlowFirstArchive();
    const corpus = new KnowledgeCorpus(undefined, archive);
    const chunk = corpus.ingest({
      tenantId: 't_1', sourceKind: 'faq', sourceRef: 'test',
      title: 'Hours', text: 'Nine to five.', shipped: true,
    });
    corpus.publish('t_1', chunk.id, 'someone');
    await corpus.flush();

    const errors: unknown[] = [];
    archive.failLoads = true;
    const stop = corpus.startRefreshing({
      intervalMs: 10, tenants: () => ['t_1'], onError: (error) => errors.push(error),
    });
    try {
      await new Promise((wake) => setTimeout(wake, 60));
      // Stale beats gone. An index emptied by a failed refresh answers nothing.
      expect(corpus.published('t_1')).toHaveLength(1);
      expect(errors.length).toBeGreaterThan(0);
    } finally {
      stop();
      archive.failLoads = false;
    }
  });
});
