import {
  approvedValues, draft, stateOf,
  type Approvable, type ApprovalState, type CanonicalOwner, type CanonicalPipeline,
  type ObjectionPlay, type PriceListEntry, type QualificationModel,
} from '@detent/awa-core';
import type { CapabilityDeclaration } from '@detent/awa-connectors';
import type { ExtractedClaim, ExtractedPrice, ExtractedService, ExtractionResult } from './extraction.js';
import type { CrawlResult } from './crawler.js';

/**
 * The four generators (section 38.2).
 *
 * The mapping generator is the one no competitor has, because no competitor
 * integrates deeply enough to need one. Reading the tenant's live CRM schema
 * and proposing a mapping turns the v1.0 specification's heaviest onboarding
 * step into its fastest, and it is only possible because of the connector
 * contract already specified in section 16.6.
 */

// --------------------------------------------------------------------------
// 1. Knowledge generator
// --------------------------------------------------------------------------

export interface GeneratedKnowledgeItem {
  readonly title: string;
  readonly text: string;
  readonly sourceUrl: string;
}

export interface GeneratedKnowledge {
  readonly items: readonly Approvable<GeneratedKnowledgeItem>[];
  readonly pagesCrawled: number;
  readonly pagesSkipped: number;
}

export function generateKnowledge(crawl: CrawlResult, now: () => string): GeneratedKnowledge {
  const items = crawl.pages.map((page) =>
    draft<GeneratedKnowledgeItem>(
      { title: page.title, text: page.text.replace(/\s+/g, ' ').trim(), sourceUrl: page.url },
      {
        sourceUrl: page.url,
        // Longer pages carry more extractable substance; a 100-word page is
        // usually navigation. Length is a weak proxy and is scored as one.
        confidence: Math.min(0.95, 0.55 + Math.min(0.4, page.text.length / 8000)),
        extractedAt: now(),
      },
    ),
  );
  return { items, pagesCrawled: crawl.pages.length, pagesSkipped: crawl.skipped.length };
}

// --------------------------------------------------------------------------
// 2. Playbook generator
// --------------------------------------------------------------------------

export interface GeneratedPlaybook {
  readonly version: number;
  readonly generatedFrom: readonly string[];
  readonly approvalState: ApprovalState;
  readonly serviceCatalogue: readonly Approvable<ExtractedService>[];
  readonly approvedClaims: readonly Approvable<ExtractedClaim>[];
  readonly priceList: readonly Approvable<ExtractedPrice>[];
  readonly qualificationCriteria: QualificationModel;
  readonly routingOutcomes: readonly string[];
  readonly objectionResponses: readonly ObjectionPlay[];
}

/**
 * Build a draft playbook. Note what this function does not do: it never returns
 * anything with `approved: true`. A generated price the tenant has not read
 * cannot be quoted, which is how the section 13.4 price authority rule survives
 * an onboarding path that generates prices automatically (NFR-021).
 */
export function generatePlaybook(input: {
  extraction: ExtractionResult;
  qualification: QualificationModel;
  objections: readonly ObjectionPlay[];
  sourceUrls: readonly string[];
}): GeneratedPlaybook {
  const all = [...input.extraction.services, ...input.extraction.prices, ...input.extraction.claims];
  return {
    version: 1,
    generatedFrom: input.sourceUrls,
    approvalState: stateOf(all),
    serviceCatalogue: input.extraction.services,
    approvedClaims: input.extraction.claims,
    priceList: input.extraction.prices,
    // Criteria are seeded from the platform default rather than invented from a
    // website: a qualification model guessed from marketing copy is worse than
    // a sensible default the tenant then edits in Agent Studio.
    qualificationCriteria: input.qualification,
    routingOutcomes: ['book_meeting', 'start_trial', 'route_self_serve', 'escalate_human', 'disqualify'],
    objectionResponses: input.objections,
  };
}

/** Project an approved playbook into the tenant configuration shape. */
export function toPriceList(playbook: GeneratedPlaybook): PriceListEntry[] {
  return approvedValues(playbook.priceList).map((price) => ({
    sku: price.sku,
    label: price.label,
    ...(price.amount !== undefined
      ? { price: { amount: price.amount, currency: price.currency, unit: price.unit } }
      : {}),
    ...(price.rangeMin !== undefined && price.rangeMax !== undefined
      ? { range: { min: price.rangeMin, max: price.rangeMax, currency: price.currency, unit: price.unit } }
      : {}),
    conditions: [...price.conditions],
  }));
}

