import { AwaError } from '@detent/awa-core';
import type { Money } from '@detent/awa-billing';

/**
 * Commission that rises with volume.
 *
 * A reseller earns between 20% and 50% depending on what they have sold. The
 * band is decided by the volume they have already built, not by the size of
 * the individual invoice: a reseller with a large book should not drop back
 * to the entry rate because one customer's month was quiet.
 *
 * The rate applies to the whole of the period's revenue once a band is
 * reached, rather than only to the revenue above the threshold. That is the
 * simpler promise to make and the one a reseller will assume you meant; the
 * alternative is defensible but has to be explained every month.
 */

export interface CommissionBand {
  /** Inclusive lower bound of annualised book value, in minor units. */
  readonly fromAmount: number;
  readonly basisPoints: number;
  readonly label: string;
}

/**
 * The published programme.
 *
 * Held here as the default, and overridable per reseller for a negotiated
 * deal: the same discipline as the plan catalogue, where a published price
 * is a starting point rather than a promise that nobody may ever differ from.
 */
export const DEFAULT_COMMISSION_BANDS: readonly CommissionBand[] = [
  { fromAmount: 0, basisPoints: 2000, label: 'Registered' },
  { fromAmount: 2_500_00, basisPoints: 3000, label: 'Silver' },
  { fromAmount: 10_000_00, basisPoints: 4000, label: 'Gold' },
  { fromAmount: 25_000_00, basisPoints: 5000, label: 'Principal' },
];

export function assertBands(bands: readonly CommissionBand[]): void {
  if (bands.length === 0) {
    throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'A programme needs at least one band.' });
  }
  if (bands[0]!.fromAmount !== 0) {
    // Without a band starting at zero, a new reseller's first sale falls
    // through every band and earns nothing.
    throw new AwaError({
      kind: 'SCHEMA_INVALID',
      message: 'The first band must start at zero, or a new reseller earns nothing.',
    });
  }
  for (let index = 1; index < bands.length; index += 1) {
    if (bands[index]!.fromAmount <= bands[index - 1]!.fromAmount) {
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: 'Bands must be in ascending order of volume.',
      });
    }
  }
}

/** The band a given volume falls in. */
export function bandFor(
  volume: Money,
  bands: readonly CommissionBand[] = DEFAULT_COMMISSION_BANDS,
): CommissionBand {
  assertBands(bands);
  let found = bands[0]!;
  for (const band of bands) {
    if (volume.amount >= band.fromAmount) found = band;
  }
  return found;
}

/** What the next band would pay, and what it takes to reach it. */
export function nextBand(
  volume: Money,
  bands: readonly CommissionBand[] = DEFAULT_COMMISSION_BANDS,
): { readonly band: CommissionBand; readonly shortfall: number } | undefined {
  const above = bands.filter((band) => band.fromAmount > volume.amount)
    .sort((left, right) => left.fromAmount - right.fromAmount);
  const next = above[0];
  return next ? { band: next, shortfall: next.fromAmount - volume.amount } : undefined;
}
