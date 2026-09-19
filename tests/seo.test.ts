import { describe, expect, it } from 'vitest';
import { canonicalUrlFor, robotsTxt, seoTags, sitemapXml } from '@detent/awa-server';
import { newSection, type Page } from '@detent/awa-cms';
import { PLAN_CATALOGUE, money } from '@detent/awa-billing';

/**
 * What a crawler is told.
 *
 * Two rules run through these. Structured data must describe what is actually
 * on the page, because claiming a price or a question the page does not show
 * is a manual action waiting to happen. And a page has one canonical address
 * whatever hostname served it, because the app answers on its platform
 * hostname as well as its custom domain.
 */

const page = (over: Partial<Page> = {}): Page => ({
  pageId: 'pg_1', slug: 'home', title: 'Detent, the assistant that answers',
  description: 'Answers your visitors from your own approved knowledge.',
  state: 'published', sections: [],
  createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'test',
  updatedAt: '2026-03-04T00:00:00.000Z', updatedBy: 'test',
  ...over,
} as Page);

const plans = [{
  planCode: 'answers', name: 'Answers', version: 1, currency: 'GBP' as const,
  platformFee: { monthly: money(999), annual: money(9_990) },
  activationFee: money(0), includedCreditsPence: 500, outcomeFee: money(50),
  outcomeBasis: 'assistant_reply' as const,
  usageRates: PLAN_CATALOGUE.answers.usageRates,
  connectorEntitlement: PLAN_CATALOGUE.answers.connectorEntitlement,
  defaultSpendCapPence: 10_000, maxConcurrentVoice: 1, selfServiceAvailable: true,
}] as never;

const tags = (over: Partial<Page> = {}, extra: Record<string, unknown> = {}) => seoTags({
  page: page(over), canonicalOrigin: 'https://www.detent.co.uk', siteName: 'Detent',
  plans, appBaseUrl: 'https://www.detent.co.uk/app',
  imageUrl: 'https://www.detent.co.uk/og-image.png', ...extra,
});

describe('one address per page', () => {
  it('makes the home page the site root, not /home', () => {
    // Two addresses for one page is the commonest duplicate-content fault
    // there is, and it is self-inflicted.
    expect(canonicalUrlFor(page(), 'https://www.detent.co.uk')).toBe('https://www.detent.co.uk/');
    expect(canonicalUrlFor(page({ slug: 'become-a-reseller' }), 'https://www.detent.co.uk'))
      .toBe('https://www.detent.co.uk/become-a-reseller');
  });

  it('points a copy at the original rather than competing with it', () => {
    // Served on the platform hostname, the page still names the custom domain
    // as the original.
    expect(tags()).toContain('<link rel="canonical" href="https://www.detent.co.uk/">');
  });

  it('asks not to be indexed at all when it is not the canonical copy', () => {
    expect(tags({}, { noindex: true })).toContain('content="noindex,nofollow"');
    // And says nothing structured about a page it does not want listed.
    expect(tags({}, { noindex: true })).not.toContain('application/ld+json');
  });
});

describe('structured data describes the page it is on', () => {
  it('claims no prices when the page shows no pricing', () => {
    // A price in structured data that a visitor cannot find on the page is the
    // exact mismatch that gets structured data ignored, or penalised.
    expect(tags()).not.toContain('SoftwareApplication');
  });

  it('prices from the live catalogue when the page shows pricing', () => {
    const withPricing = tags({ sections: [newSection('pricing')] });
    expect(withPricing).toContain('SoftwareApplication');
    expect(withPricing).toContain('"price":"9.99"');
    expect(withPricing).toContain('"priceCurrency":"GBP"');
  });

  it('claims no questions when the page asks none', () => {
    expect(tags()).not.toContain('FAQPage');
  });

  it('lists only the questions the page actually answers', () => {
    const faq = {
      ...newSection('faq'),
      items: [
        { heading: 'What does it cost in a quiet month?', body: 'The subscription.' },
        { heading: 'No answer here', body: '' },
      ],
    };
    const html = tags({ sections: [faq] });
    expect(html).toContain('FAQPage');
    expect(html).toContain('What does it cost in a quiet month?');
    // An item with no answer is not a question a crawler should be shown.
    expect(html).not.toContain('No answer here');
  });

  it('cannot be broken out of by author copy', () => {
    // A closing script tag inside a page title would end the block early and
    // drop the rest of the page into it. Author copy reaches this.
    const html = tags({ title: 'Hostile </script><script>alert(1)</script>' });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script');
  });

  it('gives an inner page a breadcrumb and the home page none', () => {
    expect(tags({ slug: 'become-a-reseller' })).toContain('BreadcrumbList');
    expect(tags()).not.toContain('BreadcrumbList');
  });
});