export function toServiceCatalogue(playbook: GeneratedPlaybook): string[] {
  return approvedValues(playbook.serviceCatalogue).map((service) => service.id);
}

// --------------------------------------------------------------------------
// 3. Mapping generator
// --------------------------------------------------------------------------

export interface CrmField {
  readonly apiName: string;
  readonly label: string;
  readonly type: 'string' | 'email' | 'phone' | 'picklist' | 'number' | 'boolean' | 'reference' | 'datetime';
  readonly custom: boolean;
  readonly picklistValues?: readonly string[];
  readonly required?: boolean;
}

export interface CrmSchema {
  readonly objectName: string;
  readonly fields: readonly CrmField[];
}

export interface FieldMapping {
  readonly canonicalField: string;
  readonly crmObject: string;
  readonly crmField: string;
  readonly confidence: number;
  /** Who wins when both sides hold a value. CRM-authoritative fields are fixed. */
  readonly sourceOfTruth: 'assistant' | 'crm';
  readonly picklistAlignment?: Readonly<Record<string, string>>;
}

export interface GeneratedMapping {
  readonly mappings: readonly Approvable<FieldMapping>[];
  readonly unmapped: readonly string[];
  /** Standard-field coverage, measured against NFR-020's 90% threshold. */
  readonly standardFieldCoverage: number;
}

/**
 * Canonical fields we attempt to map, with the API names each Tier 1 CRM is
 * likely to use. Matching is by exact API name first, then by normalised label,
 * then by type-compatible heuristic — in that order, because an exact API-name
 * match is evidence and a label match is a guess.
 */
const CANONICAL_TARGETS: Readonly<Record<string, { standard: boolean; candidates: readonly string[]; labels: readonly string[]; type: CrmField['type'] }>> = {
  'person.email': { standard: true, candidates: ['email', 'emailaddress1', 'Email'], labels: ['email', 'email address', 'work email'], type: 'email' },
  'person.firstName': { standard: true, candidates: ['firstname', 'FirstName', 'First_Name'], labels: ['first name', 'given name'], type: 'string' },
  'person.lastName': { standard: true, candidates: ['lastname', 'LastName', 'Last_Name'], labels: ['last name', 'surname', 'family name'], type: 'string' },
  'person.phone': { standard: true, candidates: ['phone', 'telephone1', 'Phone'], labels: ['phone', 'telephone', 'mobile'], type: 'phone' },
  'person.jobTitle': { standard: true, candidates: ['jobtitle', 'Title', 'jobTitle'], labels: ['job title', 'title', 'role'], type: 'string' },
  'organisation.name': { standard: true, candidates: ['name', 'company', 'companyname', 'Account_Name'], labels: ['company', 'company name', 'account name', 'organisation'], type: 'string' },
  'organisation.domain': { standard: true, candidates: ['domain', 'website', 'websiteurl', 'Website'], labels: ['domain', 'website', 'web site'], type: 'string' },
  'person.qualificationState': { standard: false, candidates: ['detent_qualification_state'], labels: ['qualification state'], type: 'picklist' },
  'person.consentEventId': { standard: false, candidates: ['detent_consent_event_id'], labels: ['consent event'], type: 'string' },
  'writeKey': { standard: false, candidates: ['detent_write_key', 'Detent_Key__c', 'detent_key'], labels: ['detent write key'], type: 'string' },
};

/** Fields that are CRM-authoritative whatever the schema says (decision 4). */
const CRM_AUTHORITATIVE = /^(owner|ownerid|hubspot_owner_id|lifecycle|lifecyclestage|pipeline|stage|dealstage|stagename|statuscode)/i;

