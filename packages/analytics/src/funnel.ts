import type { ConversationOutcome } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import type { MeteringService } from '@detent/awa-policy';
import type { OutcomeService, RecordedOutcome } from '@detent/awa-outcomes';
import { payloadString, type ReportWindow } from './window.js';

/**
 * The qualification funnel and the five supporting views (section 41.1, FR-049).
 *
 * Table stakes, and treated as such: this is the surface every competitor has,
 * so it is built plainly and correctly rather than elaborated. The two
 * scorecards are where the argument is.
 */
export interface FunnelView {
  readonly sessions: number;
  readonly engaged: number;
  readonly qualified: number;
  readonly outcomes: number;
  readonly heldMeetings: number;
  readonly engagementRatePct: number;
  readonly qualificationRatePct: number;
}

export interface OutcomeBreakdownRow {
  readonly outcome: ConversationOutcome;
  readonly volume: number;
  readonly ratePct: number;
  readonly billable: boolean;
  readonly confirmed: number;
  readonly awaitingConfirmation: number;
  readonly failed: number;
  /** Correlation ids, so a tenant can drill through to the conversations. */
  readonly correlationIds: readonly string[];
}

export interface CostView {
  readonly conversations: number;
  readonly spendPence: number;
  readonly costPerConversationPence: number | undefined;
  readonly costPerQualifiedLeadPence: number | undefined;
  readonly costPerBookedMeetingPence: number | undefined;
}

export interface ContentPerformanceRow {
  readonly chunkId: string;
  readonly retrievals: number;
  readonly escalationsAfterRetrieval: number;
}

export interface DeflectionView {
  readonly resolvedWithoutHuman: number;
  readonly escalatedToHuman: number;
  readonly deflectionRatePct: number;
  /** Implied human hours saved, at the tenant's stated handling time. */
  readonly impliedHoursSaved: number;
}

export interface AttributionRow {
  readonly source: string;
  readonly campaign?: string;
  readonly landingPage?: string;
  readonly outcomes: number;
  readonly billableOutcomes: number;
}

export interface CoverageView {
  /** Hours in which the assistant carried conversations, by hour of day (UTC). */
  readonly byHourUtc: readonly { hour: number; sessions: number }[];
  readonly outsideBusinessHoursSessions: number;
  readonly businessHoursUtc: { from: number; to: number };
}

export interface FunnelReport {
  readonly tenantId: string;
  readonly window: ReportWindow;
  readonly generatedAt: string;
  readonly funnel: FunnelView;
  readonly outcomeBreakdown: readonly OutcomeBreakdownRow[];
  readonly cost: CostView;
  readonly contentPerformance: readonly ContentPerformanceRow[];
  readonly deflection: DeflectionView;
  readonly attribution: readonly AttributionRow[];
  readonly coverage: CoverageView;
}

export interface FunnelOptions {
  /** Minutes a human would spend on a conversation, for the deflection view. */
  readonly averageHumanHandlingMinutes?: number;
  readonly businessHoursUtc?: { from: number; to: number };
}

export class FunnelService {
  constructor(
    private readonly audit: AuditLog,
    private readonly metering: MeteringService,
    private readonly outcomes: OutcomeService,
  ) {}

  async build(tenantId: string, window: ReportWindow, generatedAt: string, options: FunnelOptions = {}): Promise<FunnelReport> {
    // Ranged query rather than a full export (audit PERF-2). `export()` was
    // `list()` plus a full chain verification, a SHA-256 pass over every entry
    // ever written, and the funnel needs neither the entries outside the
    // window nor the chain recomputed.
    //
    // The funnel is not folded per day the way the compliance scorecard is,
    // because several of its figures couple across days: a session opened on
    // Monday and escalated on Tuesday belongs to one conversation, and a
    // day-additive rollup would count it as two. The window query is what makes
    // it cheap; day rollups are reserved for the additive report.
    const entries = await this.audit.entriesInWindow(tenantId, window);
    const recorded = (await this.outcomes.list(tenantId)).filter(
      (outcome) => outcome.recordedAt >= window.from && outcome.recordedAt <= window.to,
    );

    const sessions = entries.filter((entry) => entry.type === 'session_opened').length;
    // "Engaged" means the visitor said something that reached the model, which
    // is the first turn producing a tool call or a policy decision.
    const engaged = new Set(
      entries.filter((entry) => entry.type === 'tool_call_requested' || entry.type === 'policy_allowed')
        .map((entry) => entry.sessionId)
        .filter((id): id is string => Boolean(id)),
    ).size;

    const qualified = recorded.filter((outcome) => outcome.billable).length;
    const heldMeetings = recorded.filter((outcome) => outcome.outcome === 'book_meeting' && outcome.state === 'CONFIRMED').length;
    const escalations = entries.filter((entry) => entry.type === 'escalated_to_human').length;

    const usage = await this.metering.usage(tenantId);
    const costPerConversation = await this.metering.costPerConversationPence(tenantId);
    const handlingMinutes = options.averageHumanHandlingMinutes ?? 12;
    const businessHours = options.businessHoursUtc ?? { from: 8, to: 18 };

    const resolvedWithoutHuman = Math.max(0, sessions - escalations);

    return {
      tenantId,
      window,
      generatedAt,
      funnel: {
        sessions,
        engaged,
        qualified,
        outcomes: recorded.length,
        heldMeetings,
        engagementRatePct: pct(engaged, sessions),
        qualificationRatePct: pct(qualified, engaged),
      },
      outcomeBreakdown: breakdown(recorded),
      cost: {
        conversations: usage.conversations,
        spendPence: usage.spendPence,
        costPerConversationPence: costPerConversation,
        costPerQualifiedLeadPence: qualified === 0 ? undefined : round(usage.spendPence / qualified),
        costPerBookedMeetingPence: heldMeetings === 0 ? undefined : round(usage.spendPence / heldMeetings),
      },
      contentPerformance: contentPerformance(entries),
      deflection: {
        resolvedWithoutHuman,
        escalatedToHuman: escalations,
        deflectionRatePct: pct(resolvedWithoutHuman, sessions),
        impliedHoursSaved: round((resolvedWithoutHuman * handlingMinutes) / 60),
      },
      attribution: attribution(recorded),
      coverage: coverage(entries, businessHours),
    };
  }
}

