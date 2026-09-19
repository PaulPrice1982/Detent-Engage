import type { AuditEntry, AuditLog } from '@detent/awa-audit';
import { payloadOf, payloadString, type ReportWindow } from './window.js';
import { DailyRollupCache, type RollupSpec } from './rollup.js';

/**
 * The compliance scorecard (section 41.3, FR-051).
 *
 * The extension's own verdict: this is the single highest-leverage item in the
 * programme. It takes a compliance architecture the buyer cannot see and turns
 * it into a report the buyer can take to their own board. It is also the
 * surface most likely to survive competitive copying, **because a competitor
 * cannot report on gates it does not have.**
 *
 * Every figure here is derived from the hash-chained audit log rather than from
 * a separate counter. That matters: a counter can drift or be reset, whereas a
 * number derived from a chain that verifies is a number the tenant can defend.
 * The export therefore carries the chain verification alongside the figures.
 */
export interface ConsentBreakdown {
  readonly purpose: string;
  readonly jurisdiction: string;
  readonly granted: number;
  readonly refused: number;
  readonly withdrawn: number;
}

export interface ComplianceScorecard {
  readonly tenantId: string;
  readonly window: ReportWindow;
  readonly generatedAt: string;

  /** Consent events captured, by purpose, jurisdiction and outcome. */
  readonly consentEvents: readonly ConsentBreakdown[];

  /** Demonstrates the PECR gate is operating, not merely specified. */
  readonly identityResolutionsBlockedForConsent: number;
  readonly identityResolutionsPerformed: number;

  /** Demonstrates the structural enforcement in section 25.3. */
  readonly marketingEnrolmentsBlocked: number;

  /** Every occasion the assistant declined to reveal CRM data. */
  readonly crmDisclosureDenials: number;

  /** Article 50. Target 100%. */
  readonly sessionsOpened: number;
  readonly sessionsWithDisclosure: number;
  readonly aiDisclosureCoveragePct: number;

  readonly recordingConsent: {
    readonly granted: number;
    readonly refused: number;
    readonly notOffered: number;
  };

  readonly erasureRequests: { readonly received: number; readonly completed: number };

  /** Security posture, made visible to the buyer. */
  readonly injectionAttemptsRefused: number;
  readonly crossTenantDenials: number;
  readonly outputsBlocked: number;

  /** Risk 14: a tenant who approved without reading is visible, not invisible. */
  readonly generatedContentApprovalCoveragePct: number | undefined;

  /** The chain the figures were derived from, and whether it verifies. */
  readonly evidence: {
    readonly auditEntriesExamined: number;
    readonly chainVerified: boolean;
    readonly brokenAtSequence?: number;
  };
}

/**
 * The per-day fold (audit PERF-2). Every figure on the scorecard is additive
 * across days, which is what makes a daily rollup sound here: a month is the
 * sum of its days, and a cached day never needs recomputing.
 */
interface ComplianceFold {
  readonly typeCounts: Record<string, number>;
  readonly consent: Record<string, ConsentBreakdown>;
  readonly crmDisclosureDenials: number;
  readonly recordingGranted: number;
  readonly recordingRefused: number;
  readonly approvalCoverages: number[];
  readonly entriesExamined: number;
}

