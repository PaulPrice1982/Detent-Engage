import type { TenantConfig } from '@detent/awa-core';
import type { AuditEntry, AuditLog } from '@detent/awa-audit';
import type { ComplianceScorecard, ComplianceScorecardService, ReportWindow } from '@detent/awa-analytics';
import type { SimulationScorecard } from '@detent/awa-studio';

/**
 * The Behavioural Assurance Pack (section 58.2, FR-106).
 *
 * In financial services, legal services, healthcare and the public sector, the
 * barrier to deploying a conversational agent is not capability. **It is the
 * inability to prove it will not do something prohibited.**
 *
 * This architecture can prove it, because the constraints are deterministic and
 * the audit log is replayable. The pack assembles four artefacts that only
 * exist because of that:
 *
 *   1. the deterministic boundary table (section 8.3, extended twice),
 *   2. the simulation panel results (section 39.4),
 *   3. the compliance scorecard (section 41.3),
 *   4. a sample replayed conversation, with the versions that produced it.
 *
 * No competitor can assemble that pack, because none of them has deterministic
 * boundaries to evidence. This is the lowest engineering cost per unit of
 * commercial unlock in any of the three specifications.
 */
export interface BoundaryRow {
  readonly deterministic: string;
  readonly delegatedToModel: string;
  readonly source: string;
}

/**
 * The full boundary table across all three specification versions. This is the
 * single most important control in the product expressed as a document, and it
 * is generated from one place so the sales artefact cannot drift from the code.
 */
export const DETERMINISTIC_BOUNDARIES: readonly BoundaryRow[] = [
  // v1.0, section 8.3
  { deterministic: 'Whether identity resolution may begin (the consent gate)', delegatedToModel: 'Understanding the visitor\'s intent', source: 'v1.0 §8.3' },
  { deterministic: 'Whether marketing enrolment is permitted', delegatedToModel: 'Tone, register and brand voice', source: 'v1.0 §8.3' },
  { deterministic: 'What price may be stated', delegatedToModel: 'Framing an approved price in context', source: 'v1.0 §8.3' },
  { deterministic: 'Whether any CRM data may be disclosed', delegatedToModel: 'Asking a non-disclosing disambiguation question', source: 'v1.0 §8.3' },
  { deterministic: 'Which CRM record is written to, and which fields', delegatedToModel: 'Drafting the note or summary content', source: 'v1.0 §8.3' },
  { deterministic: 'Whether an identity match is confident enough to act on', delegatedToModel: 'Explaining why a human will follow up', source: 'v1.0 §8.3' },
  { deterministic: 'Whether to escalate to a human', delegatedToModel: 'Recognising the sentiment or risk signal', source: 'v1.0 §8.3' },
  { deterministic: 'Whether a tenant is within quota', delegatedToModel: 'Objection framing within approved boundaries', source: 'v1.0 §8.3' },
  { deterministic: 'Retention, redaction and residency policy application', delegatedToModel: 'Summarisation and qualification field extraction', source: 'v1.0 §8.3' },
  // v1.1, section 48.2
  { deterministic: 'Whether a generated claim or price is approved and therefore quotable', delegatedToModel: 'Extracting a candidate claim or price from a page', source: 'v1.1 §48.2' },
  { deterministic: 'Which sending lane a message may use', delegatedToModel: 'Drafting the message content within that lane', source: 'v1.1 §48.2' },
  { deterministic: 'Whether an outcome is billable', delegatedToModel: 'Recognising which outcome the conversation reached', source: 'v1.1 §48.2' },
  { deterministic: 'Whether proactive engagement may fire, and at what identity level', delegatedToModel: 'Composing the proactive greeting', source: 'v1.1 §48.2' },
  { deterministic: 'Whether a playbook change may publish', delegatedToModel: 'Interpreting the tenant\'s natural-language authoring', source: 'v1.1 §48.2' },
  { deterministic: 'Whether enrichment may run and at what cost', delegatedToModel: 'Nothing. Enrichment is not model-mediated', source: 'v1.1 §48.2' },
  // v1.2, section 60.2
  { deterministic: 'Which conversational mode applies', delegatedToModel: 'Speaking naturally within that mode', source: 'v1.2 §60.2' },
  { deterministic: 'Whether selling is permitted in this conversation', delegatedToModel: 'Framing a service answer warmly', source: 'v1.2 §60.2' },
  { deterministic: 'What verification level has been reached', delegatedToModel: 'Asking for the verification code', source: 'v1.2 §60.2' },
  { deterministic: 'Whether entitlement information may be stated, and at what granularity', delegatedToModel: 'Explaining an in-scope answer', source: 'v1.2 §60.2' },
  { deterministic: 'Whether excess use or arrears exist', delegatedToModel: 'Nothing. The model is never told', source: 'v1.2 §60.2' },
  { deterministic: 'Which partner or entity receives the routing', delegatedToModel: 'Explaining that a specialist will follow up', source: 'v1.2 §60.2' },
  { deterministic: 'What a machine visitor may be told', delegatedToModel: 'Nothing. The machine surface is not model-mediated', source: 'v1.2 §60.2' },
];

