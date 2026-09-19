/**
 * Deterministic JSON canonicalisation.
 *
 * A hash chain is only tamper-evident if the same logical payload always
 * hashes to the same bytes. JSON.stringify does not guarantee that across
 * object construction orders, so keys are sorted and undefined is dropped
 * explicitly. Numbers are emitted in their shortest round-trip form, which is
 * what JavaScript's own number formatting gives us.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value);
}

function serialise(value: unknown): string {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'number') {
    if (!Number.isFinite(value as number)) throw new Error('cannot canonicalise non-finite number');
    return JSON.stringify(value);
  }
  if (type === 'boolean' || type === 'string') return JSON.stringify(value);
  if (type === 'undefined' || type === 'function' || type === 'symbol') return 'null';
  if (Array.isArray(value)) return `[${value.map(serialise).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialise(v)}`).join(',')}}`;
}
