import { AwaError } from '@detent/awa-core';

/**
 * Exclusive territories, held as UK postcode areas.
 *
 * A reseller is given an area and is the only one who may sell into it. That
 * exclusivity is the reason they invest, so it has to be enforced rather than
 * promised: granting an area already held is refused, not recorded and
 * discovered later by two resellers pitching the same buyer.
 *
 * The unit is the postcode *area*: the letters at the front, so 'M' for
 * Manchester, 'EH' for Edinburgh, not the full postcode. A territory
 * described down to 'M1 4BT' is a street, and no reseller can build a business
 * on a street. It also means a lead arriving with a full postcode can be
 * matched by taking its area.
 */

/** 'm1 4bt' -> 'M', 'EH12 9DN' -> 'EH', 'W1A 1AA' -> 'W'. */
export function postcodeArea(postcode: string): string | undefined {
  const cleaned = postcode.trim().toUpperCase().replace(/\s+/g, '');
  const match = /^([A-Z]{1,2})[0-9]/.exec(cleaned);
  return match?.[1];
}

/** Accepts an area on its own, or extracts one from a full postcode. */
export function normaliseArea(input: string): string | undefined {
  const cleaned = input.trim().toUpperCase().replace(/\s+/g, '');
  if (/^[A-Z]{1,2}$/.test(cleaned)) return cleaned;
  return postcodeArea(cleaned);
}

export interface Territory {
  readonly area: string;
  readonly resellerId: string;
  readonly grantedAt: string;
  readonly grantedBy: string;
}

/**
 * Where granted territories are kept.
 *
 * Exclusivity is the reason a reseller invests, so where this is backed by a
 * database the area is the primary key and the guarantee is the database's
 * rather than the application's.
 */
export interface TerritoryStore {
  get(area: string): Promise<Territory | undefined>;
  put(territory: Territory): Promise<void>;
  delete(area: string): Promise<void>;
  all(): Promise<readonly Territory[]>;
}

export class InMemoryTerritoryStore implements TerritoryStore {
  private readonly byArea = new Map<string, Territory>();
  async get(area: string): Promise<Territory | undefined> { return this.byArea.get(area); }
  async put(territory: Territory): Promise<void> { this.byArea.set(territory.area, territory); }
  async delete(area: string): Promise<void> { this.byArea.delete(area); }
  async all(): Promise<readonly Territory[]> {
    return [...this.byArea.values()].sort((left, right) => left.area.localeCompare(right.area));
  }
}

export class TerritoryRegistry {
  constructor(private readonly store: TerritoryStore = new InMemoryTerritoryStore()) {}

  /**
   * Grants an area exclusively.
   *
   * Refuses an area somebody else already holds. The alternative, recording
   * it and sorting it out later, means two resellers have both been promised
   * exclusivity in writing, and one of those promises has to be broken.
   */
  async grant(input: {
    readonly area: string;
    readonly resellerId: string;
    readonly grantedBy: string;
    readonly at: string;
  }): Promise<Territory> {
    const area = normaliseArea(input.area);
    if (!area) {
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: `'${input.area}' is not a postcode area. Use the letters, such as M or EH.`,
      });
    }
    const held = await this.store.get(area);
    if (held && held.resellerId !== input.resellerId) {
      throw new AwaError({
        kind: 'CONFLICT',
        message:
          `${area} is already held exclusively by another reseller. Withdraw it from them `
          + 'first if it is genuinely being reassigned.',
      });
    }
    const territory: Territory = {
      area, resellerId: input.resellerId, grantedAt: input.at, grantedBy: input.grantedBy,
    };
    await this.store.put(territory);
    return territory;
  }

  async withdraw(area: string): Promise<void> {
    const normalised = normaliseArea(area);
    if (normalised) await this.store.delete(normalised);
  }

  /** Every area a reseller holds, alphabetically. */
  async heldBy(resellerId: string): Promise<readonly string[]> {
    return (await this.store.all())
      .filter((territory) => territory.resellerId === resellerId)
      .map((territory) => territory.area)
      .sort();
  }

  async holderOf(area: string): Promise<Territory | undefined> {
    const normalised = normaliseArea(area);
    return normalised ? this.store.get(normalised) : undefined;
  }

  async all(): Promise<readonly Territory[]> {
    return this.store.all();
  }

  /**
   * Which reseller a lead belongs to, from the lead's postcode.
   *
   * A lead with no postcode, or one in an unheld area, belongs to nobody and
   * is worked directly. Assigning it to the nearest reseller would be a guess
   * with somebody's commission attached.
   */
  async resellerForPostcode(postcode: string | undefined): Promise<string | undefined> {
    if (!postcode) return undefined;
    const area = postcodeArea(postcode);
    return area ? (await this.store.get(area))?.resellerId : undefined;
  }
}
