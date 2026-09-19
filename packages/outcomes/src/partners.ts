import type { TenantConfig } from '@detent/awa-core';

/**
 * Partner routing with a multi-entity aware registry (FR-048).
 *
 * A group with several trading entities routes to the right one; a reseller
 * network routes to the right partner. The selection is deterministic and
 * criteria-based rather than model-chosen, because "which legal entity does
 * this prospect belong to" is a commercial and often a contractual question,
 * not a language one.
 */
export interface PartnerCandidate {
  readonly id: string;
  readonly name: string;
  readonly entityRef?: string;
  readonly criteria: string;
}

export interface PartnerSelectionInput {
  readonly config: TenantConfig;
  /** Signals the routing criteria are matched against. */
  readonly signals: Readonly<Record<string, string | number | undefined>>;
}

export interface PartnerSelection {
  readonly partner?: PartnerCandidate;
  readonly reason: string;
}

/**
 * Criteria are simple `key=value` or `key>value` expressions joined by `and`,
 * e.g. `country=IE and seats>50`. Deliberately not a general expression
 * language: a routing rule a sales leader cannot read in one pass is a routing
 * rule nobody will notice is wrong.
 */
export function selectPartner(input: PartnerSelectionInput): PartnerSelection {
  const partners = input.config.outcomes.partners ?? [];
  if (partners.length === 0) return { reason: 'no partners registered for this tenant' };

  for (const partner of partners) {
    if (matches(partner.criteria, input.signals)) {
      return { partner, reason: `matched criteria: ${partner.criteria}` };
    }
  }
  return { reason: 'no partner criteria matched; route to the tenant directly' };
}

function matches(criteria: string, signals: Readonly<Record<string, string | number | undefined>>): boolean {
  const clauses = criteria.split(/\s+and\s+/i).map((clause) => clause.trim()).filter(Boolean);
  if (clauses.length === 0) return false;

  return clauses.every((clause) => {
    const comparison = /^([a-z_][a-z0-9_]*)\s*(=|>|<|>=|<=)\s*(.+)$/i.exec(clause);
    if (!comparison) return false;
    const [, key, operator, rawValue] = comparison;
    const actual = signals[key!.toLowerCase()];
    if (actual === undefined) return false;

    const expected = rawValue!.trim();
    if (operator === '=') return String(actual).toLowerCase() === expected.toLowerCase();

    const left = Number(actual);
    const right = Number(expected);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    switch (operator) {
      case '>': return left > right;
      case '<': return left < right;
      case '>=': return left >= right;
      case '<=': return left <= right;
      default: return false;
    }
  });
}
