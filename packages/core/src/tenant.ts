import type { Jurisdiction } from './consent.js';
import type { ConversationOutcome } from './outcomes.js';

/**
 * Tenant configuration is data, not code (section 31). Everything a tenant can
 * change lives here, is versioned, and takes effect without a redeploy. The
 * type is the contract the admin console edits and the policy engine reads.
 */

export type TenantState =
  | 'REGISTERED'
  | 'DPA_SIGNED'
  | 'CRM_CONNECTED'
  | 'MAPPED'
  | 'TEST_MODE'
  | 'LIVE'
  | 'DEGRADED'
  | 'SUSPENDED'
  | 'OFFBOARDING';

export type Residency = 'UK' | 'EU';

export interface PriceListEntry {
  readonly sku: string;
  readonly label: string;
  /** Exactly one of `price` or `range`; a tenant cannot publish both. */
  readonly price?: { readonly amount: number; readonly currency: string; readonly unit: string };
  readonly range?: { readonly min: number; readonly max: number; readonly currency: string; readonly unit: string };
  /** Conditions attached to the price, stated verbatim whenever the price is. */
  readonly conditions: readonly string[];
  /** What moves a quote within the range. Only meaningful with `range`. */
  readonly rangeDrivers?: readonly string[];
}

export interface QualificationDimension {
  readonly key: string;
  readonly label: string;
  readonly weight: number;
  readonly required: boolean;
  /** How the value is obtained. `inferred` dimensions are never asked directly. */
  readonly capture: 'inferred' | 'asked' | 'signal';
  readonly prohibitedPhrasings?: readonly string[];
}

export interface QualificationModel {
  readonly dimensions: readonly QualificationDimension[];
  /** Weighted score at or above which a lead is QUALIFIED. */
  readonly qualifiedThreshold: number;
  readonly disqualifiedThreshold: number;
}

export interface EscalationThresholds {
  /** Model confidence below this on a factual question escalates rather than hedges. */
  readonly confidenceFloor: number;
  /** Consecutive negative-sentiment turns before a human is offered. */
  readonly negativeSentimentTurns: number;
  readonly highRiskTopics: readonly string[];
  /**
   * What the visitor is told about response time when a human is raised
   * (audit UX-7). An escalation that says only "someone will pick this up" is a
   * dead end; a promise the tenant chose is a handoff.
   */
  readonly humanResponsePromise?: string;
  /** Shown when nobody is available and the visitor is asked to leave details. */
  readonly offerLeaveDetails?: boolean;
}

export interface ObjectionPlay {
  readonly type: string;
  readonly approvedApproach: string;
  readonly boundaries: readonly string[];
}

export interface SpendCaps {
  /** Hard monthly ceiling in pence. The metering service refuses beyond it. */
  readonly monthlyPence: number;
  /** Fraction of the cap at which the tenant is warned. */
  readonly warnAtFraction: number;
  /** Fraction at which voice is disabled and the session degrades to text. */
  readonly degradeToTextAtFraction: number;
  readonly maxConcurrentVoice: number;
  readonly maxConversationsPerMonth: number;
}

export interface RetentionPolicy {
  readonly transcriptDays: number;
  readonly voiceRecordingDays: number;
  readonly leadPersonalDataDays: number;
  /** Audit is exempt from erasure on legal-obligation grounds (section 25.5). */
  readonly auditDays: number;
}

export interface RecordingPolicy {
  /** Off by default, per tenant (section 20). */
  readonly enabled: boolean;
  readonly transcriptionEnabled: boolean;
  readonly attachTranscriptToCrm: boolean;
  readonly attachAudioToCrm: boolean;
}

export interface DisclosureConfig {
  /** Article 50 text. Editable for tone; not disableable. */
  readonly text: string;
  readonly voiceText: string;
}

/**
 * Follow-up configuration (section 42).
 *
 * `liaComplete` is the gate on lane two. The legitimate-interest follow-up lane
 * is disabled until the tenant's DPO has reviewed and completed the legitimate
 * interests assessment (FR-056): not because the platform doubts the tenant,
 * but because the LIA is the thing that makes the lane lawful, and a lane that
 * is lawful only if a document exists must be gated on that document existing.
 */