const COMPLIANCE_ROLLUP: RollupSpec<ComplianceFold> = {
  kind: 'compliance',
  empty: () => ({
    typeCounts: {}, consent: {}, crmDisclosureDenials: 0,
    recordingGranted: 0, recordingRefused: 0, approvalCoverages: [], entriesExamined: 0,
  }),
  fold(entries: readonly AuditEntry[]): ComplianceFold {
    const typeCounts: Record<string, number> = {};
    const consent: Record<string, ConsentBreakdown> = {};
    let crmDisclosureDenials = 0;
    let recordingGranted = 0;
    let recordingRefused = 0;
    const approvalCoverages: number[] = [];

    for (const entry of entries) {
      typeCounts[entry.type] = (typeCounts[entry.type] ?? 0) + 1;
      const payload = payloadOf(entry);

      if (entry.type === 'consent_recorded' || entry.type === 'consent_withdrawn') {
        const purpose = payloadString(entry, 'purpose') ?? 'UNKNOWN';
        const jurisdiction = payloadString(entry, 'jurisdiction') ?? 'UNKNOWN';
        const key = `${purpose}:${jurisdiction}`;
        const existing = consent[key] ?? { purpose, jurisdiction, granted: 0, refused: 0, withdrawn: 0 };
        const choice = String(payload['choice'] ?? '');
        consent[key] = {
          ...existing,
          granted: existing.granted + (choice === 'GRANTED' ? 1 : 0),
          refused: existing.refused + (choice === 'REFUSED' ? 1 : 0),
          withdrawn: existing.withdrawn + (choice === 'WITHDRAWN' ? 1 : 0),
        };
        if (entry.type === 'consent_recorded' && purpose === 'RECORDING') {
          if (choice === 'GRANTED') recordingGranted += 1;
          if (choice === 'REFUSED') recordingRefused += 1;
        }
      }

      if (entry.type === 'output_blocked'
        && JSON.stringify(payload['violations'] ?? []).includes('crm_disclosure')) {
        crmDisclosureDenials += 1;
      }

      if (payloadString(entry, 'change') === 'generated_section_approved') {
        const coverage = payload['approvalCoverage'];
        if (typeof coverage === 'number') approvalCoverages.push(coverage);
      }
    }

    return {
      typeCounts, consent, crmDisclosureDenials,
      recordingGranted, recordingRefused, approvalCoverages,
      entriesExamined: entries.length,
    };
  },
  merge(left: ComplianceFold, right: ComplianceFold): ComplianceFold {
    const typeCounts = { ...left.typeCounts };
    for (const [type, count] of Object.entries(right.typeCounts)) {
      typeCounts[type] = (typeCounts[type] ?? 0) + count;
    }
    const consent = { ...left.consent };
    for (const [key, row] of Object.entries(right.consent)) {
      const existing = consent[key];
      consent[key] = existing
        ? {
            purpose: row.purpose, jurisdiction: row.jurisdiction,
            granted: existing.granted + row.granted,
            refused: existing.refused + row.refused,
            withdrawn: existing.withdrawn + row.withdrawn,
          }
        : row;
    }
    return {
      typeCounts, consent,
      crmDisclosureDenials: left.crmDisclosureDenials + right.crmDisclosureDenials,
      recordingGranted: left.recordingGranted + right.recordingGranted,
      recordingRefused: left.recordingRefused + right.recordingRefused,
      approvalCoverages: [...left.approvalCoverages, ...right.approvalCoverages],
      entriesExamined: left.entriesExamined + right.entriesExamined,
    };
  },
};

export class ComplianceScorecardService {
  private readonly rollups: DailyRollupCache;

  constructor(private readonly audit: AuditLog, rollups?: DailyRollupCache) {
    this.rollups = rollups ?? new DailyRollupCache(audit);
  }

  async build(tenantId: string, window: ReportWindow, generatedAt: string): Promise<ComplianceScorecard> {
    const folded = await this.rollups.aggregate(tenantId, window, COMPLIANCE_ROLLUP);
    // Verification is checkpointed, so this is O(entries since the last signed
    // checkpoint) rather than a walk over the tenant's entire history.
    const verification = await this.audit.verify(tenantId);

    const count = (type: string): number => folded.typeCounts[type] ?? 0;
    const sessionsOpened = count('session_opened');
    const sessionsWithDisclosure = count('disclosure_shown');
    const coverages = folded.approvalCoverages;

    return {
      tenantId,
      window,
      generatedAt,
      consentEvents: Object.values(folded.consent).sort((a, b) => a.purpose.localeCompare(b.purpose)),
      identityResolutionsBlockedForConsent: count('resolution_blocked_no_consent'),
      identityResolutionsPerformed: count('resolution_complete'),
      marketingEnrolmentsBlocked: count('enrolment_blocked_no_consent'),
      crmDisclosureDenials: folded.crmDisclosureDenials,
      sessionsOpened,
      sessionsWithDisclosure,
      aiDisclosureCoveragePct: sessionsOpened === 0 ? 100 : round((sessionsWithDisclosure / sessionsOpened) * 100),
      recordingConsent: {
        granted: folded.recordingGranted,
        refused: folded.recordingRefused,
        notOffered: count('recording_blocked_no_consent'),
      },
      erasureRequests: {
        received: count('consent_withdrawn'),
        completed: count('erasure_executed'),
      },
      injectionAttemptsRefused: count('injection_detected'),
      crossTenantDenials: count('cross_tenant_denied'),
      outputsBlocked: count('output_blocked'),
      generatedContentApprovalCoveragePct:
        coverages.length === 0 ? undefined : round((coverages.reduce((a, b) => a + b, 0) / coverages.length) * 100),
      evidence: {
        auditEntriesExamined: folded.entriesExamined,
        chainVerified: verification.valid,
        brokenAtSequence: verification.brokenAtSequence,
      },
    };
  }

  /**
   * Machine-readable export over any date range, in one action (FR-051).
   *
   * The chain verification travels with the figures deliberately. A scorecard
   * whose underlying log does not verify is not evidence, and shipping it
   * without saying so would be the worst kind of compliance theatre.
   */
  async export(tenantId: string, window: ReportWindow, generatedAt: string): Promise<string> {
    const scorecard = await this.build(tenantId, window, generatedAt);
    return JSON.stringify(scorecard, null, 2);
  }
}

const round = (value: number): number => Math.round(value * 10) / 10;
