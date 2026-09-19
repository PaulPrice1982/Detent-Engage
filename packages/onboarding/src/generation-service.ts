import {
  AwaError, approvalCoverage, approve, stateOf,
  type Approvable, type Clock, type ObjectionPlay, type QualificationModel,
  systemClock,
} from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import type { CapabilityDeclaration } from '@detent/awa-connectors';
import { GovernedCrawler, type CrawlOptions, type PageFetcher } from './crawler.js';
import { PatternExtractor, type Extractor } from './extraction.js';
import {
  generateKnowledge, generateMapping, generatePlaybook, generateRouting,
  type CrmSchema, type GeneratedKnowledge, type GeneratedMapping,
  type GeneratedPlaybook, type GeneratedRouting,
} from './generators.js';

/**
 * The generation service (section 38).
 *
 * Target: signup to a live, governed, CRM-connected assistant in under fifteen
 * minutes (NFR-019), with every generated artefact presented as a draft
 * requiring explicit approval.
 *
 * Risk 14 is that instant onboarding erodes the governance position by making
 * approval feel like friction to remove. The answer taken here is structural:
 * there is no "skip all" path in this class, `approveSection` requires a named
 * approver, and approval coverage is reported to the compliance scorecard so a
 * tenant who clicked through everything is visible rather than invisible.
 */
export interface GenerationInput {
  readonly tenantId: string;
  readonly rootUrl: string;
  readonly correlationId: string;
  readonly crawl?: CrawlOptions;
  readonly qualification: QualificationModel;
  readonly objections: readonly ObjectionPlay[];
  /** Live CRM schema, read through the connector contract. */
  readonly crmSchemas: readonly CrmSchema[];
  readonly owners: readonly { id: string; name: string; email?: string; active: boolean }[];
  readonly pipelines: readonly { id: string; label: string; stages: readonly { id: string; label: string; isOpen: boolean; isClosedWon: boolean; order: number }[] }[];
  readonly capabilities: CapabilityDeclaration;
}

export type GeneratedSection = 'knowledge' | 'playbook' | 'mapping' | 'routing';

export interface GenerationResult {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly generatedAt: string;
  readonly durationMs: number;
  knowledge: GeneratedKnowledge;
  playbook: GeneratedPlaybook;
  mapping: GeneratedMapping;
  routing: GeneratedRouting;
  /** Per-section approval. Nothing serves unapproved (FR-035). */
  readonly approvals: Record<GeneratedSection, boolean>;
}

export class GenerationService {
  private readonly crawler: GovernedCrawler;
  private readonly results = new Map<string, GenerationResult>();

  constructor(
    fetcher: PageFetcher,
    private readonly audit: AuditLog,
    private readonly extractor: Extractor = new PatternExtractor(),
    private readonly clock: Clock = systemClock,
  ) {
    this.crawler = new GovernedCrawler(fetcher);
  }

  /** Steps 1 to 4 of the generation pipeline. Steps 5 to 9 are elsewhere. */
  async generate(input: GenerationInput): Promise<GenerationResult> {
    const startedAt = this.clock.nowMs();

    // 1. Crawl, governed: own domain only, robots respected.
    const crawl = await this.crawler.crawl(input.rootUrl, input.crawl);
    if (crawl.pages.length === 0) {
      throw new AwaError({
        kind: 'NOT_FOUND',
        message: `no crawlable pages found at ${input.rootUrl}`,
        tenantId: input.tenantId,
        details: { skipped: crawl.skipped.slice(0, 10) },
      });
    }

    // 2. Extract into typed schemas, every claim with a source and a confidence.
    const extraction = await this.extractor.extract(crawl.pages);

    // 3. Introspect the live CRM. No stage or pipeline is ever inferred.
    const mapping = generateMapping(input.crmSchemas, () => this.clock.iso());
    const routing = generateRouting({
      owners: input.owners,
      pipelines: input.pipelines,
      capabilities: input.capabilities,
      now: () => this.clock.iso(),
    });

    // 4. Synthesise the draft playbook.
    const knowledge = generateKnowledge(crawl, () => this.clock.iso());
    const playbook = generatePlaybook({
      extraction,
      qualification: input.qualification,
      objections: input.objections,
      sourceUrls: crawl.pages.map((page) => page.url),
    });

    const result: GenerationResult = {
      tenantId: input.tenantId,
      correlationId: input.correlationId,
      generatedAt: this.clock.iso(),
      durationMs: this.clock.nowMs() - startedAt,
      knowledge,
      playbook,
      mapping,
      routing,
      approvals: { knowledge: false, playbook: false, mapping: false, routing: false },
    };

    this.results.set(input.tenantId, result);

    await this.audit.write({
      tenantId: input.tenantId,
      type: 'policy_allowed',
      correlationId: input.correlationId,
      actor: 'system',
      payload: {
        change: 'configuration_generated',
        pagesCrawled: crawl.pages.length,
        pagesSkipped: crawl.skipped.length,
        services: playbook.serviceCatalogue.length,
        prices: playbook.priceList.length,
        claims: playbook.approvedClaims.length,
        standardFieldCoverage: mapping.standardFieldCoverage,
        // Recorded explicitly so an audit can show that nothing arrived approved.
        approvedOnGeneration: 0,
      },
    });

    return result;
  }

