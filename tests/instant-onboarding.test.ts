import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { FixedClock, approvedValues, LOW_CONFIDENCE_THRESHOLD } from '@detent/awa-core';
import { DEFAULT_OBJECTIONS, DEFAULT_QUALIFICATION_MODEL } from '@detent/awa-agent';
import {
  GenerationService, GovernedCrawler, PatternExtractor, StagingLedger,
  generateMapping, toPriceList, toServiceCatalogue,
  type CrmSchema,
} from '@detent/awa-onboarding';
import { SandboxConnector } from '@detent/awa-connectors';
import { StaticPageFetcher } from './fixtures/extension.js';
import { buildHarness } from './fixtures/tenant.js';

/**
 * CI gates for section 38 / FR-031 to FR-037, NFR-019 to NFR-021.
 *
 * The invariant that matters most: **zero unapproved generated content
 * reachable by a visitor.**
 */
const clock = () => new FixedClock(new Date('2026-09-04T09:00:00.000Z'));

async function generate() {
  const fixedClock = clock();
  const audit = new AuditLog(new InMemoryAuditStore(), fixedClock);
  const fetcher = new StaticPageFetcher();
  const service = new GenerationService(fetcher, audit, new PatternExtractor(() => fixedClock.iso()), fixedClock);
  const crm = new SandboxConnector();

  const result = await service.generate({
    tenantId: 't_acme',
    rootUrl: 'https://acme.co.uk/',
    correlationId: 'corr_gen',
    qualification: DEFAULT_QUALIFICATION_MODEL,
    objections: DEFAULT_OBJECTIONS,
    crmSchemas: [],
    owners: await crm.readOwners(),
    pipelines: await crm.readPipelines(),
    capabilities: crm.capabilities(),
  });
  return { service, result, audit, fetcher };
}

describe('governed crawl', () => {
  it('respects robots.txt and never leaves the tenant domain', async () => {
    const fetcher = new StaticPageFetcher();
    const crawl = await new GovernedCrawler(fetcher).crawl('https://acme.co.uk/', {
      seedUrls: ['https://competitor.example/pricing'],
    });

    expect(crawl.pages.map((page) => page.url)).not.toContain('https://acme.co.uk/private/internal');
    expect(crawl.skipped.some((s) => s.reason === 'disallowed by robots.txt')).toBe(true);
    expect(crawl.skipped.some((s) => s.reason === 'off the tenant registrable domain')).toBe(true);
    // Never fetched at all, not merely discarded after fetching.
    expect(fetcher.fetched).not.toContain('https://competitor.example/pricing');
  });

  it('honours the page cap', async () => {
    const crawl = await new GovernedCrawler(new StaticPageFetcher()).crawl('https://acme.co.uk/', { maxPages: 2 });
    expect(crawl.pages).toHaveLength(2);
    expect(crawl.skipped.some((s) => s.reason.includes('page cap'))).toBe(true);
  });
});

