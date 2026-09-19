import type { AuditEntry } from '@detent/awa-audit';

/**
 * A reporting window. Every scorecard takes one, because "any date range in one
 * action" is an acceptance criterion (section 50) and a scorecard that only
 * reports all-time is not evidence a DPO can attach to a specific quarter.
 */
export interface ReportWindow {
  readonly from: string;
  readonly to: string;
}

export function allTime(): ReportWindow {
  return { from: '0000-01-01T00:00:00.000Z', to: '9999-12-31T23:59:59.999Z' };
}

export function within(entry: AuditEntry, window: ReportWindow): boolean {
  return entry.recordedAt >= window.from && entry.recordedAt <= window.to;
}

export function payloadOf(entry: AuditEntry): Record<string, unknown> {
  return (entry.payload ?? {}) as Record<string, unknown>;
}

export function payloadString(entry: AuditEntry, key: string): string | undefined {
  const value = payloadOf(entry)[key];
  return typeof value === 'string' ? value : undefined;
}