  get(tenantId: string): GenerationResult {
    const result = this.results.get(tenantId);
    if (!result) {
      throw new AwaError({ kind: 'NOT_FOUND', message: `no generated configuration for tenant ${tenantId}` });
    }
    return result;
  }

  /**
   * Approve individual items within a section. The caller names the items, so a
   * tenant who approves everything did so item by item and the audit entry
   * records how many they looked at.
   */
  async approveItems(
    tenantId: string,
    section: GeneratedSection,
    itemKeys: readonly string[],
    approvedBy: string,
    correlationId: string,
  ): Promise<GenerationResult> {
    const result = this.get(tenantId);
    const at = this.clock.iso();
    const keys = new Set(itemKeys);

    const apply = <T>(items: readonly Approvable<T>[], keyOf: (value: T) => string): Approvable<T>[] =>
      items.map((item) => (keys.has(keyOf(item.value)) ? approve(item, approvedBy, at) : item));

    switch (section) {
      case 'knowledge':
        result.knowledge = { ...result.knowledge, items: apply(result.knowledge.items, (v) => v.sourceUrl) };
        break;
      case 'playbook': {
        const services = apply(result.playbook.serviceCatalogue, (v) => v.id);
        const prices = apply(result.playbook.priceList, (v) => v.sku);
        const claims = apply(result.playbook.approvedClaims, (v) => v.claim);
        result.playbook = {
          ...result.playbook,
          serviceCatalogue: services,
          priceList: prices,
          approvedClaims: claims,
          approvalState: stateOf([...services, ...prices, ...claims]),
        };
        break;
      }
      case 'mapping':
        result.mapping = { ...result.mapping, mappings: apply(result.mapping.mappings, (v) => `${v.canonicalField}`) };
        break;
      case 'routing':
        result.routing = { ...result.routing, rules: apply(result.routing.rules, (v) => v.when) };
        break;
    }

    await this.audit.write({
      tenantId, type: 'policy_allowed', correlationId, actor: 'tenant_admin',
      payload: { change: 'generated_items_approved', section, count: itemKeys.length, approvedBy },
    });

    return result;
  }

  /**
   * Mark a whole section reviewed. Requires that every item in it has been
   * individually approved or explicitly excluded — a section cannot be signed
   * off with unread items sitting in it.
   */
  async approveSection(tenantId: string, section: GeneratedSection, approvedBy: string, correlationId: string): Promise<GenerationResult> {
    const result = this.get(tenantId);
    const items = this.itemsFor(result, section);
    const outstanding = items.filter((item) => !item.approved && !item.excludedReason);
    if (outstanding.length > 0) {
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message: `${outstanding.length} item(s) in ${section} are neither approved nor excluded; review them before signing off the section`,
        tenantId,
        details: { section, outstanding: outstanding.length },
      });
    }

    result.approvals[section] = true;
    await this.audit.write({
      tenantId, type: 'policy_allowed', correlationId, actor: 'tenant_admin',
      payload: {
        change: 'generated_section_approved',
        section,
        approvedBy,
        // Coverage is reported so a tenant who excluded everything is as
        // visible as one who approved everything (risk 14).
        approvalCoverage: Number(approvalCoverage(items).toFixed(3)),
        itemCount: items.length,
      },
    });
    return result;
  }

  private itemsFor(result: GenerationResult, section: GeneratedSection): readonly Approvable<unknown>[] {
    switch (section) {
      case 'knowledge': return result.knowledge.items;
      case 'playbook': return [...result.playbook.serviceCatalogue, ...result.playbook.priceList, ...result.playbook.approvedClaims];
      case 'mapping': return result.mapping.mappings;
      case 'routing': return result.routing.rules;
    }
  }

  /** Overall approval coverage across every generated artefact, for the scorecard. */
  coverage(tenantId: string): Record<GeneratedSection, number> {
    const result = this.get(tenantId);
    return {
      knowledge: approvalCoverage(result.knowledge.items),
      playbook: approvalCoverage(this.itemsFor(result, 'playbook')),
      mapping: approvalCoverage(result.mapping.mappings),
      routing: approvalCoverage(result.routing.rules),
    };
  }

  /** Every section approved. The gate on leaving dry-run. */
  fullyApproved(tenantId: string): boolean {
    const { approvals } = this.get(tenantId);
    return approvals.knowledge && approvals.playbook && approvals.mapping && approvals.routing;
  }
}
