import { AwaError, type Clock, type TenantConfig, systemClock } from '@detent/awa-core';
import type { MeteringService } from '@detent/awa-policy';

/**
 * The enrichment orchestrator (section 43.3 and 43.4).
 *
 * Enrichment is the first component in this programme with a per-record
 * marginal cost paid to a third party, and it changes the unit economics
 * materially: Wave B moves blended cost of goods from £0.35–0.60 to
 * £0.55–0.95 per conversation. It is therefore metered as credits, capped per
 * tenant, and the cost of any bulk routine is shown before it runs (FR-063).
 *
 * Enrichment is explicitly not model-mediated (section 48.2). There is no path
 * by which a language model decides to spend a tenant's money.
 */
export interface FirmographicRecord {
  readonly domain: string;
  readonly companyName?: string;
  readonly employeeBand?: string;
  readonly industry?: string;
  readonly country?: string;
  readonly vendor: string;
  readonly retrievedAt: string;
}

export interface EnrichmentVendor {
  readonly name: string;
  enrich(domain: string): Promise<FirmographicRecord | undefined>;
}

export interface CachedRecord {
  readonly record: FirmographicRecord;
  readonly cachedAt: string;
}

export interface CostPreview {
  readonly records: number;
  readonly cachedHits: number;
  readonly chargeable: number;
  readonly estimatedPence: number;
  readonly capRemainingPence: number;
  readonly withinCap: boolean;
}

export class EnrichmentOrchestrator {
  /** Cached per tenant. Cross-tenant reuse is governed by vendor agreements. */
  private readonly cache = new Map<string, CachedRecord>();

  constructor(
    private readonly vendors: readonly EnrichmentVendor[],
    private readonly metering: MeteringService,
    private readonly perRecordPence: number,
    private readonly stalenessDays = 90,
    private readonly clock: Clock = systemClock,
  ) {}

  private key(tenantId: string, domain: string): string {
    return `${tenantId}:${domain.toLowerCase()}`;
  }

  private fresh(cached: CachedRecord | undefined): boolean {
    if (!cached) return false;
    const age = this.clock.nowMs() - Date.parse(cached.cachedAt);
    return age < this.stalenessDays * 86_400_000;
  }

  /**
   * The cost preview shown before any bulk routine runs (FR-063).
   *
   * Cached domains are named as such, so a tenant sees the real charge rather
   * than a worst case that makes the feature look more expensive than it is.
   */
  async preview(config: TenantConfig, domains: readonly string[]): Promise<CostPreview> {
    const unique = [...new Set(domains.map((domain) => domain.toLowerCase()))];
    const cachedHits = unique.filter((domain) => this.fresh(this.cache.get(this.key(config.tenantId, domain)))).length;
    const chargeable = unique.length - cachedHits;
    const estimatedPence = chargeable * this.perRecordPence;

    const usage = await this.metering.usage(config.tenantId);
    const spentOnEnrichment = usage.enrichmentRecords * this.perRecordPence;
    const capRemaining = Math.max(0, config.engagement.enrichmentMonthlyCapPence - spentOnEnrichment);

    return {
      records: unique.length,
      cachedHits,
      chargeable,
      estimatedPence,
      capRemainingPence: capRemaining,
      withinCap: estimatedPence <= capRemaining,
    };
  }

  /**
   * Waterfall across vendors (FR-065): the first vendor that returns a record
   * wins, and a vendor returning nothing falls through to the next rather than
   * failing the enrichment.
   */
  async enrich(config: TenantConfig, domain: string): Promise<FirmographicRecord | undefined> {
    if (!config.engagement.enrichmentEnabled) {
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message: 'enrichment is not enabled for this tenant',
        tenantId: config.tenantId,
      });
    }

    const cached = this.cache.get(this.key(config.tenantId, domain));
    if (this.fresh(cached)) return cached!.record;

    const preview = await this.preview(config, [domain]);
    if (!preview.withinCap) {
      throw new AwaError({
        kind: 'SPEND_CAP_REACHED',
        message: `enrichment would exceed the monthly cap; ${preview.capRemainingPence}p remaining`,
        tenantId: config.tenantId,
      });
    }

    for (const vendor of this.vendors) {
      const record = await vendor.enrich(domain).catch(() => undefined);
      if (!record) continue;
      this.cache.set(this.key(config.tenantId, domain), { record, cachedAt: this.clock.iso() });
      await this.metering.record(config.tenantId, 'enrichment_record', 1);
      return record;
    }

    // Every vendor returned nothing. Not charged: there is no record to pay for.
    return undefined;
  }

  async enrichMany(config: TenantConfig, domains: readonly string[]): Promise<{ preview: CostPreview; records: FirmographicRecord[] }> {
    const preview = await this.preview(config, domains);
    if (!preview.withinCap) {
      throw new AwaError({
        kind: 'SPEND_CAP_REACHED',
        message: `bulk enrichment of ${preview.chargeable} records would exceed the monthly cap`,
        tenantId: config.tenantId,
        details: { preview },
      });
    }
    const records: FirmographicRecord[] = [];
    for (const domain of [...new Set(domains)]) {
      const record = await this.enrich(config, domain);
      if (record) records.push(record);
    }
    return { preview, records };
  }
}