describe('generation produces drafts, never approved content', () => {
  it('extracts prices and claims with source provenance and a confidence', async () => {
    const { result } = await generate();
    const prices = result.playbook.priceList;
    expect(prices.length).toBeGreaterThan(0);
    for (const price of prices) {
      expect(price.provenance.sourceUrl).toMatch(/^https:\/\/acme\.co\.uk/);
      expect(price.provenance.confidence).toBeGreaterThan(0);
      expect(price.provenance.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('marks every generated price and claim unapproved on generation', async () => {
    const { result } = await generate();
    const everything = [
      ...result.playbook.priceList,
      ...result.playbook.approvedClaims,
      ...result.playbook.serviceCatalogue,
      ...result.knowledge.items,
    ];
    expect(everything.length).toBeGreaterThan(0);
    expect(everything.every((item) => item.approved === false)).toBe(true);
    expect(result.playbook.approvalState).toBe('DRAFT');
  });

  it('excludes low-confidence items by default rather than merely leaving them unapproved', async () => {
    const { result } = await generate();
    // A price found in a blog post scores below the threshold, so it does not
    // sit in the list a hurried tenant clicks through.
    const excluded = result.playbook.priceList.filter((price) => price.excludedReason);
    expect(excluded.length).toBeGreaterThan(0);
    for (const item of excluded) {
      expect(item.provenance.confidence).toBeLessThan(LOW_CONFIDENCE_THRESHOLD);
    }
  });

  it('yields an empty servable price list until items are approved (NFR-021)', async () => {
    const { service, result } = await generate();
    expect(toPriceList(result.playbook)).toHaveLength(0);
    expect(toServiceCatalogue(result.playbook)).toHaveLength(0);

    const sku = result.playbook.priceList.find((price) => !price.excludedReason)!.value.sku;
    await service.approveItems('t_acme', 'playbook', [sku], 'dpo@acme.co.uk', 'corr_approve');

    const servable = toPriceList(service.get('t_acme').playbook);
    expect(servable).toHaveLength(1);
    expect(servable[0]!.sku).toBe(sku);
  });

  it('refuses to sign off a section with unread items still in it', async () => {
    const { service } = await generate();
    await expect(service.approveSection('t_acme', 'playbook', 'dpo@acme.co.uk', 'corr'))
      .rejects.toThrowError(/neither approved nor excluded/);
  });

  it('records approval coverage so a tenant who approved without reading is visible', async () => {
    const { service, result, audit } = await generate();
    const keys = result.knowledge.items.map((item) => item.value.sourceUrl);
    await service.approveItems('t_acme', 'knowledge', keys, 'marketing@acme.co.uk', 'corr_a');
    await service.approveSection('t_acme', 'knowledge', 'marketing@acme.co.uk', 'corr_b');

    const exported = await audit.export('t_acme');
    const entry = exported.entries.find(
      (e) => (e.payload as Record<string, unknown> | undefined)?.['change'] === 'generated_section_approved',
    );
    expect(entry).toBeDefined();
    expect((entry!.payload as Record<string, unknown>)['approvalCoverage']).toBe(1);
  });

  it('never ingests unshipped capability, even when it is on the site', async () => {
    const { result } = await generate();
    const corpus = result.knowledge.items.map((item) => item.value.text).join(' ');
    // The internal roadmap page is robots-disallowed and never reached.
    expect(corpus).not.toContain('Q3 2027');
    expect(corpus).not.toContain('automated recovery agent');
  });
});

describe('mapping generator', () => {
  const schema: CrmSchema[] = [{
    objectName: 'Contact',
    fields: [
      { apiName: 'email', label: 'Email', type: 'email', custom: false },
      { apiName: 'firstname', label: 'First Name', type: 'string', custom: false },
      { apiName: 'lastname', label: 'Last Name', type: 'string', custom: false },
      { apiName: 'phone', label: 'Phone Number', type: 'phone', custom: false },
      { apiName: 'jobtitle', label: 'Job Title', type: 'string', custom: false },
      { apiName: 'company', label: 'Company Name', type: 'string', custom: false },
      { apiName: 'domain', label: 'Domain', type: 'string', custom: false },
      { apiName: 'hubspot_owner_id', label: 'Contact Owner', type: 'reference', custom: false },
      { apiName: 'lifecyclestage', label: 'Lifecycle Stage', type: 'picklist', custom: false, picklistValues: ['lead', 'customer'] },
      { apiName: 'detent_write_key', label: 'Detent Write Key', type: 'string', custom: true },
      { apiName: 'detent_qualification_state', label: 'Qualification State', type: 'picklist', custom: true, picklistValues: ['Unqualified', 'Captured', 'Qualified', 'Disqualified'] },
    ],
  }];

  it('maps above 90% of standard fields without tenant input (NFR-020)', () => {
    const mapping = generateMapping(schema, () => '2026-09-04T09:00:00.000Z');
    expect(mapping.standardFieldCoverage).toBeGreaterThan(0.9);
  });

  it('never proposes an owner, lifecycle stage, pipeline or stage as a write target', () => {
    const mapping = generateMapping(schema, () => '2026-09-04T09:00:00.000Z');
    const targets = mapping.mappings.map((m) => m.value.crmField.toLowerCase());
    expect(targets).not.toContain('hubspot_owner_id');
    expect(targets).not.toContain('lifecyclestage');
  });

  it('aligns picklist values to the tenant own enumeration', () => {
    const mapping = generateMapping(schema, () => '2026-09-04T09:00:00.000Z');
    const qualification = mapping.mappings.find((m) => m.value.canonicalField === 'person.qualificationState');
    expect(qualification?.value.picklistAlignment?.['QUALIFIED']).toBe('Qualified');
  });

  it('names unmapped canonical fields rather than dropping them silently', () => {
    const mapping = generateMapping([{ objectName: 'Contact', fields: [{ apiName: 'email', label: 'Email', type: 'email', custom: false }] }], () => 'now');
    expect(mapping.unmapped.length).toBeGreaterThan(0);
    expect(mapping.unmapped).toContain('person.jobTitle');
  });
});

describe('routing generator', () => {
  it('reads stages live and never hard-codes an assumption (FR-034)', async () => {
    const { result } = await generate();
    expect(result.routing.openStageIds).toEqual(['discovery', 'proposal']);
    expect(result.routing.closedWonStageIds).toEqual(['closedwon']);
    expect(result.routing.rules.some((rule) => rule.value.when === 'ambiguous' && rule.value.action === 'escalate')).toBe(true);
  });
});

describe('dry-run staging ledger', () => {
  it('stages CRM writes instead of executing them, and shows what would happen', async () => {
    const crm = new SandboxConnector();
    const harness = await buildHarness({ crm });
    const tenantId = harness.config.tenantId;
    await harness.platform.tenants.applyOperatorPatch(tenantId, { dryRun: true }, 'test: exercise dry run');

    const config = harness.platform.effectiveConfig(tenantId);
    const { buildToolCatalogue } = await import('@detent/awa-agent');
    const session = await harness.platform.openSession(tenantId, 'UK');

    const result = await harness.platform.executor.execute(session, config, buildToolCatalogue(config.serviceCatalogue), {
      tool: 'upsert_person',
      args: { work_email: 'alex@acme.co.uk', full_name: 'Alex Warner', qualification_state: 'QUALIFIED' },
    });

    expect(result.modelVisible['staged']).toBe(true);
    // Nothing reached the CRM.
    expect([...crm.records.values()].filter((r) => r.email === 'alex@acme.co.uk')).toHaveLength(0);

    const diff = harness.platform.staging.diff(tenantId);
    expect(diff.totalWrites).toBe(1);
    expect(diff.writes[0]!.summary).toContain('alex@acme.co.uk');
    // The line that answers the RevOps buyer's actual question.
    expect(diff.writes[0]!.untouched).toContain('owner');
    expect(diff.writes[0]!.untouched).toContain('lifecycle_stage');
  });

  it('enables real writes only once the tenant accepts the diff', async () => {
    const harness = await buildHarness();
    const tenantId = harness.config.tenantId;
    await harness.platform.tenants.applyOperatorPatch(tenantId, { dryRun: true }, 'test: exercise dry run');

    const response = await harness.api.handle({
      method: 'POST', path: `/v1/admin/tenants/${tenantId}/dry-run`,
      headers: { authorization: `Bearer ${harness.adminKey}` },
    });
    expect(response.status).toBe(200);
    expect(harness.platform.tenants.get(tenantId).dryRun).toBe(false);
  });

  it('discards staged writes without applying them', () => {
    const ledger = new StagingLedger(clock());
    ledger.stage({
      tenantId: 't1', correlationId: 'c', idempotencyKey: 'k', operation: 'upsert_person',
      canonical: { emails: ['a@b.co.uk'], qualificationState: 'QUALIFIED' },
      sourceOfTruthPolicy: 'assistant_may_write_contact_fields_only', forbiddenFields: ['owner'],
    });
    expect(ledger.pending('t1')).toHaveLength(1);
    expect(ledger.discard('t1')).toBe(1);
    expect(ledger.pending('t1')).toHaveLength(0);
  });
});

describe('approval helpers', () => {
  it('returns only approved values', () => {
    const items = [
      { value: 'a', provenance: { sourceUrl: 'u', confidence: 0.9, extractedAt: 'now' }, approved: true },
      { value: 'b', provenance: { sourceUrl: 'u', confidence: 0.9, extractedAt: 'now' }, approved: false },
    ];
    expect(approvedValues(items)).toEqual(['a']);
  });
});
