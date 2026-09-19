import type { Page, Section } from '@detent/awa-cms';
import type { PlanVersion } from '@detent/awa-billing';

/**
 * What a search engine and a social card are told about a page.
 *
 * Two rules run through all of it.
 *
 * Everything here describes what is actually on the page. Structured data that
 * claims a price the page does not show, or questions it does not answer, is a
 * manual action waiting to happen, and the penalty costs more than the rich
 * result was ever worth.
 *
 * There is exactly one canonical address for a page, whatever hostname served
 * it. The app answers on its platform hostname as well as its custom domain,
 * which is duplicate content unless every copy points at the same original.
 */

export interface SeoInput {
  readonly page: Page;
  /** The address this page should be indexed under, without a trailing slash. */
  readonly canonicalOrigin: string;
  readonly siteName: string;
  readonly plans: readonly PlanVersion[];
  readonly appBaseUrl: string;
  /** Absolute URL of the sharing image. */
  readonly imageUrl?: string;
  readonly noindex?: boolean;
}

export function canonicalPathFor(page: Page): string {
  // The home page is the site root, not /home. Two addresses for one page is
  // the commonest duplicate-content fault there is, and it is self-inflicted.
  return page.slug === 'home' ? '/' : `/${page.slug}`;
}

export function canonicalUrlFor(page: Page, origin: string): string {
  const path = canonicalPathFor(page);
  return path === '/' ? `${origin}/` : `${origin}${path}`;
}

/** The head tags, as one block. */
export function seoTags(input: SeoInput): string {
  const url = canonicalUrlFor(input.page, input.canonicalOrigin);
  const title = input.page.title;
  const description = input.page.description;
  const image = input.imageUrl;

  const tags = [
    `<link rel="canonical" href="${escapeAttribute(url)}">`,
    input.noindex
      ? '<meta name="robots" content="noindex,nofollow">'
      // max-image-preview:large is what allows a large thumbnail in results,
      // and costs nothing to grant.
      : '<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">',
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${escapeAttribute(input.siteName)}">`,
    `<meta property="og:locale" content="en_GB">`,
    `<meta property="og:title" content="${escapeAttribute(title)}">`,
    `<meta property="og:description" content="${escapeAttribute(description)}">`,
    `<meta property="og:url" content="${escapeAttribute(url)}">`,
    image ? `<meta property="og:image" content="${escapeAttribute(image)}">` : '',
    image ? '<meta property="og:image:width" content="1200">' : '',
    image ? '<meta property="og:image:height" content="630">' : '',
    image
      ? `<meta property="og:image:alt" content="${escapeAttribute(input.siteName)}">`
      : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${escapeAttribute(title)}">`,
    `<meta name="twitter:description" content="${escapeAttribute(description)}">`,
    image ? `<meta name="twitter:image" content="${escapeAttribute(image)}">` : '',
    '<meta name="theme-color" content="#0F1B2A">',
    '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
    '<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
  ].filter(Boolean);

  return `${tags.join('\n')}\n${jsonLd(input, url)}`;
}

/**
 * The structured data, as one script per type.
 *
 * Separate blocks rather than a graph: a malformed one is then ignored on its
 * own instead of taking the others down with it.
 */
function jsonLd(input: SeoInput, url: string): string {
  if (input.noindex) return '';

  const blocks: unknown[] = [
    {
      '@context': 'https://schema.org',
      '@type': 'Organization',
      name: input.siteName,
      url: `${input.canonicalOrigin}/`,
      ...(input.imageUrl ? { logo: input.imageUrl } : {}),
      description: input.page.description,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      name: input.page.title,
      description: input.page.description,
      url,
      inLanguage: 'en-GB',
      isPartOf: {
        '@type': 'WebSite',
        name: input.siteName,
        url: `${input.canonicalOrigin}/`,
      },
    },
  ];

  const software = softwareApplication(input);
  if (software) blocks.push(software);

  const faq = faqPage(input.page);
  if (faq) blocks.push(faq);

  const crumbs = breadcrumbs(input, url);
  if (crumbs) blocks.push(crumbs);

  return blocks
    .map((block) =>
      `<script type="application/ld+json">${safeJson(block)}</script>`)
    .join('\n');
}