export interface ReplayedConversation {
  readonly correlationId: string;
  /** The exact configuration that produced it, pinned per conversation. */
  readonly versions: { prompt?: string; policy?: string; model?: string; config?: number; playbook?: number };
  readonly entries: readonly {
    sequence: number; at: string; type: string; actor: string;
    payload?: Readonly<Record<string, unknown>>;
  }[];
  readonly chainVerified: boolean;
}

export interface AccessibilityStatement {
  readonly standard: 'WCAG 2.2 AA';
  readonly conformance: 'full' | 'partial' | 'not_assessed';
  readonly auditedBy?: string;
  readonly auditedAt?: string;
  readonly reportRef?: string;
  readonly knownLimitations: readonly string[];
  readonly statement: string;
}

export interface BehaviouralAssurancePack {
  readonly tenantId: string;
  readonly tenantName: string;
  readonly generatedAt: string;
  readonly window: ReportWindow;
  readonly deterministicBoundaries: readonly BoundaryRow[];
  readonly simulation?: SimulationScorecard;
  readonly compliance: ComplianceScorecard;
  readonly sampleReplay?: ReplayedConversation;
  readonly accessibility: AccessibilityStatement;
  readonly sectorPreset?: SectorPreset;
  /** Stated plainly so nobody over-reads the pack. */
  readonly caveats: readonly string[];
}

/**
 * Sector boundary presets (FR-108). A preset applies refusal boundaries and
 * **is not weakenable below the platform floor** — a regulated tenant can be
 * stricter than the platform, never looser.
 */
export interface SectorPreset {
  readonly sector: 'financial_services' | 'legal_services' | 'healthcare' | 'public_sector';
  readonly additionalRefusalTopics: readonly string[];
  readonly minimumConfidenceFloor: number;
  readonly recordingPermitted: boolean;
  readonly followUpLaneTwoPermitted: boolean;
}

export const SECTOR_PRESETS: Readonly<Record<SectorPreset['sector'], SectorPreset>> = {
  financial_services: {
    sector: 'financial_services',
    additionalRefusalTopics: ['investment advice', 'suitability', 'regulated advice', 'mortgage', 'pension', 'insurance recommendation', 'creditworthiness'],
    minimumConfidenceFloor: 0.8,
    recordingPermitted: true,
    followUpLaneTwoPermitted: false,
  },
  legal_services: {
    sector: 'legal_services',
    additionalRefusalTopics: ['legal advice', 'merits', 'limitation period', 'privilege', 'conflict check', 'litigation strategy'],
    minimumConfidenceFloor: 0.85,
    recordingPermitted: false,
    followUpLaneTwoPermitted: false,
  },
  healthcare: {
    sector: 'healthcare',
    additionalRefusalTopics: ['diagnosis', 'symptom', 'treatment', 'medication', 'clinical', 'prescription'],
    minimumConfidenceFloor: 0.9,
    recordingPermitted: false,
    followUpLaneTwoPermitted: false,
  },
  public_sector: {
    sector: 'public_sector',
    additionalRefusalTopics: ['eligibility determination', 'benefit entitlement', 'immigration status', 'safeguarding'],
    minimumConfidenceFloor: 0.8,
    recordingPermitted: true,
    followUpLaneTwoPermitted: false,
  },
};

/** Apply a preset. Only ever tightens; a looser preset value is ignored. */
export function applySectorPreset<T extends {
  escalation: { confidenceFloor: number; highRiskTopics: readonly string[] };
  recording: { enabled: boolean };
  followUp: { enabled: boolean };
}>(config: T, preset: SectorPreset): T {
  return {
    ...config,
    escalation: {
      ...config.escalation,
      confidenceFloor: Math.max(config.escalation.confidenceFloor, preset.minimumConfidenceFloor),
      highRiskTopics: [...new Set([...config.escalation.highRiskTopics, ...preset.additionalRefusalTopics])],
    },
    recording: { ...config.recording, enabled: config.recording.enabled && preset.recordingPermitted },
    followUp: { ...config.followUp, enabled: config.followUp.enabled && preset.followUpLaneTwoPermitted },
  };
}

