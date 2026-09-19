/**
 * Money as integer minor units.
 *
 * There is no floating point anywhere in this package, and that is not
 * fastidiousness: `0.1 + 0.2 !== 0.3` is a rounding difference that becomes a
 * penny on an invoice, a penny becomes a reconciliation break, and a
 * reconciliation break becomes an afternoon nobody planned for. Amounts are
 * whole pence (or cents), currency travels with every amount, and arithmetic
 * across currencies throws rather than guessing a rate.
 *
 * The one place rounding is unavoidable — splitting an amount across periods or
 * lines — uses `allocate`, which distributes remainder pence deterministically
 * so the parts always sum exactly to the whole.
 */
export type CurrencyCode = 'GBP' | 'EUR' | 'USD';

export interface Money {
  /** Whole minor units. £12.34 is 1234. Never fractional, never negative-zero. */
  readonly amount: number;
  readonly currency: CurrencyCode;
}

export class CurrencyMismatchError extends Error {
  constructor(a: CurrencyCode, b: CurrencyCode) {
    super(`cannot combine ${a} and ${b}: no exchange rate is assumed in this system`);
    this.name = 'CurrencyMismatchError';
  }
}

export const CURRENCY_SYMBOLS: Readonly<Record<CurrencyCode, string>> = {
  GBP: '£', EUR: '€', USD: '$',
};

export function money(amount: number, currency: CurrencyCode = 'GBP'): Money {
  if (!Number.isInteger(amount)) {
    throw new Error(`money must be whole minor units, received ${amount}. Convert before constructing, not after.`);
  }
  return { amount, currency };
}

export const zero = (currency: CurrencyCode = 'GBP'): Money => money(0, currency);

function sameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amount + b.amount, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  sameCurrency(a, b);
  return money(a.amount - b.amount, a.currency);
}

export function sum(amounts: readonly Money[], currency: CurrencyCode = 'GBP'): Money {
  return amounts.reduce<Money>((total, item) => add(total, item), zero(currency));
}

export function negate(a: Money): Money {
  return money(-a.amount, a.currency);
}

export function isZero(a: Money): boolean { return a.amount === 0; }
export function isPositive(a: Money): boolean { return a.amount > 0; }
export function isNegative(a: Money): boolean { return a.amount < 0; }
export function compare(a: Money, b: Money): number {
  sameCurrency(a, b);
  return a.amount === b.amount ? 0 : a.amount < b.amount ? -1 : 1;
}
export const min = (a: Money, b: Money): Money => (compare(a, b) <= 0 ? a : b);
export const max = (a: Money, b: Money): Money => (compare(a, b) >= 0 ? a : b);

/**
 * Multiply by a whole quantity. Deliberately integer-only: a quantity of 2.5
 * conversations is a modelling error, and unit prices that need fractions are
 * expressed in smaller units (see `rateAtMillis`).
 */
export function multiply(a: Money, quantity: number): Money {
  if (!Number.isInteger(quantity)) {
    throw new Error(`quantity must be a whole number, received ${quantity}`);
  }
  return money(a.amount * quantity, a.currency);
}

/**
 * Rate in thousandths of a minor unit ("millis"), rounded half-up at the end.
 *
 * Unit economics genuinely need sub-penny rates — a text message costs 0.24p —
 * so rates are held as integers in millis and the rounding happens exactly once,
 * at the point an amount becomes chargeable. Rounding per unit and then summing
 * is how a thousand messages ends up 3p out.
 */
export function rateAtMillis(rateMillis: number, quantity: number, currency: CurrencyCode = 'GBP'): Money {
  if (!Number.isInteger(rateMillis)) throw new Error('a rate must be whole millis of a minor unit');
  const totalMillis = rateMillis * quantity;
  return money(roundHalfUp(totalMillis, 1000), currency);
}

/** Half-up away from zero, so -0.5 rounds to -1 and 0.5 to 1. Symmetric. */
export function roundHalfUp(numerator: number, denominator: number): number {
  const sign = numerator < 0 ? -1 : 1;
  return sign * Math.floor((Math.abs(numerator) + denominator / 2) / denominator);
}

/**
 * Percentage of an amount, in basis points, rounded half-up. Used for tax.
 * 2000 bps = 20%.
 */
export function percentage(a: Money, basisPoints: number): Money {
  return money(roundHalfUp(a.amount * basisPoints, 10_000), a.currency);
}

/**
 * Split an amount into parts by integer weights, distributing the remainder so
 * the parts sum **exactly** to the original.
 *
 * This is the only correct way to prorate. Multiplying by a fraction and
 * rounding each part independently loses or invents pence, and on a credit note
 * that is the difference between a clean reconciliation and a support ticket.
 */
export function allocate(a: Money, weights: readonly number[]): Money[] {
  if (weights.length === 0) throw new Error('allocate requires at least one weight');
  if (weights.some((weight) => weight < 0 || !Number.isInteger(weight))) {
    throw new Error('allocation weights must be non-negative integers');
  }
  const total = weights.reduce((acc, weight) => acc + weight, 0);
  if (total === 0) throw new Error('allocation weights must not sum to zero');

  const sign = a.amount < 0 ? -1 : 1;
  const magnitude = Math.abs(a.amount);
  const shares = weights.map((weight) => Math.floor((magnitude * weight) / total));
  let remainder = magnitude - shares.reduce((acc, share) => acc + share, 0);

  // Remainder pence go to the largest weights first, deterministically, so the
  // same inputs always produce the same split — which matters when an invoice
  // is regenerated.
  const order = weights
    .map((weight, index) => ({ weight, index }))
    .sort((x, y) => (y.weight - x.weight) || (x.index - y.index));

  for (const { index } of order) {
    if (remainder <= 0) break;
    shares[index] = shares[index]! + 1;
    remainder--;
  }

  return shares.map((share) => money(sign * share, a.currency));
}

/** Human-readable, for invoices and the console. Never used for arithmetic. */
export function format(a: Money): string {
  const sign = a.amount < 0 ? '-' : '';
  const magnitude = Math.abs(a.amount);
  const major = Math.floor(magnitude / 100);
  const minor = magnitude % 100;
  return `${sign}${CURRENCY_SYMBOLS[a.currency]}${major.toLocaleString('en-GB')}.${String(minor).padStart(2, '0')}`;
}

/** Parse "12.34" or "£12.34" into minor units. Rejects anything ambiguous. */
export function parseMoney(input: string, currency: CurrencyCode = 'GBP'): Money {
  const cleaned = input.trim().replace(/[£€$,\s]/g, '');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(`cannot parse "${input}" as an amount: expected a figure with at most two decimal places`);
  }
  const negative = cleaned.startsWith('-');
  const [major, minor = ''] = cleaned.replace('-', '').split('.');
  const amount = Number(major) * 100 + Number(minor.padEnd(2, '0'));
  return money(negative ? -amount : amount, currency);
}
