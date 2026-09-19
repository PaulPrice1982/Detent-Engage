import type { Credential } from '@detent/awa-connectors';

/**
 * The non-CRM system contract (section 54).
 *
 * The central claim of v1.2: the CRM is the worst-informed system in the stack
 * about an existing customer. It knows a stage, an owner and some activity. It
 * does not know whether they have paid, whether they are angry, what they are
 * entitled to, or whether their usage is growing.
 *
 * This contract is deliberately shaped like the CRM connector contract in
 * section 16.6, because the whole argument for this being tractable is that it
 * runs on a proven framework: each new category is a set of connectors, not an
 * architecture.
 */
export type SystemCategory =
  | 'billing'
  | 'support'
  | 'clm'
  | 'warehouse'
  | 'cpq'
  | 'erp'
  | 'marketing_automation'
  | 'professional_services'
  | 'esignature';

/**
 * The read-only rule (section 54.3).
 *
 * Every integration is read-only by default, with exactly three exceptions
 * requiring explicit per-tenant enablement. The reason is blast radius: section
 * 24.2 identifies the credential store as the highest-value target in the
 * product, and adding nine system categories multiplies that risk. Read-only
 * scopes reduce it by roughly an order of magnitude, and a buyer will grant
 * read access to billing far faster than write.
 */
export type WriteCapability = 'create_support_ticket' | 'create_clm_task' | 'create_quote_request';

export const PERMITTED_WRITE_CAPABILITIES: readonly WriteCapability[] = [
  'create_support_ticket',
  'create_clm_task',
  'create_quote_request',
];

export interface SystemCapabilityDeclaration {
  readonly system: string;
  readonly category: SystemCategory;
  readonly readOnly: true;
  /**
   * Writes this connector *could* perform if a tenant explicitly enables them.
   * An empty array is the honest default and the common case.
   */
  readonly optionalWrites: readonly WriteCapability[];
  readonly rateLimit: { readonly requestsPerSecond: number };
  readonly degradationNotes: readonly string[];
}

// --- what each category returns -------------------------------------------

export type Standing = 'GOOD' | 'AT_RISK' | 'IN_ARREARS' | 'IN_DISPUTE' | 'UNKNOWN';
export type Sentiment = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' | 'UNKNOWN';
export type Trend = 'UP' | 'FLAT' | 'DOWN' | 'UNKNOWN';

export interface BillingFacts {
  readonly isCustomer: boolean;
  readonly planName?: string;
  readonly paymentStatus: 'current' | 'overdue' | 'failed' | 'unknown';
  readonly agedDebtDays?: number;
  readonly renewalDate?: string;
  readonly usageAgainstPlanPct?: number;
  readonly currency?: string;
}

export interface SupportFacts {
  readonly openTicketCount: number;
  readonly highestSeverity?: 1 | 2 | 3 | 4;
  readonly sentiment: Sentiment;
  readonly recentEscalations: number;
  readonly lastContactAt?: string;
}

export interface ContractedItem {
  readonly category: string;
  readonly label: string;
  readonly clauseRef?: string;
  readonly limit?: number;
  readonly unit?: string;
}

export interface ClmFacts {
  readonly hasExecutedAgreement: boolean;
  readonly agreementRef?: string;
  readonly counterpartyEmailDomain?: string;
  readonly inScope: readonly ContractedItem[];
  readonly outOfScope: readonly string[];
  readonly expiresAt?: string;
  readonly autoRenew?: boolean;
  readonly noticeByDate?: string;
  readonly excessUseTerms?: { readonly metric: string; readonly limit: number; readonly rate?: number };
  /** Clause text, keyed by reference. Only ever read at verification level 3. */
  readonly clauses?: Readonly<Record<string, string>>;
}

export interface UsageFacts {
  readonly trend: Trend;
  readonly seatUtilisationPct?: number;
  readonly featureAdoptionPct?: number;
  readonly consumedAgainstLimit?: { readonly metric: string; readonly consumed: number; readonly limit: number };
}

export interface EsignatureFacts {
  readonly ndaInPlace: boolean;
  readonly msaInPlace: boolean;
  readonly signedWithEntityRef?: string;
}

export interface MarketingConsentFacts {
  /** Authoritative consent state, so a second consent record is never created. */
  readonly marketingConsentGranted: boolean;
  readonly consentEventRef?: string;
  readonly source: string;
}

export interface SystemLookup {
  readonly email: string;
  readonly domain?: string;
  readonly crmAccountExternalId?: string;
}

/**
 * One connector per system. Every method is a read. The three permitted writes
 * live on a separate optional interface so that a connector without them cannot
 * accidentally acquire one.
 */
export interface SystemConnector {
  readonly name: string;
  readonly category: SystemCategory;
  capabilities(): SystemCapabilityDeclaration;
}

export interface BillingConnector extends SystemConnector {
  readonly category: 'billing';
  readBilling(credential: Credential, lookup: SystemLookup): Promise<BillingFacts | undefined>;
}

export interface SupportConnector extends SystemConnector {
  readonly category: 'support';
  readSupport(credential: Credential, lookup: SystemLookup): Promise<SupportFacts | undefined>;
  /** The one permitted write, and only when the tenant has enabled it. */
  createTicket?(credential: Credential, input: { subject: string; body: string; email: string }): Promise<{ id: string }>;
}

export interface ClmConnector extends SystemConnector {
  readonly category: 'clm';
  readContract(credential: Credential, lookup: SystemLookup): Promise<ClmFacts | undefined>;
  createTask?(credential: Credential, input: { subject: string; body: string; agreementRef?: string }): Promise<{ id: string }>;
}

export interface WarehouseConnector extends SystemConnector {
  readonly category: 'warehouse';
  readUsage(credential: Credential, lookup: SystemLookup): Promise<UsageFacts | undefined>;
}

export interface EsignatureConnector extends SystemConnector {
  readonly category: 'esignature';
  readAgreements(credential: Credential, lookup: SystemLookup): Promise<EsignatureFacts | undefined>;
}

export interface MarketingAutomationConnector extends SystemConnector {
  readonly category: 'marketing_automation';
  readConsent(credential: Credential, lookup: SystemLookup): Promise<MarketingConsentFacts | undefined>;
}

export type AnySystemConnector =
  | BillingConnector | SupportConnector | ClmConnector
  | WarehouseConnector | EsignatureConnector | MarketingAutomationConnector;

/**
 * Assert that a connector holds no write scope the tenant has not enabled
 * (FR-083). Called at registration, so a connector that shipped with an
 * unexpected write cannot reach a tenant at all.
 */
export function assertReadOnlyUnlessEnabled(
  connector: AnySystemConnector,
  enabledWrites: readonly WriteCapability[],
): void {
  const declared = connector.capabilities().optionalWrites;
  const unexpected = declared.filter((write) => !PERMITTED_WRITE_CAPABILITIES.includes(write));
  if (unexpected.length > 0) {
    throw new Error(
      `connector ${connector.name} declares write capabilities outside the three permitted exceptions: ${unexpected.join(', ')}`,
    );
  }
  const notEnabled = declared.filter((write) => !enabledWrites.includes(write));
  if (notEnabled.length > 0 && declared.length > 0) {
    // Declaring a write is fine; holding one the tenant has not enabled is not.
    // The connector framework refuses to hand it a credential with that scope.
    throw new Error(
      `connector ${connector.name} declares ${notEnabled.join(', ')} which this tenant has not enabled`,
    );
  }
}
