import type { TenantConfig } from '@detent/awa-core';
import type { Platform } from './platform.js';
import type { ApiKeyService } from './auth.js';
import type { CustomerWidgetProvisioner } from './customer-widgets.js';
import type { ApiResponse } from './api.js';
import type { InMemoryDocumentStore, InMemoryDraftStore } from '@detent/awa-ingestion';

export interface RuntimeKnowledgeState {
  documents: InMemoryDocumentStore;
  drafts: InMemoryDraftStore;
}

export interface RuntimeSnapshot {
  version: 1;
  tenants: TenantConfig[];
  keys: ReturnType<ApiKeyService['snapshot']>;
  widgets: ReturnType<CustomerWidgetProvisioner['snapshot']>;
  sessions: ReturnType<Platform['sessions']['snapshot']>;
  killSwitch: Platform['platformKillSwitch'];
  documents?: ReturnType<InMemoryDocumentStore['snapshot']>;
  drafts?: ReturnType<InMemoryDraftStore['snapshot']>;
}

export interface RuntimeArchive {
  load(): Promise<RuntimeSnapshot | undefined>;
  save(snapshot: RuntimeSnapshot): Promise<void>;
}

/** Single-writer runtime. The database lease is acquired before constructing it.
 * Requests are serialised because the domain models expose mutable cached state.
 * No success (including SSE) is returned until that state has committed. A failed
 * save poisons this instance: it must restart and recover committed state.
 */
export class DurableRuntime {
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  get ready(): boolean { return !this.failed; }

  constructor(
    private readonly archive: RuntimeArchive,
    private readonly platform: Platform,
    private readonly keys: ApiKeyService,
    private readonly widgets: CustomerWidgetProvisioner,
    private readonly knowledge?: RuntimeKnowledgeState,
  ) {}

  async restore(): Promise<void> {
    const state = await this.archive.load();
    if (state) {
      if (state.version !== 1) throw new Error('Unsupported runtime snapshot version');
      this.platform.tenants.restore(state.tenants);
      this.keys.restore(state.keys);
      this.widgets.restore(state.widgets);
      this.platform.sessions.restore(state.sessions);
      this.platform.platformKillSwitch = state.killSwitch;
      this.knowledge?.documents.restore(state.documents ?? []);
      this.knowledge?.drafts.restore(state.drafts ?? []);
    }
    await this.platform.corpus.rehydrate(this.platform.tenants.list().map(t => t.tenantId));
  }

  async flush(): Promise<void> {
    if (this.failed) throw new Error('Runtime persistence failed; restart required');
    try {
      await this.archive.save({
        version: 1, tenants: this.platform.tenants.list(), keys: this.keys.snapshot(),
        widgets: this.widgets.snapshot(), sessions: this.platform.sessions.snapshot(),
        killSwitch: this.platform.platformKillSwitch,
        documents: this.knowledge?.documents.snapshot(), drafts: this.knowledge?.drafts.snapshot(),
      });
      await this.platform.corpus.flush();
    } catch (error) { this.failed = true; throw error; }
  }

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.failed) throw new Error('Runtime persistence failed; restart required');
      try { return await work(); }
      finally { await this.flush(); }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  api(work: () => Promise<ApiResponse>): Promise<ApiResponse> {
    return this.run(async () => {
      const response = await work();
      if (!response.stream) return response;
      const events: { event: string; data: unknown }[] = [];
      for await (const event of response.stream) events.push(event);
      return { ...response, stream: (async function* () { yield* events; })() };
    });
  }
}