function breakdown(recorded: readonly RecordedOutcome[]): OutcomeBreakdownRow[] {
  const groups = new Map<ConversationOutcome, RecordedOutcome[]>();
  for (const outcome of recorded) {
    const list = groups.get(outcome.outcome) ?? [];
    list.push(outcome);
    groups.set(outcome.outcome, list);
  }
  return [...groups.entries()]
    .map(([outcome, list]) => ({
      outcome,
      volume: list.length,
      ratePct: pct(list.length, recorded.length),
      billable: list[0]!.billable,
      confirmed: list.filter((o) => o.state === 'CONFIRMED').length,
      awaitingConfirmation: list.filter((o) => o.state === 'AWAITING_CONFIRMATION').length,
      failed: list.filter((o) => o.state === 'FAILED').length,
      correlationIds: list.map((o) => o.correlationId),
    }))
    .sort((a, b) => b.volume - a.volume);
}

function contentPerformance(entries: readonly { type: string; sessionId?: string; payload?: Readonly<Record<string, unknown>> }[]): ContentPerformanceRow[] {
  const retrievals = new Map<string, number>();
  const escalatedSessions = new Set(
    entries.filter((entry) => entry.type === 'escalated_to_human').map((entry) => entry.sessionId),
  );
  const escalationsAfter = new Map<string, number>();

  for (const entry of entries) {
    if (entry.type !== 'tool_call_executed') continue;
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    if (payload['tool'] !== 'knowledge_lookup') continue;
    const chunkIds = Array.isArray(payload['chunkIds']) ? (payload['chunkIds'] as string[]) : [];
    for (const chunkId of chunkIds) {
      retrievals.set(chunkId, (retrievals.get(chunkId) ?? 0) + 1);
      if (escalatedSessions.has(entry.sessionId)) {
        escalationsAfter.set(chunkId, (escalationsAfter.get(chunkId) ?? 0) + 1);
      }
    }
  }

  return [...retrievals.entries()]
    .map(([chunkId, count]) => ({
      chunkId,
      retrievals: count,
      escalationsAfterRetrieval: escalationsAfter.get(chunkId) ?? 0,
    }))
    .sort((a, b) => b.retrievals - a.retrievals);
}

function attribution(recorded: readonly RecordedOutcome[]): AttributionRow[] {
  const groups = new Map<string, AttributionRow>();
  for (const outcome of recorded) {
    const source = outcome.attribution?.source ?? 'direct';
    const key = `${source}|${outcome.attribution?.campaign ?? ''}|${outcome.attribution?.landingPage ?? ''}`;
    const existing = groups.get(key) ?? {
      source,
      campaign: outcome.attribution?.campaign,
      landingPage: outcome.attribution?.landingPage,
      outcomes: 0,
      billableOutcomes: 0,
    };
    groups.set(key, {
      ...existing,
      outcomes: existing.outcomes + 1,
      billableOutcomes: existing.billableOutcomes + (outcome.billable && outcome.state === 'CONFIRMED' ? 1 : 0),
    });
  }
  return [...groups.values()].sort((a, b) => b.outcomes - a.outcomes);
}

function coverage(
  entries: readonly { type: string; recordedAt: string }[],
  businessHours: { from: number; to: number },
): CoverageView {
  const byHour = new Map<number, number>();
  let outside = 0;
  for (const entry of entries) {
    if (entry.type !== 'session_opened') continue;
    const hour = new Date(entry.recordedAt).getUTCHours();
    byHour.set(hour, (byHour.get(hour) ?? 0) + 1);
    if (hour < businessHours.from || hour >= businessHours.to) outside++;
  }
  return {
    byHourUtc: [...byHour.entries()].map(([hour, sessions]) => ({ hour, sessions })).sort((a, b) => a.hour - b.hour),
    outsideBusinessHoursSessions: outside,
    businessHoursUtc: businessHours,
  };
}

const pct = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 10);
const round = (value: number): number => Math.round(value * 100) / 100;

export { payloadString };
