import type { PriceListEntry, TenantConfig } from '@detent/awa-core';

/**
 * Price and discount authority (section 13.4, table 16).
 *
 * The assistant may state what the tenant has published, verbatim, with the
 * conditions attached to it. It may not construct a price, apply a discount,
 * or infer a figure from a range. Every path that is not "state an approved
 * value" ends in a human.
 */
export type PriceOutcome =
  | { readonly kind: 'STATE_PRICE'; readonly entry: PriceListEntry; readonly statement: string }
  | { readonly kind: 'STATE_RANGE'; readonly entry: PriceListEntry; readonly statement: string }
  | { readonly kind: 'QUOTE_ON_SCOPE'; readonly statement: string }
  | { readonly kind: 'ROUTE_TO_HUMAN'; readonly reason: 'discount_requested' | 'custom_quote' | 'off_list'; readonly statement: string };

export interface PriceRequest {
  readonly sku?: string;
  readonly discountRequested?: boolean;
  readonly customScopeRequested?: boolean;
}

const money = (amount: number, currency: string): string => {
  const symbol = currency === 'GBP' ? '£' : currency === 'USD' ? '$' : currency === 'EUR' ? '€' : `${currency} `;
  const formatted = amount % 1 === 0 ? amount.toLocaleString('en-GB') : amount.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${symbol}${formatted}`;
};

export function evaluatePriceAuthority(config: TenantConfig, request: PriceRequest): PriceOutcome {
  // A discount request is never a pricing question. It is a routing question.
  if (request.discountRequested) {
    return {
      kind: 'ROUTE_TO_HUMAN',
      reason: 'discount_requested',
      statement: 'I am not able to offer a discount myself. I will pass your request to the team with the detail you have given me.',
    };
  }

  if (request.customScopeRequested) {
    return {
      kind: 'ROUTE_TO_HUMAN',
      reason: 'custom_quote',
      statement: 'That needs a tailored quote. I will capture the requirements and the team will come back to you.',
    };
  }

  if (config.priceList.length === 0) {
    return {
      kind: 'QUOTE_ON_SCOPE',
      statement: 'Pricing is quoted on scope rather than published. I can set up a short call to get you a figure.',
    };
  }

  const entry = request.sku ? config.priceList.find((e) => e.sku === request.sku) : undefined;
  if (!entry) {
    return {
      kind: 'ROUTE_TO_HUMAN',
      reason: 'off_list',
      statement: 'I do not have an approved price for that. Let me get someone to confirm it properly rather than guess.',
    };
  }

  const conditions = entry.conditions.length > 0 ? ` ${entry.conditions.join(' ')}` : '';

  if (entry.price) {
    return {
      kind: 'STATE_PRICE',
      entry,
      statement: `${entry.label} is ${money(entry.price.amount, entry.price.currency)} ${entry.price.unit}.${conditions}`,
    };
  }

  if (entry.range) {
    const drivers = entry.rangeDrivers?.length
      ? ` What moves it within that range: ${entry.rangeDrivers.join(', ')}.`
      : '';
    return {
      kind: 'STATE_RANGE',
      entry,
      statement: `${entry.label} runs from ${money(entry.range.min, entry.range.currency)} to ${money(entry.range.max, entry.range.currency)} ${entry.range.unit}.${drivers}${conditions}`,
    };
  }

  // A catalogue entry with neither a price nor a range is a tenant
  // configuration error. It fails to a human, never to an invented figure.
  return {
    kind: 'ROUTE_TO_HUMAN',
    reason: 'off_list',
    statement: 'I do not have a confirmed figure for that. I will get someone to send you one.',
  };
}

/** Every numeric figure the assistant is permitted to utter, for output validation. */
export function approvedFigures(config: TenantConfig): Set<number> {
  const figures = new Set<number>();
  for (const entry of config.priceList) {
    if (entry.price) figures.add(entry.price.amount);
    if (entry.range) { figures.add(entry.range.min); figures.add(entry.range.max); }
  }
  return figures;
}
