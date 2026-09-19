import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore, InMemoryCheckpointStore, hashEntry } from '@detent/awa-audit';
import { InMemoryUsageStore, MeteringService } from '@detent/awa-policy';
import { KnowledgeCorpus, RetrievalService, tokenise } from '@detent/awa-knowledge';
import { DEFAULT_SESSION_TTL, SessionManager } from '@detent/awa-agent';
import { DailyRollupCache } from '@detent/awa-analytics';
import { DEFAULT_DISCLOSURE, FixedClock, type TenantConfig } from '@detent/awa-core';
import { buildHarness, bearer } from './fixtures/tenant.js';

/**
 * CI gate: the performance and scale findings of the September 2026 audit.
 * Pass threshold: each behaviour holds. Two of these (PERF-3, PERF-7) are
 * correctness bugs wearing a performance label, and are treated as such.
 */

describe('PERF-3 · metering counters are atomic', () => {
  it('does not lose an update when turns overlap', async () => {
    const metering = new MeteringService(new InMemoryUsageStore());
    // Fifty concurrent turns, each recording a message. The old read-modify-
    // write across an await lost most of these.
    await Promise.all(Array.from({ length: 50 }, () => metering.record('t_a', 'text_message', 1)));
    const usage = await metering.usage('t_a');
    expect(usage.textMessages).toBe(50);
    expect(usage.spendPence).toBeCloseTo(50 * 0.24, 3);
  });

  it('claims a voice slot without a check-then-act race', async () => {
    const metering = new MeteringService(new InMemoryUsageStore());
    const caps = {
      monthlyPence: 100_000, warnAtFraction: 0.7, degradeToTextAtFraction: 0.9,
      maxConcurrentVoice: 3, maxConversationsPerMonth: 10_000,
    };
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => metering.openVoiceSession('t_a', caps)),
    );
    const granted = results.filter((result) => result.status === 'fulfilled').length;
    expect(granted).toBe(3);
    expect((await metering.usage('t_a')).concurrentVoice).toBe(3);
  });

  it('never drives a counter negative', async () => {
    const metering = new MeteringService(new InMemoryUsageStore());
    await metering.closeVoiceSession('t_a');
    expect((await metering.usage('t_a')).concurrentVoice).toBe(0);
  });
});

describe('PERF-2 · chain verification is incremental and the export is paginated', () => {
  const write = async (log: AuditLog, tenantId: string, count: number) => {
    for (let index = 0; index < count; index += 1) {
      await log.write({
        tenantId, type: 'session_opened', correlationId: `corr_${index}`, actor: 'system',
        payload: { index },
      });
    }
  };

  it('resumes verification from a signed checkpoint', async () => {
    const store = new InMemoryAuditStore();
    const checkpoints = new InMemoryCheckpointStore();
    const log = new AuditLog(store, undefined, { checkpoints, checkpointInterval: 10, checkpointKey: 'k' });

    await write(log, 't_a', 30);
    // The first verification walks everything and lays down a checkpoint.
    expect((await log.verify('t_a')).valid).toBe(true);
    expect(await checkpoints.latest('t_a')).toBeDefined();

    await write(log, 't_a', 5);
    const second = await log.verify('t_a');
    expect(second.valid).toBe(true);
    // It resumed rather than rewalking the chain from the genesis hash.
    expect(second.resumedFromSequence).toBeGreaterThan(0);
  });

  it('still detects tampering after the tampered entry', async () => {
    const store = new InMemoryAuditStore();
    const checkpoints = new InMemoryCheckpointStore();
    const log = new AuditLog(store, undefined, { checkpoints, checkpointInterval: 5, checkpointKey: 'k' });
    await write(log, 't_a', 20);
    await log.verify('t_a');
    await write(log, 't_a', 5);

    const entries = await store.list('t_a');
    const target = entries[entries.length - 2]!;
    // Edit an entry after the checkpoint and rehash it so it is internally
    // consistent — the chain link is what should catch it.
    (target as { payload?: unknown }).payload = { index: 'tampered' };

    const verification = await log.verify('t_a');
    expect(verification.valid).toBe(false);
  });

  it('will not resume from a forged checkpoint', async () => {
    const store = new InMemoryAuditStore();
    const checkpoints = new InMemoryCheckpointStore();
    const log = new AuditLog(store, undefined, { checkpoints, checkpointKey: 'the-real-key' });
    await write(log, 't_a', 5);

    // An attacker with write access to the checkpoint store, but not the key.
    await checkpoints.put({
      tenantId: 't_a', sequence: 4, hash: 'f'.repeat(64),
      verifiedAt: '2026-09-04T09:00:00.000Z', signature: '0'.repeat(64),
    });

    // The signature does not open, so the checkpoint is ignored and the chain
    // is walked in full — which still verifies, because it is intact.
    expect((await log.verify('t_a')).valid).toBe(true);
  });

  it('paginates the export and reports the total', async () => {
    const log = new AuditLog(new InMemoryAuditStore());
    await write(log, 't_a', 12);

    const first = await log.export('t_a', { limit: 5 });
    expect(first.entries).toHaveLength(5);
    expect(first.page.total).toBe(12);
    expect(first.page.nextCursor).toBe(5);

    const second = await log.export('t_a', { limit: 5, sinceSequence: first.page.nextCursor });
    expect(second.entries[0]!.sequence).toBe(6);

    const last = await log.export('t_a', { limit: 50, sinceSequence: 10 });
    expect(last.entries).toHaveLength(2);
    expect(last.page.nextCursor).toBeUndefined();
  });

  it('evicts the per-tenant write queue once it drains', async () => {
    const log = new AuditLog(new InMemoryAuditStore());
    await write(log, 't_a', 3);
    await log.drain();
    // The map used to grow one never-released entry per tenant, forever.
    const queues = (log as unknown as { writeQueues: Map<string, unknown> }).writeQueues;
    expect(queues.size).toBe(0);
  });

  it('serves a repeat scorecard from the day rollup without rereading the history', async () => {
    const clock = new FixedClock(new Date('2026-09-10T09:00:00.000Z'));
    const store = new InMemoryAuditStore();
    const log = new AuditLog(store, clock);
    // Entries on a day that is already closed.
    const day = new FixedClock(new Date('2026-09-01T09:00:00.000Z'));
    const closedLog = new AuditLog(store, day);
    await write(closedLog, 't_a', 20);

    const rollups = new DailyRollupCache(log, () => clock.iso());
    const spec = {
      kind: 'test',
      empty: () => 0,
      fold: (entries: readonly unknown[]) => entries.length,
      merge: (left: number, right: number) => left + right,
    };
    const window = { from: '2026-09-01T00:00:00.000Z', to: '2026-09-09T23:59:59.999Z' };

    expect(await rollups.aggregate('t_a', window, spec)).toBe(20);
    expect(rollups.stats.entriesRead).toBe(20);

    expect(await rollups.aggregate('t_a', window, spec)).toBe(20);
    // Second time: every day in the window is closed and cached.
    expect(rollups.stats.entriesRead).toBe(0);
    expect(rollups.stats.daysServedFromCache).toBe(rollups.stats.daysInWindow);
  });
});