export interface FollowUpConfig {
  readonly enabled: boolean;
  readonly liaComplete: boolean;
  readonly liaCompletedAt?: string;
  readonly liaCompletedBy?: string;
  /** Platform ceiling. A tenant may lower this; it cannot raise it (FR-057). */
  readonly maxFollowUpsPerConversation: number;
  readonly senderName: string;
  readonly senderAddress: string;
  readonly physicalAddress: string;
}

/** Proactive engagement rules (section 43, lawful subset only). */
export interface EngagementConfig {
  readonly enabled: boolean;
  /**
   * Company-level engagement in a non-consented session. Person-level is
   * structurally gated on consent and is not a configuration option
   * (section 43.2): the lawful version of proactive engagement is
   * company-level in any non-consented session, and the narrower product is
   * sold honestly rather than matching a claim that may not survive scrutiny.
   */
  readonly companyLevelInNonConsentedSessions: boolean;
  readonly minimumDwellSeconds: number;
  readonly minimumPagesViewed: number;
  /** A visitor who dismisses engagement is not asked again this session. */
  readonly respectInSessionDismissal: boolean;
  readonly enrichmentEnabled: boolean;
  /** Hard ceiling on enrichment spend, in pence, per month. */
  readonly enrichmentMonthlyCapPence: number;
}

/** Outcome routing destinations, per tenant (section 40). */
export interface OutcomeConfig {
  readonly enabled: readonly ConversationOutcome[];
  readonly trialProvisioning?: {
    readonly method: 'webhook' | 'magic_link' | 'redirect';
    readonly endpoint: string;
    /** Shared secret for signing the outbound payload. Never a product credential. */
    readonly signingKeyRef?: string;
  };
  readonly selfServeUrl?: string;
  readonly supportDestination?: string;
  readonly partners?: readonly { readonly id: string; readonly name: string; readonly entityRef?: string; readonly criteria: string }[];
}

/**
 * Visitor-surface branding (audit UX-10). One accent colour and a label was
 * never going to survive the first agency or multi-brand group.
 */
export interface BrandingConfig {
  readonly accentColour?: string;
  readonly launcherLabel?: string;
  /** `bottom-right` | `bottom-left`. Anything else is ignored by the launcher. */
  readonly launcherPosition?: 'bottom-right' | 'bottom-left';
  /** Absolute https URL on the tenant's own origin, or a data URI. */
  readonly avatarUrl?: string;
  readonly assistantName?: string;
  /** Font family stack applied inside the panel. */
  readonly fontFamily?: string;
  /** Shown above the composer on the first screen, per page group. */
  readonly greeting?: string;
}

/** Locale configuration for the visitor surface (audit UX-6). */
export interface LocaleConfig {
  /** BCP-47 tag used when the host page declares nothing usable. */
  readonly default: string;
  /** Locales this tenant has approved copy for. */
  readonly supported: readonly string[];
  /** Per-locale disclosure and consent wording overrides, stored verbatim. */
  readonly overrides?: Readonly<Record<string, { readonly disclosure?: string; readonly voiceDisclosure?: string; readonly consentWording?: string }>>;
}

