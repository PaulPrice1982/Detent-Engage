/**
 * Serialises writes per key.
 *
 * Needed wherever a synchronous in-memory model writes through to durable
 * storage without awaiting. Two un-awaited writes for the same record have no
 * order: they are two promises racing, and the one that finishes last wins
 * whatever it happened to be carrying.
 *
 * That is not theoretical. Ingesting a knowledge chunk writes it as a draft
 * and approving it writes it as published, microseconds apart. With no
 * ordering, the draft write landed last for five of fourteen chunks, and the
 * corpus came back from a restart with a third of its answers reverted to
 * drafts. They were live and correct in memory, wrong on disk, and wrong in exactly the
 * way nobody looks at until the restart.
 *
 * Writes to *different* keys still run concurrently; only same-key writes
 * queue, which is the narrowest ordering that fixes it.
 */
export class WriteQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  /**
   * Runs `work` after any earlier work queued for the same key.
   *
   * A failure is reported through `onError` and does not break the chain: the
   * next write for that key still runs, because one failed save must not
   * silently stop every later save for the same record.
   */
  run(key: string, work: () => Promise<unknown>, onError: (error: unknown) => void): void {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(work)
      .catch(onError)
      .finally(() => {
        // Only clear if nothing else queued behind this, or a later write's
        // chain would be dropped and stop serialising.
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  /** Waits for everything queued so far. For shutdown, and for tests. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.chains.values()]);
  }

  get pending(): number {
    return this.chains.size;
  }
}