describe('robots and sitemap', () => {
  it('keeps crawlers out of the signed-in areas and points at the sitemap', () => {
    const txt = robotsTxt('https://www.detent.co.uk', true);
    for (const path of ['/app/', '/console/', '/reseller/', '/v1/']) {
      expect(txt, path).toContain(`Disallow: ${path}`);
    }
    expect(txt).toContain('Sitemap: https://www.detent.co.uk/sitemap.xml');
  });

  it('refuses the whole site on a hostname that is not the canonical one', () => {
    const txt = robotsTxt('https://x.replit.app', false);
    expect(txt).toContain('Disallow: /');
    expect(txt).not.toContain('Sitemap:');
  });

  it('lists published pages only', () => {
    // Submitting a URL that answers 404 is a quality signal against the whole
    // site, so a draft has no business in a sitemap.
    const xml = sitemapXml([
      page(),
      page({ pageId: 'pg_2', slug: 'draft-page', state: 'draft' }),
      page({ pageId: 'pg_3', slug: 'become-a-reseller' }),
    ], 'https://www.detent.co.uk');

    expect(xml).toContain('<loc>https://www.detent.co.uk/</loc>');
    expect(xml).toContain('<loc>https://www.detent.co.uk/become-a-reseller</loc>');
    expect(xml).not.toContain('draft-page');
    expect(xml).toContain('<lastmod>2026-03-04</lastmod>');
  });
});

/**
 * What a search result and a shared link actually show.
 *
 * Both faults here were live and neither was visible from the source. The head
 * of every page declared /og-image.png, /favicon.svg and /apple-touch-icon.png,
 * and all three answered 404, because the site router owned every path that was
 * not under one of four directory prefixes and every root-level asset fell
 * outside it. A social preview with no image and a site with no favicon is most
 * of what an automated SEO check looks at, and it rated the site weak, twice.
 *
 * The meta description was 322 characters. Google shows about 160, so two
 * thirds of it was never read and the part that was said nothing about what
 * happens next.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { seedHomePage, seedResellerPage } from '../packages/server/src/marketing-seed.js';
import { InMemoryPageStore, PageService } from '../packages/cms/src/pages.js';

describe('what a search result shows', () => {
  /** Google truncates around here. Longer is not penalised, it is just unread. */
  const DESCRIPTION_LIMIT = 160;
  const TITLE_LIMIT = 60;

  async function seededPages(): Promise<PageService> {
    const pages = new PageService(new InMemoryPageStore());
    await seedHomePage(pages, '');
    await seedResellerPage(pages, '');
    return pages;
  }

  it('keeps every title inside what is displayed', async () => {
    for (const page of await (await seededPages()).list()) {
      expect(page.title.length, `${page.slug}: "${page.title}"`)
        .toBeLessThanOrEqual(TITLE_LIMIT);
      expect(page.title.length).toBeGreaterThan(20);
    }
  });

  it('keeps every description inside what is displayed', async () => {
    for (const page of await (await seededPages()).list()) {
      expect(page.description.length, `${page.slug}: ${page.description.length} characters`)
        .toBeLessThanOrEqual(DESCRIPTION_LIMIT);
      // A description shorter than this is a description a crawler ignores.
      expect(page.description.length).toBeGreaterThan(70);
    }
  });
});

describe('the files the head promises', () => {
  const PUBLIC = join('packages', 'server', 'public');

  it('exist on disk, all three of them', () => {
    for (const asset of ['og-image.png', 'favicon.svg', 'apple-touch-icon.png']) {
      expect(existsSync(join(PUBLIC, asset)), `${asset} is declared and missing`).toBe(true);
    }
  });

  it('is what seoTags actually asks for, so the two cannot drift', () => {
    const tags = seoTags({
      page: page(),
      canonicalOrigin: 'https://example.test',
      siteName: 'Detent',
      plans: [],
      appBaseUrl: 'https://example.test/app',
      imageUrl: 'https://example.test/og-image.png',
    });
    for (const asset of ['og-image.png', 'favicon.svg', 'apple-touch-icon.png']) {
      expect(tags, `${asset} is on disk but no longer referenced`).toContain(asset);
    }
  });
});
