import type { Approvable, Provenance } from '@detent/awa-core';
import { draft } from '@detent/awa-core';
import type { FetchedPage } from './crawler.js';

/**
 * Structured extraction into typed schemas (section 38.3 step 2).
 *
 * "Every claim carries source URL + confidence." That is not decoration: the
 * source URL is what the tenant reads at review, and the confidence is what
 * decides whether an item is offered for approval at all or excluded by default.
 *
 * The extractor is a port. The reference implementation here is deterministic
 * pattern extraction, which is honest about what it can find — prices, services,
 * explicit claims — and does not pretend to understand prose. A model-backed
 * extractor implements the same interface and produces the same typed output
 * with the same provenance, and is subject to the same approval gate, so the
 * governance properties do not depend on which one is running.
 */
export interface ExtractedService {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
}

export interface ExtractedPrice {
  readonly sku: string;
  readonly label: string;
  readonly amount?: number;
  readonly rangeMin?: number;
  readonly rangeMax?: number;
  readonly currency: string;
  readonly unit: string;
  readonly conditions: readonly string[];
}

export interface ExtractedClaim {
  readonly claim: string;
}

export interface ExtractionResult {
  readonly services: readonly Approvable<ExtractedService>[];
  readonly prices: readonly Approvable<ExtractedPrice>[];
  readonly claims: readonly Approvable<ExtractedClaim>[];
}

export interface Extractor {
  extract(pages: readonly FetchedPage[]): Promise<ExtractionResult>;
}

const CURRENCY_SYMBOLS: Record<string, string> = { '£': 'GBP', '$': 'USD', '€': 'EUR' };

// "£4,500 per engagement", "from £12,000 to £45,000 per programme"
const RANGE_RE = /(?:from\s+)?([£$€])\s?([\d,]+(?:\.\d{2})?)\s*(?:to|–|-|—)\s*[£$€]?\s?([\d,]+(?:\.\d{2})?)\s*((?:per|a|each)\s+[a-z ]{2,24})?/gi;
const PRICE_RE = /([£$€])\s?([\d,]+(?:\.\d{2})?)\s*((?:per|a|each)\s+[a-z ]{2,24})?/gi;

const CLAIM_MARKERS = [
  /\bwe (?:have|deliver|provide|help|work with|specialise in|recover)\b/i,
  /\b(?:our|the) (?:clients?|customers?)\b/i,
  /\b(?:iso ?27001|soc ?2|cyber essentials|accredited|certified)\b/i,
  /\b\d+(?:,\d{3})*\+? (?:clients?|customers?|organisations?|contracts?)\b/i,
];

const money = (raw: string): number => Number(raw.replace(/,/g, ''));

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'item';
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 25 && s.length < 320);
}

/**
 * Confidence heuristics, stated openly because they decide what a tenant is
 * asked to approve. A price on a page whose URL or title says "pricing" is
 * far more likely to be a real published price than the same string in a blog
 * post, so it scores higher and is offered for approval; the blog-post figure
 * falls below the threshold and is excluded by default.
 */
function pageWeight(page: FetchedPage, kind: 'price' | 'service' | 'claim'): number {
  const signal = `${page.url} ${page.title}`.toLowerCase();
  if (kind === 'price') {
    if (/pricing|price|plans|packages|fees|rates/.test(signal)) return 0.92;
    if (/services|solutions|products/.test(signal)) return 0.74;
    return 0.45;
  }
  if (kind === 'service') {
    if (/services|solutions|what-we-do|products|capabilities/.test(signal)) return 0.88;
    if (/pricing|plans/.test(signal)) return 0.78;
    return 0.5;
  }
  if (/about|why|clients|customers|case-stud|credentials/.test(signal)) return 0.8;
  return 0.62;
}

export class PatternExtractor implements Extractor {
  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  async extract(pages: readonly FetchedPage[]): Promise<ExtractionResult> {
    const services: Approvable<ExtractedService>[] = [];
    const prices: Approvable<ExtractedPrice>[] = [];
    const claims: Approvable<ExtractedClaim>[] = [];
    const seenSkus = new Set<string>();
    const seenServices = new Set<string>();
    const seenClaims = new Set<string>();

    for (const page of pages) {
      const provenance = (confidence: number): Provenance => ({
        sourceUrl: page.url,
        confidence: Math.round(confidence * 100) / 100,
        extractedAt: this.now(),
      });

      // --- prices. Ranges first: a range would otherwise yield two prices.
      const consumed: Array<[number, number]> = [];
      RANGE_RE.lastIndex = 0;
      for (const match of page.text.matchAll(RANGE_RE)) {
        const [full, symbol, min, max, unit] = match;
        if (!symbol || !min || !max) continue;
        consumed.push([match.index ?? 0, (match.index ?? 0) + full.length]);
        const label = page.title || 'Published range';
        const sku = slug(`${label}-range`);
        if (seenSkus.has(sku)) continue;
        seenSkus.add(sku);
        prices.push(draft<ExtractedPrice>({
          sku,
          label,
          rangeMin: money(min),
          rangeMax: money(max),
          currency: CURRENCY_SYMBOLS[symbol] ?? 'GBP',
          unit: unit?.trim() ?? '',
          conditions: [],
        }, provenance(pageWeight(page, 'price'))));
      }

      PRICE_RE.lastIndex = 0;
      for (const match of page.text.matchAll(PRICE_RE)) {
        const start = match.index ?? 0;
        if (consumed.some(([from, to]) => start >= from && start < to)) continue;
        const [, symbol, amount, unit] = match;
        if (!symbol || !amount) continue;
        const label = page.title || 'Published price';
        const sku = slug(label);
        if (seenSkus.has(sku)) continue;
        seenSkus.add(sku);
        prices.push(draft<ExtractedPrice>({
          sku,
          label,
          amount: money(amount),
          currency: CURRENCY_SYMBOLS[symbol] ?? 'GBP',
          unit: unit?.trim() ?? '',
          conditions: [],
        }, provenance(pageWeight(page, 'price'))));
      }

      // --- services, taken from the page identity rather than guessed from prose.
      if (/services|solutions|what-we-do|products|capabilities|pricing/.test(page.url.toLowerCase()) && page.title) {
        const id = slug(page.title);
        if (!seenServices.has(id)) {
          seenServices.add(id);
          services.push(draft<ExtractedService>({
            id,
            name: page.title,
            summary: sentences(page.text)[0] ?? page.title,
          }, provenance(pageWeight(page, 'service'))));
        }
      }

      // --- claims.
      for (const sentence of sentences(page.text)) {
        if (!CLAIM_MARKERS.some((marker) => marker.test(sentence))) continue;
        const key = sentence.toLowerCase();
        if (seenClaims.has(key)) continue;
        seenClaims.add(key);
        // A sentence containing a figure is a claim with a number in it, which
        // is the kind most damaging to get wrong, so it is scored lower and
        // more often lands below the approval threshold.
        const hasFigure = /\d/.test(sentence);
        claims.push(draft<ExtractedClaim>({ claim: sentence }, provenance(pageWeight(page, 'claim') - (hasFigure ? 0.15 : 0))));
      }
    }

    return { services, prices, claims };
  }
}
