import { AwaError, type Clock, systemClock } from '@detent/awa-core';

/**
 * Abuse control on the visitor API (audit SEC-2).
 *
 * There was none. No per-IP, per-key or per-session limit on `/v1/sessions` or
 * `/v1/sessions/{id}/messages`, no origin binding on a key that appears in page
 * source, and no input length cap before the tokeniser. A trivial script
 * against a public key ran a tenant past their spend cap, "denial of wallet",
 * which is the exact risk the metering module names in its own header comment.
 *
 * Three buckets, because they fail in different ways:
 *
 *   - per key: the tenant-wide ceiling. Catches a distributed flood that no
 *     single IP would trip.
 *   - per IP: catches the ordinary single-source script.
 *   - per session: catches a legitimate-looking client in a hot loop, and
 *     bounds the cost of any one conversation.
 *
 * All three are checked; the first to refuse wins, and the refusal names which
 * one it was so an operator can tell a flood from a bug.
 */
export interface RateLimitRule {
  /** Requests allowed per window. */
  readonly limit: number;
  /** Window length in milliseconds. */
  readonly windowMs: number;
}

export interface RateLimitPolicy {
  readonly perKey: RateLimitRule;
  readonly perIp: RateLimitRule;
  readonly perSession: RateLimitRule;
  /** Hard ceiling on messages in one session, whatever the rate. */
  readonly maxMessagesPerSession: number;
  /** Sessions one IP may open per window. */
  readonly sessionsPerIp: RateLimitRule;
  /** Longest visitor message accepted, in characters, before the tokeniser. */
  readonly maxInputChars: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitPolicy = {
  // A human types perhaps ten messages a minute at the very most; a tenant's
  // whole site might legitimately carry a few hundred concurrent conversations.
  perKey: { limit: 600, windowMs: 60_000 },
  perIp: { limit: 30, windowMs: 60_000 },
  perSession: { limit: 20, windowMs: 60_000 },
  maxMessagesPerSession: 120,
  sessionsPerIp: { limit: 10, windowMs: 60_000 },
  // Long enough for a pasted requirements paragraph, short enough that a
  // megabyte of text cannot be turned into tokens on the tenant's account.
  maxInputChars: 4_000,
};

interface Counter {
  count: number;
  resetAt: number;
  /** Monotonic total, for the per-session hard ceiling. */
  total: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  readonly scope?: 'key' | 'ip' | 'session' | 'session_total' | 'session_open';
  readonly retryAfterSeconds?: number;
}

/**
 * The counter store behind the limiter.
 *
 * Extracted so the limiter is not the thing that stops the service running more
 * than one replica (audit PERF-1). A Redis adapter implements `hit` as `INCR`
 * plus `EXPIRE` on first increment and `total` as a second key that outlives the
 * window; nothing else about the limiter changes, and per-replica limiting
 * becomes per-tenant limiting.
 */
export interface CounterStore {
  /** Increment `key` within a window, returning the count and when it resets. */
  hit(key: string, windowMs: number, nowMs: number): { count: number; resetAt: number };
  /** Monotonic total for `key`, ignoring windows. */
  total(key: string): number;
  /** Drop expired windowed counters. Returns how many went. */
  sweep(nowMs: number, keep: (key: string) => boolean): number;
  forget(key: string): void;
  readonly size: number;
}

export class InMemoryCounterStore implements CounterStore {
  private readonly counters = new Map<string, Counter>();

  hit(key: string, windowMs: number, nowMs: number): { count: number; resetAt: number } {
    const counter = this.counters.get(key);
    if (!counter || counter.resetAt <= nowMs) {
      const fresh = { count: 1, resetAt: nowMs + windowMs, total: (counter?.total ?? 0) + 1 };
      this.counters.set(key, fresh);
      return { count: fresh.count, resetAt: fresh.resetAt };
    }
    counter.count += 1;
    counter.total += 1;
    return { count: counter.count, resetAt: counter.resetAt };
  }

  total(key: string): number { return this.counters.get(key)?.total ?? 0; }

  sweep(nowMs: number, keep: (key: string) => boolean): number {
    let removed = 0;
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= nowMs && !keep(key)) { this.counters.delete(key); removed += 1; }
    }
    return removed;
  }

  forget(key: string): void { this.counters.delete(key); }

  get size(): number { return this.counters.size; }
}

/**
 * Fixed-window counters, swept on a timer.
 *
 * A fixed window can admit up to twice the limit across a boundary. That is
 * accepted deliberately: the purpose here is to stop a flood by three orders of
 * magnitude, not to shape traffic to the request, and a fixed window is small,
 * obvious and cheap to reason about at 3am.
 */
export class RequestRateLimiter {
  private readonly counters: CounterStore;

  constructor(
    private readonly policy: RateLimitPolicy = DEFAULT_RATE_LIMITS,
    private readonly clock: Clock = systemClock,
    counters: CounterStore = new InMemoryCounterStore(),
  ) {
    this.counters = counters;
  }

  get limits(): RateLimitPolicy { return this.policy; }

  private hit(key: string, rule: RateLimitRule): RateLimitVerdict {
    const now = this.clock.nowMs();
    const { count, resetAt } = this.counters.hit(key, rule.windowMs, now);
    if (count > rule.limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil((resetAt - now) / 1000) };
    }
    return { allowed: true };
  }

  private totalFor(key: string): number {
    return this.counters.total(key);
  }

  /** A visitor message. Checked before the model is called, never after. */
  checkMessage(input: { keyId: string; ip: string; sessionId: string }): RateLimitVerdict {
    const sessionTotal = this.totalFor(`s:${input.sessionId}`);
    if (sessionTotal >= this.policy.maxMessagesPerSession) {
      return { allowed: false, scope: 'session_total' };
    }
    const key = this.hit(`k:${input.keyId}`, this.policy.perKey);
    if (!key.allowed) return { ...key, scope: 'key' };
    const ip = this.hit(`i:${input.ip}`, this.policy.perIp);
    if (!ip.allowed) return { ...ip, scope: 'ip' };
    const session = this.hit(`s:${input.sessionId}`, this.policy.perSession);
    if (!session.allowed) return { ...session, scope: 'session' };
    return { allowed: true };
  }

  /** Opening a session is the cheaper call, and the one a bot farm repeats. */
  checkSessionOpen(input: { keyId: string; ip: string }): RateLimitVerdict {
    const key = this.hit(`k:${input.keyId}`, this.policy.perKey);
    if (!key.allowed) return { ...key, scope: 'key' };
    const ip = this.hit(`o:${input.ip}`, this.policy.sessionsPerIp);
    if (!ip.allowed) return { ...ip, scope: 'session_open' };
    return { allowed: true };
  }

  /** Drop expired counters. Called on a timer by the HTTP server. */
  sweep(): number {
    // A session's monotonic total must outlive its window, or the hard ceiling
    // resets every minute and stops being a ceiling.
    return this.counters.sweep(this.clock.nowMs(), (key) => key.startsWith('s:'));
  }

  /** Forget a session's counters once the conversation ends. */
  forgetSession(sessionId: string): void {
    this.counters.forget(`s:${sessionId}`);
  }

  get size(): number { return this.counters.size; }
}

export function rateLimitError(verdict: RateLimitVerdict): AwaError {
  return new AwaError({
    kind: 'RATE_LIMITED',
    message: `rate limit exceeded (${verdict.scope ?? 'unknown'})`,
    visitorMessage: 'That is a lot of messages at once. Give me a moment and try again.',
    details: { scope: verdict.scope, retryAfterSeconds: verdict.retryAfterSeconds },
  });
}