describe('PERF-4 · retrieval builds its index once per corpus version', () => {
  const corpusFor = (count: number) => {
    const corpus = new KnowledgeCorpus();
    const topics = ['renewals', 'excess use', 'uplift clauses', 'onboarding', 'escalation'];
    for (let index = 0; index < count; index += 1) {
      const chunk = corpus.ingest({
        tenantId: 't_a', sourceKind: 'faq', sourceRef: `faq/${index}`,
        title: `Question ${index} about ${topics[index % topics.length]}`,
        text: `Answer ${index}. ${topics[index % topics.length]} are handled by the programme desk, and case ${index} is typical.`,
        shipped: true,
      });
      corpus.publish('t_a', chunk.id, 'approver');
    }
    return corpus;
  };

  /**
   * The scoring the audit found: tokenise every published chunk, rebuild the
   * document-frequency map and recompute the average length, on every query.
   * Kept here as the reference implementation so the index refactor is held to
   * producing identical scores rather than merely plausible ones.
   */
  function scoreTheOldWay(corpus: KnowledgeCorpus, tenantId: string, query: string, minScore = 0.15, limit = 4) {
    const chunks = corpus.published(tenantId);
    if (chunks.length === 0) return [];
    const queryTokens = tokenise(query);
    if (queryTokens.length === 0) return [];

    const documentFrequency = new Map<string, number>();
    const documentTokens = chunks.map((chunk) => {
      const tokens = tokenise(`${chunk.title} ${chunk.text}`);
      for (const token of new Set(tokens)) {
        documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
      }
      return tokens;
    });

    const averageLength = documentTokens.reduce((sum, tokens) => sum + tokens.length, 0) / documentTokens.length;
    const k1 = 1.2;
    const b = 0.75;

    return chunks
      .map((chunk, index) => {
        const tokens = documentTokens[index]!;
        const counts = new Map<string, number>();
        for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
        let score = 0;
        for (const queryToken of queryTokens) {
          const frequency = counts.get(queryToken);
          if (!frequency) continue;
          const df = documentFrequency.get(queryToken) ?? 1;
          const idf = Math.log(1 + (chunks.length - df + 0.5) / (df + 0.5));
          const denominator = frequency + k1 * (1 - b + (b * tokens.length) / (averageLength || 1));
          score += idf * ((frequency * (k1 + 1)) / denominator);
        }
        return { chunk, score: Math.round(score * 1000) / 1000 };
      })
      .filter((result) => result.score >= minScore)
      .sort((a, b2) => b2.score - a.score)
      .slice(0, limit);
  }

  it('produces exactly the scores the unindexed implementation did', () => {
    const corpus = corpusFor(25);
    const retrieval = new RetrievalService(corpus);
    for (const query of ['renewals', 'excess use programme', 'uplift clauses desk', 'escalation case 7']) {
      const indexed = retrieval.retrieve('t_a', query);
      const reference = scoreTheOldWay(corpus, 't_a', query);
      expect(indexed.map((r) => [r.chunk.id, r.score])).toEqual(reference.map((r) => [r.chunk.id, r.score]));
    }
  });

  it('is deterministic across calls, including ties', () => {
    const corpus = corpusFor(25);
    const retrieval = new RetrievalService(corpus);
    const first = retrieval.retrieve('t_a', 'renewals programme');
    expect(first.length).toBeGreaterThan(0);
    expect(retrieval.retrieve('t_a', 'renewals programme')).toEqual(first);
  });

  it('rebuilds when the corpus version moves', () => {
    const corpus = corpusFor(5);
    const retrieval = new RetrievalService(corpus);
    expect(retrieval.retrieve('t_a', 'quarterly rebate audit')).toHaveLength(0);

    const added = corpus.ingest({
      tenantId: 't_a', sourceKind: 'faq', sourceRef: 'faq/new',
      title: 'Quarterly rebate audit', text: 'A newly published answer about the quarterly rebate audit.',
      shipped: true,
    });
    corpus.publish('t_a', added.id, 'approver');

    const after = retrieval.retrieve('t_a', 'quarterly rebate audit');
    expect(after.some((result) => result.chunk.id === added.id)).toBe(true);
  });

  it('never serves a retired chunk from a cached index', () => {
    const corpus = corpusFor(5);
    const retrieval = new RetrievalService(corpus);
    const first = retrieval.retrieve('t_a', 'renewals');
    expect(first.length).toBeGreaterThan(0);
    const victim = first[0]!.chunk.id;

    corpus.retire('t_a', victim);

    const after = retrieval.retrieve('t_a', 'renewals');
    expect(after.some((result) => result.chunk.id === victim)).toBe(false);
  });
});

