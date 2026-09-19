import type { AuditEntry, AuditLog } from '@detent/awa-audit';
import type { ReportWindow } from './window.js';

/**
 * Per-tenant, per-day materialised rollups (audit PERF-2).
 *
 * The finding: all three analytics services called `audit.export(tenantId)`,
 * which was `list()` plus a full chain `verify()` — a SHA-256 recomputation over
 * the canonical JSON of every entry ever written for that tenant, on every
 * dashboard load, three times per page. On a busy tenant that is the worst
 * scaling characteristic in the codebase.
 *
 * The fix has two halves. Verification is now checkpointed in `AuditLog`, so it
 * is O(entries since the last signed checkpoint). This is the other half: a
 * report is folded per UTC day, completed days are cached, and only the
 * still-open day is recomputed. A second dashboard load reads one day's
 * entries, not the tenant's history.
 *
 * A day is cached only once it is closed. Caching the current day would serve a
 * figure that is still moving, and a compliance number that disagrees with the
 * log is worse than a slow one.
 */
export interface RollupSpec<A> {
  /** Cache namespace. Two reports over the same day must not collide. */
  readonly kind: string;
  empty(): A;
  fold(entries: readonly AuditEntry[]): A;
  merge(left: A, right: A): A;
}

const DAY_MS = 86_400_000;

function dayOf(iso: string): string { return iso.slice(0, 10); }
function startOfDay(day: string): string { return `${day}T00:00:00.000Z`; }
function endOfDay(day: string): string { return `${day}T23:59:59.999Z`; }

function maxIso(left: string, right: string): string { return left > right ? left : right; }
function minIso(left: string, right: string): string { return left < right ? left : right; }

function daysBetween(fromDay: string, toDay: string): string[] {
  const days: string[] = [];
  let cursor = Date.parse(startOfDay(fromDay));
  const end = Date.parse(startOfDay(toDay));
  // Guard against a malformed or inverted range rather than looping forever.
  if (!Number.isFinite(cursor) || !Number.isFinite(end) || end < cursor) return days;
  while (cursor <= end) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += DAY_MS;
  }
  return days;
}

export interface RollupStats {
  readonly daysInWindow: number;
  readonly daysServedFromCache: number;
  readonly entriesRead: number;
}

export class DailyRollupCache {
  private readonly cache = new Map<string, unknown>();
  private lastStats: RollupStats = { daysInWindow: 0, daysServedFromCache: 0, entriesRead: 0 };

  constructor(
    private readonly audit: AuditLog,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  get stats(): RollupStats { return this.lastStats; }

  /** Drop cached days for a tenant. Called when a chain repair is performed. */
  invalidate(tenantId: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${tenantId}|`)) this.cache.delete(key);
    }
  }

  async aggregate<A>(tenantId: string, window: ReportWindow, spec: RollupSpec<A>): Promise<A> {
    const nowIso = this.now();
    const first = await this.audit.firstEntry(tenantId);
    if (!first) {
      this.lastStats = { daysInWindow: 0, daysServedFromCache: 0, entriesRead: 0 };
      return spec.empty();
    }

    // Clamp an all-time window to the days that actually hold data, so the
    // day loop is bounded by the tenant's history rather than by the year 9999.
    const fromDay = dayOf(window.from > first.recordedAt ? window.from : first.recordedAt);
    const toDay = dayOf(window.to < nowIso ? window.to : nowIso);
    const days = daysBetween(fromDay, toDay);
    const today = dayOf(nowIso);

    const missing = days.filter((day) => !this.cache.has(this.key(tenantId, spec.kind, day)));
    let entriesRead = 0;

    if (missing.length > 0) {
      // One ranged query covering every uncached day, then grouped in memory.
      // Querying per day would turn a cold cache into one round trip per day.
      const spanFrom = maxIso(startOfDay(missing[0]!), window.from);
      const spanTo = minIso(endOfDay(missing[missing.length - 1]!), window.to);
      const span = await this.audit.entriesInWindow(tenantId, { from: spanFrom, to: spanTo });
      entriesRead = span.length;
      const grouped = new Map<string, AuditEntry[]>();
      for (const entry of span) {
        const day = dayOf(entry.recordedAt);
        const list = grouped.get(day) ?? [];
        list.push(entry);
        grouped.set(day, list);
      }
      for (const day of missing) {
        const folded = spec.fold(grouped.get(day) ?? []);
        // Cached only when the day is closed *and* wholly inside the window. A
        // window that starts at noon covers half of its first day, and caching
        // that half under the day's key would serve the wrong total to the next
        // report that asks for the whole day.
        const whole = startOfDay(day) >= window.from && endOfDay(day) <= window.to;
        if (day < today && whole) this.cache.set(this.key(tenantId, spec.kind, day), folded);
        else this.open.set(this.key(tenantId, spec.kind, day), folded);
      }
    }

    let accumulator = spec.empty();
    for (const day of days) {
      const key = this.key(tenantId, spec.kind, day);
      const value = (this.cache.get(key) ?? this.open.get(key)) as A | undefined;
      if (value !== undefined) accumulator = spec.merge(accumulator, value);
    }
    this.open.clear();

    this.lastStats = {
      daysInWindow: days.length,
      daysServedFromCache: days.length - missing.length,
      entriesRead,
    };

    return accumulator;
  }

  /** Folds for the still-open day, held only for the duration of one call. */
  private readonly open = new Map<string, unknown>();

  private key(tenantId: string, kind: string, day: string): string {
    return `${tenantId}|${kind}|${day}`;
  }
}