export interface AssurancePackInput {
  readonly config: TenantConfig;
  readonly window: ReportWindow;
  readonly generatedAt: string;
  readonly simulation?: SimulationScorecard;
  readonly sampleCorrelationId?: string;
  readonly accessibility: AccessibilityStatement;
  readonly sectorPreset?: SectorPreset;
}

export class AssurancePackGenerator {
  constructor(
    private readonly audit: AuditLog,
    private readonly compliance: ComplianceScorecardService,
  ) {}

  /** Exportable in one action (FR-106). */
  async generate(input: AssurancePackInput): Promise<BehaviouralAssurancePack> {
    const compliance = await this.compliance.build(input.config.tenantId, input.window, input.generatedAt);
    const sampleReplay = input.sampleCorrelationId
      ? await this.replay(input.config.tenantId, input.sampleCorrelationId)
      : undefined;

    return {
      tenantId: input.config.tenantId,
      tenantName: input.config.name,
      generatedAt: input.generatedAt,
      window: input.window,
      deterministicBoundaries: DETERMINISTIC_BOUNDARIES,
      simulation: input.simulation,
      compliance,
      sampleReplay,
      accessibility: input.accessibility,
      sectorPreset: input.sectorPreset,
      caveats: [
        'The deterministic boundary table describes controls enforced in code, not aspirations. Each row is testable and is tested.',
        'The compliance figures are derived from the tenant hash-chained audit log, and the chain verification is included. A pack whose chain does not verify is not evidence.',
        input.simulation
          ? 'Simulation results describe behaviour against the synthetic buyer panel, not against live traffic.'
          : 'No simulation run is included in this pack. Run one before relying on it for assurance.',
        input.accessibility.conformance === 'not_assessed'
          ? 'Accessibility conformance has not been independently audited. No conformance claim should be made on the basis of this pack.'
          : 'The accessibility statement reflects the audit named in it and no wider claim.',
        'Regulatory scope and dates require confirmation against current sources before any external claim.',
      ],
    };
  }

  /**
   * Version-pinned conversation replay (FR-107). Any conversation is
   * reconstructable with the exact configuration that produced it — which is
   * what "demonstrating what the system did and why on a given date" requires
   * for a sector under audit.
   */
  async replay(tenantId: string, correlationId: string): Promise<ReplayedConversation> {
    const entries = await this.audit.replay(tenantId, correlationId);
    const verification = await this.audit.verify(tenantId);
    const versions = entries.find((entry) => entry.versions)?.versions ?? {};

    return {
      correlationId,
      versions,
      entries: entries.map((entry: AuditEntry) => ({
        sequence: entry.sequence,
        at: entry.recordedAt,
        type: entry.type,
        actor: entry.actor,
        // Already redacted when written. Included so a reviewer sees the
        // decision, not the personal data behind it.
        payload: entry.payload,
      })),
      chainVerified: verification.valid,
    };
  }
}

/**
 * The published accessibility conformance statement (FR-105).
 *
 * Deliberately refuses to assert conformance without a named auditor and a
 * date. Section 58 risk 28: no claim published without an independent audit or
 * confirmed current regulation.
 */
export function buildAccessibilityStatement(input: {
  auditedBy?: string;
  auditedAt?: string;
  reportRef?: string;
  knownLimitations?: readonly string[];
}): AccessibilityStatement {
  const audited = Boolean(input.auditedBy && input.auditedAt);
  return {
    standard: 'WCAG 2.2 AA',
    conformance: audited ? ((input.knownLimitations?.length ?? 0) > 0 ? 'partial' : 'full') : 'not_assessed',
    auditedBy: input.auditedBy,
    auditedAt: input.auditedAt,
    reportRef: input.reportRef,
    knownLimitations: input.knownLimitations ?? [],
    statement: audited
      ? `The visitor-facing surfaces were independently audited against WCAG 2.2 AA by ${input.auditedBy} on ${input.auditedAt}. ${(input.knownLimitations?.length ?? 0) > 0 ? 'Known limitations are listed and are being addressed.' : 'No AA failures were identified.'}`
      : 'The visitor-facing surfaces are built to WCAG 2.2 AA. No independent audit has been completed, so no conformance claim is made.',
  };
}