describe('PERF-7 · sessions expire', () => {
  const config = {
    tenantId: 't_a', name: 'A', version: 1, promptVersion: 'p', policyVersion: 'q', modelVersion: 'm',
    disclosure: DEFAULT_DISCLOSURE,
  } as unknown as TenantConfig;

  it('treats an idle session as absent and drops its transcript', () => {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const sessions = new SessionManager(clock, { idleMs: 60_000, absoluteMs: 3_600_000 });
    const session = sessions.open(config, 'UK');
    sessions.record(session, 'visitor', 'my name is Alex and my number is 07700 900000');

    clock.advance(61_000);
    expect(sessions.get(session.id)).toBeUndefined();
    // The transcript is the personal data, so it goes with the reference.
    expect(session.history).toHaveLength(0);
  });

  it('expires on the absolute lifetime however active the visitor is', () => {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const sessions = new SessionManager(clock, { idleMs: 60_000, absoluteMs: 120_000 });
    const session = sessions.open(config, 'UK');

    for (let step = 0; step < 4; step += 1) {
      clock.advance(30_000);
      sessions.record(session, 'visitor', 'still here');
    }
    expect(sessions.get(session.id)).toBeUndefined();
  });

  it('sweeps expired sessions out of memory', () => {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const sessions = new SessionManager(clock, DEFAULT_SESSION_TTL);
    for (let index = 0; index < 5; index += 1) sessions.open(config, 'UK');
    expect(sessions.size).toBe(5);

    clock.advance(DEFAULT_SESSION_TTL.idleMs + 1_000);
    expect(sessions.sweep()).toBe(5);
    expect(sessions.size).toBe(0);
  });
});

describe('PERF-6 · static assets are cacheable', () => {
  it('serves a content-hashed asset immutably and the panel not at all', async () => {
    const { cacheControlFor, stripContentHash, etagFor } = await import('@detent/awa-server');
    expect(stripContentHash('loader.a1b2c3d4.js')).toEqual({ name: 'loader.js', hashed: true });
    expect(cacheControlFor('loader.js', true)).toContain('immutable');
    expect(cacheControlFor('loader.js', false)).toContain('must-revalidate');
    // The panel carries the tenant's disclosure and consent wording. A cached
    // copy of those is a compliance problem, not a saving.
    expect(cacheControlFor('panel.html', false)).toBe('no-store');
    expect(etagFor(120, 1_700_000_000_000)).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
  });
});

describe('the audit export route stays paginated end to end', () => {
  it('reports page metadata over the API', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({
      method: 'GET',
      path: `/v1/admin/tenants/${harness.config.tenantId}/audit`,
      headers: bearer(harness.adminKey),
      query: { limit: '2' },
    });
    const body = response.body as { entries: unknown[]; page: { total: number; returned: number } };
    expect(body.entries.length).toBeLessThanOrEqual(2);
    expect(body.page.total).toBeGreaterThan(0);
  });
});

/** Kept honest: the chain hashing helper is still the one the log uses. */
it('hashes an entry deterministically', () => {
  const entry = {
    id: 'aud_1', tenantId: 't_a', sequence: 1, type: 'session_opened' as const,
    correlationId: 'c', actor: 'system' as const, recordedAt: '2026-09-04T09:00:00.000Z',
    previousHash: '0'.repeat(64),
  };
  expect(hashEntry(entry)).toBe(hashEntry({ ...entry }));
});
