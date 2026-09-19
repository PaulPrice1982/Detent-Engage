/**
 * Rate-limit counters shared by every instance of a deployment.
 *
 * The in-memory store counts what one process has seen. On a three-instance
 * autoscale deployment that makes every published limit three times what it
 * says, and the multiplier rises with the instance count, which the platform
 * increases under exactly the load the limit exists to survive. A caller who
 * shares one Redis enforces one budget.
 *
 * The client is injected rather than constructed here, against the smallest
 * interface that does the job. `ioredis` and `node-redis` both satisfy it, and
 * neither becomes a dependency of this package for the sake of a deployment
 * that may use the other or neither.
 */
import type { CounterStore } from './rate-limit.js';

/** The little of a Redis client this needs. Both major clients provide it. */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
}

/**
 * One window hit: increment, set the expiry on first write, read the reset.
 *
 * A Lua script because the alternative is INCR then EXPIRE then PTTL as three
 * round trips, and a process that dies between the first and the second leaves
 * a counter that never expires. Redis runs a script to completion without
 * interleaving another client, so the whole sequence is atomic and no caller
 * can observe a half-applied hit.
 *
 * The monotonic total is kept in a second key with no expiry of its own, since
 * a session's hard ceiling has to outlive the window it was counted in or it
 * resets every minute and stops being a ceiling.
 */
const HIT = `
local windowKey = KEYS[1]
local totalKey = KEYS[2]
local windowMs = tonumber(ARGV[1])
local totalTtlMs = tonumber(ARGV[2])

local count = redis.call('INCR', windowKey)
if count == 1 then
  redis.call('PEXPIRE', windowKey, windowMs)
end
local remaining = redis.call('PTTL', windowKey)
-- A key with no expiry yet (-1) or already gone (-2) is treated as a fresh
-- window, so a lost PEXPIRE cannot produce a counter that blocks for ever.
if remaining < 0 then
  redis.call('PEXPIRE', windowKey, windowMs)
  remaining = windowMs
end

local total = redis.call('INCR', totalKey)
redis.call('PEXPIRE', totalKey, totalTtlMs)

return {count, remaining, total}
`;

export interface RedisCounterStoreOptions {
  /** Namespace, so one Redis can serve more than one deployment. */
  readonly prefix?: string;
  /**
   * How long a monotonic total is kept. Longer than any window, because it is
   * a per-session ceiling rather than a rate, and shorter than for ever,
   * because a session that ended is not coming back.
   */
  readonly totalTtlMs?: number;
}

export class RedisCounterStore implements CounterStore {
  private readonly prefix: string;
  private readonly totalTtlMs: number;

  constructor(private readonly redis: RedisLike, options: RedisCounterStoreOptions = {}) {
    this.prefix = options.prefix ?? 'awa:rl:';
    this.totalTtlMs = options.totalTtlMs ?? 24 * 60 * 60 * 1000;
  }

  async hit(key: string, windowMs: number, nowMs: number): Promise<{ count: number; resetAt: number }> {
    const raw = await this.redis.eval(
      HIT, 2,
      `${this.prefix}w:${key}`, `${this.prefix}t:${key}`,
      windowMs, this.totalTtlMs,
    );
    const [count, remaining] = raw as [number, number, number];
    // Derived from the caller's clock plus the server's remaining TTL rather
    // than from a timestamp either side stores, so the two do not have to
    // agree about what time it is.
    return { count: Number(count), resetAt: nowMs + Number(remaining) };
  }

  async total(key: string): Promise<number> {
    const value = await this.redis.get(`${this.prefix}t:${key}`);
    return value === null ? 0 : Number(value);
  }

  /**
   * Nothing to sweep: Redis expires the keys itself.
   *
   * The in-memory store needs a sweep because a Map grows until something
   * removes from it. Scanning Redis to delete what it is already about to
   * delete would cost a full keyspace scan on a timer to achieve nothing.
   */
  async sweep(): Promise<number> {
    return 0;
  }

  async forget(key: string): Promise<void> {
    await this.redis.del(`${this.prefix}w:${key}`, `${this.prefix}t:${key}`);
  }

  /**
   * Not reported. The only caller is a gauge, and the answer would cost a
   * keyspace scan across a store shared with every other instance.
   */
  async size(): Promise<number> {
    return 0;
  }
}
