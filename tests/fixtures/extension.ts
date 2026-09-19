import type { FetchedPage, PageFetcher, RobotsRules } from '@detent/awa-onboarding';
import type { CompanyResolver, CompanyResolution, EnrichmentVendor, FirmographicRecord } from '@detent/awa-signals';
import type { OutcomeDispatcher } from '@detent/awa-outcomes';

/** A small static site, standing in for a tenant's own. */
export const SITE: Record<string, FetchedPage> = {
  'https://acme.co.uk/': {
    url: 'https://acme.co.uk/', title: 'Acme Revenue Ltd', status: 200,
    fetchedAt: '2026-09-04T09:00:00.000Z',
    text: 'We help mid-market businesses recover contract revenue they are already owed. We have worked with over 200 organisations across the UK and Ireland since 2018, and we are ISO 27001 certified.',
  },
  'https://acme.co.uk/services': {
    url: 'https://acme.co.uk/services', title: 'Contract review', status: 200,
    fetchedAt: '2026-09-04T09:00:00.000Z',
    text: 'Our contract review service audits commercial agreements for unbilled excess use, uplift clauses and renewal exposure. A fixed-scope engagement covers up to 25 contracts. We provide a written recovery position within four weeks.',
  },
  'https://acme.co.uk/pricing': {
    url: 'https://acme.co.uk/pricing', title: 'Contract review', status: 200,
    fetchedAt: '2026-09-04T09:00:00.000Z',
    text: 'Contract review is £4,500 per engagement. Our revenue recovery programme runs from £12,000 to £45,000 per programme depending on scope. We deliver every engagement with a named lead consultant.',
  },
  'https://acme.co.uk/blog/why-contracts-leak': {
    url: 'https://acme.co.uk/blog/why-contracts-leak', title: 'Why contracts leak', status: 200,
    fetchedAt: '2026-09-04T09:00:00.000Z',
    text: 'In one engagement we recovered £310,000 for a client in under six weeks. We have seen the same pattern repeat across dozens of contracts in the sector.',
  },
  'https://acme.co.uk/private/internal': {
    url: 'https://acme.co.uk/private/internal', title: 'Internal roadmap', status: 200,
    fetchedAt: '2026-09-04T09:00:00.000Z',
    text: 'Unreleased: our automated recovery agent ships in Q3 2027 at £9,000 per seat. Do not share externally.',
  },
};

export class StaticPageFetcher implements PageFetcher {
  readonly fetched: string[] = [];

  constructor(
    private readonly pages: Record<string, FetchedPage> = SITE,
    private readonly disallow: readonly string[] = ['/private'],
  ) {}

  async fetch(url: string): Promise<FetchedPage> {
    this.fetched.push(url);
    const page = this.pages[url];
    if (!page) return { url, title: '', text: '', status: 404, fetchedAt: '2026-09-04T09:00:00.000Z' };
    return page;
  }

  async sitemap(): Promise<string[]> {
    return Object.keys(this.pages);
  }

  async robots(): Promise<RobotsRules> {
    return { disallow: [...this.disallow] };
  }
}

export class StubCompanyResolver implements CompanyResolver {
  constructor(private readonly byIp: Record<string, CompanyResolution> = {}) {}
  async resolve(ip: string): Promise<CompanyResolution | undefined> {
    return this.byIp[ip];
  }
}

export class StubEnrichmentVendor implements EnrichmentVendor {
  calls = 0;
  constructor(
    readonly name: string,
    private readonly records: Record<string, FirmographicRecord> = {},
  ) {}
  async enrich(domain: string): Promise<FirmographicRecord | undefined> {
    this.calls++;
    return this.records[domain];
  }
}

export class RecordingDispatcher implements OutcomeDispatcher {
  readonly calls: { url: string; payload: unknown; signature: string }[] = [];
  constructor(private readonly status = 204) {}
  async post(url: string, payload: unknown, signature: string): Promise<{ status: number }> {
    this.calls.push({ url, payload, signature });
    return { status: this.status };
  }
}
