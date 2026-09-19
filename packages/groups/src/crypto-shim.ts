import { createHash } from 'node:crypto';
export { AwaError, systemClock } from '@detent/awa-core';
export type { Clock } from '@detent/awa-core';

/** Short deterministic id fragment. Not a security primitive. */
export function createHash_(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}
