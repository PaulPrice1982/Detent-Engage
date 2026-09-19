/**
 * One budget across every instance of a deployment.
 *
 * The in-memory counters count what one process has seen. On a three-instance
 * autoscale deployment that makes every published limit three times what it
 * says, and the multiplier rises with the instance count, which the platform
 * increases under exactly the load the limit exists to survive. A limit that
 * relaxes as the attack grows is not a limit.
 *
 * The Redis suite is skipped without TEST_REDIS_URL so the rest still runs on a
 * machine without one. It is not optional in spirit: the whole point of the
 * adapter is behaviour that cannot be observed in a single process, and a
 * fake that agrees with itself proves nothing about it.
 *
 *   redis-server --port 6379 &
 *   TEST_REDIS_URL=redis://localhost:6379 pnpm test:vitest
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '@detent/awa-core';
import { InMemoryCounterStore, RedisCounterStore, RequestRateLimiter } from '@detent/awa-server';

describe('the in-memory counters', () => {
  it('counts a window and forgets it when the window passes', async () => {
    const store = new InMemoryCounterStore();
    expect((await store.hit('k', 1_000, 0)).count).toBe(1);
    expect((await store.hit('k', 1_000, 10)).count).toBe(2);
    // A new window, so the count restarts while the monotonic total does not.
    expect((await store.hit('k', 1_000, 2_000)).count).toBe(1);
    expect(await store.total('k')).toBe(3);
  });
});

const url = process.env['TEST_REDIS_URL'];

if (!url) {
  describe('counters shared across instances', () => {
    it.skip('needs TEST_REDIS_URL', () => undefined);
  });
} else {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(url);
  const prefix = `test:${Date.now()}:`;

  afterAll(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
    await redis.quit();
  });

  beforeEach(async () => {
    const keys = await redis.keys(`${prefix}*`);
    if (keys.length > 0) await redis.del(...keys);
  });

  describe('counters shared across instances', () => {
    it('counts a window and expires it, without a sweep', async () => {
      const store = new RedisCounterStore(redis, { prefix });
      const first = await store.hit('k', 500, 1_000);
      expect(first.count).toBe(1);
      // The reset comes from the caller's clock plus the server's remaining
      // TTL, so the two do not have to agree about what time it is.
      expect(first.resetAt).toBeGreaterThan(1_000);
      expect(first.resetAt).toBeLessThanOrEqual(1_500);

      expect((await store.hit('k', 500, 1_010)).count).toBe(2);
      await new Promise((wake) => setTimeout(wake, 600));
      // Redis expired it. Nothing swept.
      expect((await store.hit('k', 500, 2_000)).count).toBe(1);
      // The ceiling outlives the window it was counted in, or it resets every
      // minute and stops being a ceiling.
      expect(await store.total('k')).toBe(3);
    });

    it('holds one budget across two limiters that share it', async () => {
      // The property the whole adapter exists for, asserted the only way it
      // can be: two limiters, as two instances of one deployment.
      const policy = {
        ...new RequestRateLimiter().limits,
        perKey: { limit: 3, windowMs: 60_000 },
      };
      const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
      const instanceA = new RequestRateLimiter(policy, clock, new RedisCounterStore(redis, { prefix }));
      const instanceB = new RequestRateLimiter(policy, clock, new RedisCounterStore(redis, { prefix }));

      const open = (limiter: RequestRateLimiter) =>
        limiter.checkSessionOpen({ keyId: 'ak_shared', ip: '198.51.100.7' });

      expect((await open(instanceA)).allowed).toBe(true);
      expect((await open(instanceB)).allowed).toBe(true);
      expect((await open(instanceA)).allowed).toBe(true);

      // The fourth is over the limit of three, whichever instance it lands on.
      const refused = await open(instanceB);
      expect(refused.allowed).toBe(false);
      expect(refused.scope).toBe('key');
      expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    });

    it('counts every one of two hundred concurrent hits exactly once', async () => {
      // INCR inside a script, not read-modify-write. Anything else loses hits
      // under concurrency, and undercounting a rate limiter lets a flood past.
      const store = new RedisCounterStore(redis, { prefix });
      await Promise.all(Array.from({ length: 200 }, () => store.hit('burst', 60_000, 0)));
      expect(await store.total('burst')).toBe(200);
    });

    it('forgets a session when the conversation ends', async () => {
      const store = new RedisCounterStore(redis, { prefix });
      await store.hit('s:sess_1', 60_000, 0);
      expect(await store.total('s:sess_1')).toBe(1);
      await store.forget('s:sess_1');
      expect(await store.total('s:sess_1')).toBe(0);
    });

    it('recovers a window whose expiry was lost', async () => {
      // A process that died between INCR and PEXPIRE used to leave a counter
      // with no TTL, which blocks that key for ever. The script re-applies the
      // expiry rather than trusting that the first write set it.
      const store = new RedisCounterStore(redis, { prefix });
      await store.hit('orphan', 60_000, 0);
      await redis.persist(`${prefix}w:orphan`);
      expect(await redis.pttl(`${prefix}w:orphan`)).toBe(-1);
      const after = await store.hit('orphan', 60_000, 0);
      expect(after.count).toBe(2);
      expect(await redis.pttl(`${prefix}w:orphan`)).toBeGreaterThan(0);
    });
  });
}