export interface TenantConfig {
  readonly tenantId: string;
  readonly name: string;
  readonly version: number;
  readonly state: TenantState;
  readonly residency: Residency;
  readonly homeJurisdiction: Jurisdiction;
  readonly connector: string;
  readonly promptVersion: string;
  readonly policyVersion: string;
  readonly modelVersion: string;
  readonly disclosure: DisclosureConfig;
  readonly priceList: readonly PriceListEntry[];
  readonly serviceCatalogue: readonly string[];
  readonly qualification: QualificationModel;
  readonly escalation: EscalationThresholds;
  readonly objections: readonly ObjectionPlay[];
  readonly spendCaps: SpendCaps;
  readonly retention: RetentionPolicy;
  readonly recording: RecordingPolicy;
  /** Per-tenant kill switch. Degrades to text, then to a static booking link. */
  readonly killSwitch: 'OFF' | 'TEXT_ONLY' | 'BOOKING_LINK_ONLY';
  readonly bookingLinkUrl?: string;
  /** Hosts the output validator will allow a link or image to point at. */
  readonly outboundAllowlist: readonly string[];
  /** Whether create_opportunity needs a human approval, per section 13.2. */
  readonly requireApprovalForOpportunity: boolean;
  readonly dpaSignedAt?: string;
  readonly fieldMappingAcceptedAt?: string;
  /** Playbook version, pinned per conversation alongside prompt and policy. */
  readonly playbookVersion: number;
  /**
   * Dry-run mode: the first conversations write to a staging ledger rather than
   * the CRM, and the tenant accepts the diff before writes are enabled
   * (FR-036). Distinct from TEST_MODE, which is a lifecycle state.
   */
  readonly dryRun: boolean;
  readonly followUp: FollowUpConfig;
  readonly engagement: EngagementConfig;
  readonly outcomes: OutcomeConfig;
  /**
   * Web origins this tenant has registered for the widget (audit SEC-5, SEC-7).
   * Authentication rejects a widget key presented from anywhere else, and the
   * panel's `frame-ancestors` is built from exactly this list, so a competitor
   * cannot drive a tenant's assistant or frame their panel.
   */
  readonly origins: readonly string[];
  /** Linked from the consent bar, so the DPO's screen is complete (UX-8). */
  readonly privacyPolicyUrl?: string;
  readonly locales: LocaleConfig;
  readonly branding: BrandingConfig;
}

export const DEFAULT_FOLLOW_UP: FollowUpConfig = {
  enabled: false,
  liaComplete: false,
  maxFollowUpsPerConversation: 1,
  senderName: '',
  senderAddress: '',
  physicalAddress: '',
};

export const DEFAULT_ENGAGEMENT: EngagementConfig = {
  enabled: false,
  companyLevelInNonConsentedSessions: true,
  minimumDwellSeconds: 30,
  minimumPagesViewed: 2,
  respectInSessionDismissal: true,
  enrichmentEnabled: false,
  enrichmentMonthlyCapPence: 10_000,
};

export const DEFAULT_OUTCOMES: OutcomeConfig = {
  enabled: ['book_meeting', 'request_quote', 'escalate_human', 'escalate_support', 'disqualify', 'abandoned'],
};

export const DEFAULT_LOCALES: LocaleConfig = {
  default: 'en-GB',
  supported: ['en-GB', 'fr', 'de', 'es', 'nl', 'it'],
};

export const DEFAULT_BRANDING: BrandingConfig = {
  launcherPosition: 'bottom-right',
};

export const DEFAULT_DISCLOSURE: DisclosureConfig = {
  text: 'You are chatting with an AI assistant, not a person. It can answer questions and arrange a call with the team.',
  voiceText: 'Just so you know, you are speaking with an AI assistant, not a person. I can answer questions and arrange a call with the team.',
};

/** Tenant lifecycle gates (section 23.4). Both are gates, not suggestions. */
export function canConnectCrm(config: Pick<TenantConfig, 'state' | 'dpaSignedAt'>): boolean {
  return Boolean(config.dpaSignedAt) && config.state !== 'REGISTERED';
}

export function canGoLive(config: TenantConfig): boolean {
  return (
    Boolean(config.dpaSignedAt) &&
    Boolean(config.fieldMappingAcceptedAt) &&
    (config.state === 'TEST_MODE' || config.state === 'LIVE' || config.state === 'DEGRADED')
  );
}

/**
 * Whether CRM writes may reach the tenant's CRM at all. In dry-run the writes
 * are real, validated and diffable, they simply land in a staging ledger until
 * the tenant accepts the diff (FR-036).
 */
export function writesReachCrm(config: Pick<TenantConfig, 'dryRun' | 'state'>): boolean {
  return !config.dryRun && (config.state === 'LIVE' || config.state === 'DEGRADED');
}

/** Traffic-serving states. DEGRADED still serves visitors in capture-only mode. */
export function servesTraffic(state: TenantState): boolean {
  return state === 'LIVE' || state === 'DEGRADED' || state === 'TEST_MODE';
}
