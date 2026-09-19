import { AwaError } from '@detent/awa-core';

/**
 * Governed crawl (section 38.3 step 1).
 *
 * "Governed ingestion only: no arbitrary web content into context." Three
 * constraints follow, and all three are enforced here rather than trusted to
 * the caller:
 *
 *  - the crawl stays on the tenant's own registrable domain, because a page on
 *    someone else's site is not the tenant's approved knowledge;
 *  - robots.txt is respected, because a crawler that ignores it is a liability
 *    the tenant inherits;
 *  - fetched content is data and never instruction, so it enters the corpus
 *    through the same governed ingestion path as an uploaded document.
 */
export interface FetchedPage {
  readonly url: string;
  readonly title: string;
  readonly text: string;
  readonly fetchedAt: string;
  readonly status: number;
}

export interface PageFetcher {
  fetch(url: string): Promise<FetchedPage>;
  /** Sitemap URLs, or an empty array where the site publishes none. */
  sitemap(rootUrl: string): Promise<string[]>;
  robots(rootUrl: string): Promise<RobotsRules>;
}

export interface RobotsRules {
  readonly disallow: readonly string[];
  readonly crawlDelayMs?: number;
}

export interface CrawlOptions {
  readonly maxPages?: number;
  readonly maxDepth?: number;
  /** Extra URLs the tenant supplied explicitly, which always take priority. */
  readonly seedUrls?: readonly string[];
}

export interface CrawlResult {
  readonly pages: readonly FetchedPage[];
  readonly skipped: readonly { url: string; reason: string }[];
  readonly durationMs: number;
}

export function registrableHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    throw new AwaError({ kind: 'SCHEMA_INVALID', message: `not a valid URL: ${url}` });
  }
}

function isDisallowed(url: string, rules: RobotsRules): boolean {
  const path = new URL(url).pathname;
  return rules.disallow.some((rule) => rule.length > 0 && path.startsWith(rule));
}

export class GovernedCrawler {
  constructor(private readonly fetcher: PageFetcher) {}

  async crawl(rootUrl: string, options: CrawlOptions = {}): Promise<CrawlResult> {
    const startedAt = Date.now();
    const host = registrableHost(rootUrl);
    const maxPages = options.maxPages ?? 200;
    const robots = await this.fetcher.robots(rootUrl);

    const sitemap = await this.fetcher.sitemap(rootUrl);
    // Tenant-supplied URLs first: they are the pages the tenant thinks matter,
    // and a 200-page cap should spend itself on those before anything else.
    const queue = [...(options.seedUrls ?? []), ...sitemap, rootUrl];

    const pages: FetchedPage[] = [];
    const skipped: { url: string; reason: string }[] = [];
    const seen = new Set<string>();

    for (const url of queue) {
      if (pages.length >= maxPages) {
        skipped.push({ url, reason: `page cap of ${maxPages} reached` });
        continue;
      }
      const normalised = url.split('#')[0]!;
      if (seen.has(normalised)) continue;
      seen.add(normalised);

      if (registrableHost(normalised) !== host) {
        skipped.push({ url: normalised, reason: 'off the tenant registrable domain' });
        continue;
      }
      if (isDisallowed(normalised, robots)) {
        skipped.push({ url: normalised, reason: 'disallowed by robots.txt' });
        continue;
      }

      try {
        const page = await this.fetcher.fetch(normalised);
        if (page.status >= 400) {
          skipped.push({ url: normalised, reason: `status ${page.status}` });
          continue;
        }
        if (page.text.trim().length < 80) {
          skipped.push({ url: normalised, reason: 'too little text to extract from' });
          continue;
        }
        pages.push(page);
      } catch (cause) {
        skipped.push({ url: normalised, reason: cause instanceof Error ? cause.message : 'fetch failed' });
      }
    }

    return { pages, skipped, durationMs: Date.now() - startedAt };
  }
}
