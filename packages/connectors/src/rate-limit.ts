import { type Clock, systemClock } from '@detent/awa-core';

/**
 * Per-tenant token bucket, sized below the CRM's published limit (section 16.5).
 *
 * Per tenant rather than per connector: one tenant must not be able to exhaust
 * another tenant's CRM quota, and most CRM limits are enforced per portal or
 * per org, not per application.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly clock: Clock = systemClock,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = clock.nowMs();
  }

  private refill(): void {
    const now = this.clock.nowMs();
    const elapsedSeconds = (now - this.lastRefillMs) / 1000;
    if (elapsedSeconds <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
    this.lastRefillMs = now;
  }

  tryTake(count = 1): boolean {
    this.refill();
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }

  /** Milliseconds until `count` tokens would be available. */
  waitMs(count = 1): number {
    this.refill();
    if (this.tokens >= count) return 0;
    return Math.ceil(((count - this.tokens) / this.refillPerSecond) * 1000);
  }
}

export class RateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();

  constructor(private readonly clock: Clock = systemClock) {}

  private key(tenantId: string, connector: string, channel: string): string {
    return `${tenantId}:${connector}:${channel}`;
  }

  configure(tenantId: string, connector: string, channel: string, perSecond: number): void {
    const key = this.key(tenantId, connector, channel);
    if (!this.buckets.has(key)) {
      // Burst capacity of one second's worth. Larger bursts look fine locally
      // and trip the vendor's own limiter under concurrency.
      this.buckets.set(key, new TokenBucket(Math.max(1, perSecond), perSecond, this.clock));
    }
  }

  tryAcquire(tenantId: string, connector: string, channel: string): boolean {
    return this.buckets.get(this.key(tenantId, connector, channel))?.tryTake() ?? true;
  }

  waitMs(tenantId: string, connector: string, channel: string): number {
    return this.buckets.get(this.key(tenantId, connector, channel))?.waitMs() ?? 0;
  }
}

/** Exponential backoff with full jitter, capped. Jitter matters: synchronised
 *  retries across tenants after a shared outage are a self-inflicted flood. */
export function backoffMs(attempt: number, baseMs = 250, capMs = 30_000, random: () => number = Math.random): number {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * exponential);
}

export function parseRetryAfter(header: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}