const normaliseLabel = (label: string): string => label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function generateMapping(schemas: readonly CrmSchema[], now: () => string): GeneratedMapping {
  const mappings: Approvable<FieldMapping>[] = [];
  const unmapped: string[] = [];
  let standardTotal = 0;
  let standardMapped = 0;

  for (const [canonicalField, target] of Object.entries(CANONICAL_TARGETS)) {
    if (target.standard) standardTotal++;
    let best: { field: CrmField; schema: CrmSchema; confidence: number } | undefined;

    for (const schema of schemas) {
      for (const field of schema.fields) {
        if (CRM_AUTHORITATIVE.test(field.apiName)) continue; // never a write target

        let confidence = 0;
        if (target.candidates.includes(field.apiName)) confidence = 0.97;
        else if (target.labels.includes(normaliseLabel(field.label))) confidence = 0.86;
        else if (field.type === target.type && target.labels.some((l) => normaliseLabel(field.label).includes(l))) confidence = 0.72;

        if (confidence > 0 && (!best || confidence > best.confidence)) {
          best = { field, schema, confidence };
        }
      }
    }

    if (!best) {
      unmapped.push(canonicalField);
      continue;
    }
    if (target.standard) standardMapped++;

    mappings.push(draft<FieldMapping>({
      canonicalField,
      crmObject: best.schema.objectName,
      crmField: best.field.apiName,
      confidence: best.confidence,
      sourceOfTruth: 'assistant',
      ...(best.field.picklistValues
        ? { picklistAlignment: alignPicklist(canonicalField, best.field.picklistValues) }
        : {}),
    }, { sourceUrl: `crm:${best.schema.objectName}.${best.field.apiName}`, confidence: best.confidence, extractedAt: now() }));
  }

  return {
    mappings,
    unmapped,
    standardFieldCoverage: standardTotal === 0 ? 1 : standardMapped / standardTotal,
  };
}

/** Align canonical enumeration values to the tenant's own picklist values. */
function alignPicklist(canonicalField: string, values: readonly string[]): Record<string, string> {
  if (canonicalField !== 'person.qualificationState') return {};
  const alignment: Record<string, string> = {};
  for (const canonical of ['UNQUALIFIED', 'CAPTURED', 'QUALIFIED', 'DISQUALIFIED']) {
    const match = values.find((value) => normaliseLabel(value) === normaliseLabel(canonical));
    if (match) alignment[canonical] = match;
  }
  return alignment;
}

// --------------------------------------------------------------------------
// 4. Routing generator
// --------------------------------------------------------------------------

export interface RoutingRule {
  readonly when: 'known_prospect' | 'open_opportunity' | 'existing_customer' | 'new_prospect' | 'ambiguous';
  readonly action: 'route_to_owner' | 'route_to_account_team' | 'round_robin' | 'escalate';
  readonly ownerRefs: readonly string[];
}

export interface GeneratedRouting {
  readonly rules: readonly Approvable<RoutingRule>[];
  /** Read live from the CRM. Never inferred, never hard-coded (FR-034). */
  readonly openStageIds: readonly string[];
  readonly closedWonStageIds: readonly string[];
  readonly ownerCount: number;
}

export function generateRouting(input: {
  owners: readonly CanonicalOwner[];
  pipelines: readonly CanonicalPipeline[];
  capabilities: CapabilityDeclaration;
  now: () => string;
}): GeneratedRouting {
  const stages = input.pipelines.flatMap((pipeline) => pipeline.stages);
  const activeOwners = input.owners.filter((owner) => owner.active).map((owner) => owner.id);
  const provenance = (confidence: number) => ({
    sourceUrl: `crm:${input.capabilities.connector}`,
    confidence,
    extractedAt: input.now(),
  });

  const rules: Approvable<RoutingRule>[] = [
    draft<RoutingRule>({ when: 'open_opportunity', action: 'route_to_owner', ownerRefs: [] }, provenance(0.95)),
    draft<RoutingRule>({ when: 'existing_customer', action: 'route_to_account_team', ownerRefs: [] }, provenance(0.95)),
    draft<RoutingRule>({ when: 'known_prospect', action: 'route_to_owner', ownerRefs: [] }, provenance(0.9)),
    // Ambiguity always escalates. Offered for approval like everything else, but
    // there is no generated alternative to it: the platform does not guess.
    draft<RoutingRule>({ when: 'ambiguous', action: 'escalate', ownerRefs: [] }, provenance(0.99)),
    draft<RoutingRule>(
      { when: 'new_prospect', action: 'round_robin', ownerRefs: activeOwners },
      provenance(activeOwners.length > 0 ? 0.82 : 0.4),
    ),
  ];

  return {
    rules,
    openStageIds: stages.filter((stage) => stage.isOpen).map((stage) => stage.id),
    closedWonStageIds: stages.filter((stage) => stage.isClosedWon).map((stage) => stage.id),
    ownerCount: activeOwners.length,
  };
}