/**
 * The product, priced from the live catalogue.
 *
 * Only emitted where the page actually shows a pricing section. A price in
 * structured data that a visitor cannot find on the page is the exact
 * mismatch that gets structured data ignored, or penalised.
 */
function softwareApplication(input: SeoInput): unknown | undefined {
  const showsPricing = input.page.sections.some((section) => section.kind === 'pricing');
  if (!showsPricing || input.plans.length === 0) return undefined;

  const offers = input.plans
    .filter((plan) => plan.selfServiceAvailable !== false)
    .map((plan) => ({
      '@type': 'Offer',
      name: plan.name,
      price: (plan.platformFee.monthly.amount / 100).toFixed(2),
      priceCurrency: plan.currency,
      // Stated rather than implied, because "9.99" alone does not say per what.
      priceSpecification: {
        '@type': 'UnitPriceSpecification',
        price: (plan.platformFee.monthly.amount / 100).toFixed(2),
        priceCurrency: plan.currency,
        billingIncrement: 1,
        unitCode: 'MON',
      },
      availability: 'https://schema.org/InStock',
      url: `${input.appBaseUrl}/signup`,
    }));

  if (offers.length === 0) return undefined;

  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: input.siteName,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: input.page.description,
    url: `${input.canonicalOrigin}/`,
    offers,
  };
}

/**
 * The questions this page answers, and only those.
 *
 * Google requires the answer to be visible on the page. Taking them from the
 * rendered sections rather than a separate list is what keeps that true when
 * somebody edits the page in the console and forgets this exists.
 */
function faqPage(page: Page): unknown | undefined {
  const questions = page.sections
    .filter((section: Section) => section.kind === 'faq')
    .flatMap((section) => section.items)
    .filter((item) => item.heading && item.body)
    .map((item) => ({
      '@type': 'Question',
      name: item.heading!,
      acceptedAnswer: { '@type': 'Answer', text: item.body! },
    }));

  if (questions.length === 0) return undefined;
  return { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: questions };
}

function breadcrumbs(input: SeoInput, url: string): unknown | undefined {
  if (canonicalPathFor(input.page) === '/') return undefined;
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${input.canonicalOrigin}/` },
      { '@type': 'ListItem', position: 2, name: input.page.title, item: url },
    ],
  };
}

/**
 * JSON for a script tag.
 *
 * `</script>` inside a string would close the block early and drop the rest of
 * the page into it, so the sequence is escaped. Author copy reaches this, and
 * author copy is the one place a closing tag can arrive by accident.
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * robots.txt.
 *
 * The signed-in areas are disallowed because they are of no use in a result
 * and every crawl of them is budget spent on a sign-in page. They are also
 * protected by their sessions: robots.txt is a request to well-behaved
 * crawlers, never a control.
 */
export function robotsTxt(origin: string, allowIndexing: boolean): string {
  if (!allowIndexing) {
    return ['User-agent: *', 'Disallow: /', '', '# Not the canonical site.'].join('\n');
  }
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /app/',
    'Disallow: /console/',
    'Disallow: /reseller/',
    'Disallow: /v1/',
    'Disallow: /widget/',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

/** The published pages, newest change first is irrelevant here: address order. */
export function sitemapXml(
  pages: readonly Page[],
  origin: string,
): string {
  const entries = pages
    // A draft or an archived page has no business in a sitemap: submitting a
    // URL that answers 404 is a quality signal against the whole site.
    .filter((page) => page.state === 'published')
    .map((page) => {
      const path = canonicalPathFor(page);
      const updated = (page.updatedAt ?? page.createdAt ?? '').slice(0, 10);
      return [
        '  <url>',
        `    <loc>${escapeAttribute(path === '/' ? `${origin}/` : `${origin}${path}`)}</loc>`,
        updated ? `    <lastmod>${updated}</lastmod>` : '',
        // The home page is the one worth crawling most often.
        `    <priority>${path === '/' ? '1.0' : '0.7'}</priority>`,
        '  </url>',
      ].filter(Boolean).join('\n');
    });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...entries,
    '</urlset>',
    '',
  ].join('\n');
}
