import { AwaError, newId, systemClock, type Clock } from '@detent/awa-core';
import { assertBands, type CommissionBand } from './bands.js';

/**
 * Resellers: the channel that sells Detent to an end customer and takes a
 * margin on what that customer spends.
 *
 * A reseller is not the customer. The end customer holds the account, the
 * tenant and the subscription; the reseller holds the commercial relationship
 * and is paid out of it. Modelling the reseller as a kind of customer would
 * make every query about revenue ambiguous, whose revenue, and that
 * ambiguity is how channel businesses end up unable to say what they actually
 * earned.
 */

export type ResellerStatus =
  /** Selling. Commission accrues. */
  | 'active'
  /** No new business, but existing customers still earn commission. */
  | 'closed_to_new'
  /** Ended. Nothing accrues after the end date. */
  | 'terminated';

export interface Reseller {
  readonly resellerId: string;
  readonly name: string;
  /** Where the commission statement goes. */
  readonly contactEmail: string;
  readonly contactName?: string;
  readonly status: ResellerStatus;
  /**
   * The reseller's margin, in basis points: 1500 is 15%.
   *
   * Basis points rather than a percentage float. A margin of 12.5% held as
   * 0.125 and multiplied through thousands of invoices accumulates error that
   * shows up as a commission statement disagreeing with the reseller's own
   * arithmetic by a few pence: an argument that costs more to have than the
   * money in dispute.
   */
  readonly marginBasisPoints: number;
  /**
   * Whether this reseller earns on the volume programme rather than a flat rate.
   *
   * True for the published programme, where the rate rises from 20% to 50%
   * with the size of their book. False for a reseller on individually
   * negotiated terms, whose rate is `marginBasisPoints` whatever they sell.
   */
  readonly banded?: boolean;
  /** A negotiated band table, where the published one does not apply. */
  readonly bands?: readonly CommissionBand[];
  /** Company number, VAT number and so on, for the self-bill invoice. */
  readonly companyNumber?: string;
  readonly vatNumber?: string;
  readonly agreementStart: string;
  readonly agreementEnd?: string;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly notes?: string;
}

/** 100%: a margin above this pays out more than the customer paid in. */
const MAX_BASIS_POINTS = 10_000;

export interface CreateResellerInput {
  readonly name: string;
  readonly contactEmail: string;
  readonly contactName?: string;
  readonly marginBasisPoints: number;
  /**
   * Whether this reseller earns on the volume programme rather than a flat rate.
   *
   * True for the published programme, where the rate rises from 20% to 50%
   * with the size of their book. False for a reseller on individually
   * negotiated terms, whose rate is `marginBasisPoints` whatever they sell.
   */
  readonly banded?: boolean;
  /** A negotiated band table, where the published one does not apply. */
  readonly bands?: readonly CommissionBand[];
  readonly agreementStart: string;
  readonly companyNumber?: string;
  readonly vatNumber?: string;
  readonly createdBy: string;
  readonly notes?: string;
}

/**
 * Which reseller an end customer belongs to, and on what terms.
 *
 * The margin is recorded on the link and not only on the reseller, because a
 * reseller who negotiates a better rate should not have that rate applied
 * retrospectively to customers sold under the old one. An unset margin here
 * means "whatever the reseller's standard rate is"; a set one overrides it and
 * keeps overriding it.
 */
export interface AccountLink {
  readonly accountId: string;
  readonly resellerId: string;
  /** Overrides the reseller's standard margin for this customer alone. */
  readonly marginBasisPoints?: number;
  /** When the customer started earning commission for this reseller. */
  readonly since: string;
  /** Set when the customer moves to another reseller or goes direct. */
  readonly until?: string;
  readonly linkedBy: string;
}

export function assertBasisPoints(value: number, field = 'margin'): void {
  if (!Number.isInteger(value)) {
    throw new AwaError({
      kind: 'SCHEMA_INVALID',
      message: `A ${field} is whole basis points: 1500 for 15%.`,
    });
  }
  if (value < 0 || value > MAX_BASIS_POINTS) {
    throw new AwaError({
      kind: 'SCHEMA_INVALID',
      message: `A ${field} must be between 0 and 100% (0 and ${MAX_BASIS_POINTS} basis points).`,
    });
  }
}

/**
 * Where resellers and their customer links are kept.
 *
 * An interface rather than a Map on the service, so the same service runs
 * against memory on a laptop and against Postgres in production. Commission is
 * money owed to a third party; losing the record of who held which customer
 * loses the basis for paying it.
 */
export interface ResellerStore {
  get(resellerId: string): Promise<Reseller | undefined>;
  byContactEmail(email: string): Promise<Reseller | undefined>;
  put(reseller: Reseller): Promise<void>;
  list(): Promise<readonly Reseller[]>;
  /** Every link for one account, oldest first, open and closed. */
  linksForAccount(accountId: string): Promise<readonly AccountLink[]>;
  /** Every link a reseller has ever held. */
  linksForReseller(resellerId: string): Promise<readonly AccountLink[]>;
  /** Replaces one account's links wholesale, within a transaction. */
  replaceLinksForAccount(accountId: string, links: readonly AccountLink[]): Promise<void>;
}

export class InMemoryResellerStore implements ResellerStore {
  private readonly resellers = new Map<string, Reseller>();
  private readonly links = new Map<string, AccountLink[]>();

  async get(resellerId: string): Promise<Reseller | undefined> {
    return this.resellers.get(resellerId);
  }
  async byContactEmail(email: string): Promise<Reseller | undefined> {
    const wanted = email.trim().toLowerCase();
    return [...this.resellers.values()].find((one) => one.contactEmail === wanted);
  }
  async put(reseller: Reseller): Promise<void> {
    this.resellers.set(reseller.resellerId, reseller);
  }
  async list(): Promise<readonly Reseller[]> {
    return [...this.resellers.values()].sort((left, right) => left.name.localeCompare(right.name));
  }
  async linksForAccount(accountId: string): Promise<readonly AccountLink[]> {
    return [...(this.links.get(accountId) ?? [])];
  }
  async linksForReseller(resellerId: string): Promise<readonly AccountLink[]> {
    return [...this.links.values()].flat().filter((one) => one.resellerId === resellerId);
  }
  async replaceLinksForAccount(accountId: string, links: readonly AccountLink[]): Promise<void> {
    this.links.set(accountId, [...links]);
  }
}

export class ResellerService {
  constructor(
    private readonly store: ResellerStore = new InMemoryResellerStore(),
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: CreateResellerInput): Promise<Reseller> {
    const name = input.name.trim();
    if (name.length === 0) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'Give the reseller a name.' });
    }
    const contactEmail = input.contactEmail.trim().toLowerCase();
    if (!contactEmail.includes('@')) {
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: 'A reseller needs an email address for their commission statement.',
      });
    }
    assertBasisPoints(input.marginBasisPoints);
    if (input.bands) assertBands(input.bands);

    const reseller: Reseller = {
      resellerId: newId('rsl', this.clock.nowMs()),
      name,
      contactEmail,
      contactName: input.contactName?.trim() || undefined,
      status: 'active',
      marginBasisPoints: input.marginBasisPoints,
      banded: input.banded ?? true,
      bands: input.bands,
      companyNumber: input.companyNumber?.trim() || undefined,
      vatNumber: input.vatNumber?.trim() || undefined,
      agreementStart: input.agreementStart,
      createdAt: new Date(this.clock.nowMs()).toISOString(),
      createdBy: input.createdBy,
      notes: input.notes?.trim() || undefined,
    };
    await this.store.put(reseller);
    return reseller;
  }

  async get(resellerId: string): Promise<Reseller> {
    const reseller = await this.store.get(resellerId);
    if (!reseller) throw new AwaError({ kind: 'NOT_FOUND', message: 'No such reseller.' });
    return reseller;
  }

  async byContactEmail(email: string): Promise<Reseller | undefined> {
    return this.store.byContactEmail(email);
  }

  async list(): Promise<readonly Reseller[]> {
    return this.store.list();
  }

  async update(
    resellerId: string,
    changes: Partial<Pick<Reseller,
      'name' | 'contactEmail' | 'contactName' | 'status' | 'marginBasisPoints'
      | 'companyNumber' | 'vatNumber' | 'agreementEnd' | 'notes' | 'banded' | 'bands'>>,
  ): Promise<Reseller> {
    const current = await this.get(resellerId);
    if (changes.marginBasisPoints !== undefined) {
      assertBasisPoints(changes.marginBasisPoints);
    }
    if (changes.bands) assertBands(changes.bands);
    const updated: Reseller = { ...current, ...changes };
    await this.store.put(updated);
    return updated;
  }

  /**
   * Records that an end customer belongs to a reseller.
   *
   * Linking a customer who already belongs to someone closes the previous link
   * rather than replacing it. Commission already earned under the old
   * arrangement stays earned: a customer moving between resellers must not
   * silently reassign a year of history to whoever holds them today.
   */
  async linkAccount(input: {
    readonly accountId: string;
    readonly resellerId: string;
    readonly marginBasisPoints?: number;
    readonly linkedBy: string;
    readonly since?: string;
  }): Promise<AccountLink> {
    await this.get(input.resellerId);
    if (input.marginBasisPoints !== undefined) {
      assertBasisPoints(input.marginBasisPoints, 'override margin');
    }

    const at = input.since ?? new Date(this.clock.nowMs()).toISOString();
    const history = await this.store.linksForAccount(input.accountId);
    const closed = history.map((link) => (link.until ? link : { ...link, until: at }));

    const link: AccountLink = {
      accountId: input.accountId,
      resellerId: input.resellerId,
      marginBasisPoints: input.marginBasisPoints,
      since: at,
      linkedBy: input.linkedBy,
    };
    await this.store.replaceLinksForAccount(input.accountId, [...closed, link]);
    return link;
  }

  /** Ends a customer's link without giving them to anyone else. */
  async unlinkAccount(accountId: string, at?: string): Promise<void> {
    const when = at ?? new Date(this.clock.nowMs()).toISOString();
    const history = await this.store.linksForAccount(accountId);
    if (history.length === 0) return;
    await this.store.replaceLinksForAccount(
      accountId,
      history.map((link) => (link.until ? link : { ...link, until: when })),
    );
  }

  /** The reseller a customer belongs to now, if any. */
  async linkFor(accountId: string): Promise<AccountLink | undefined> {
    return (await this.store.linksForAccount(accountId)).find((link) => !link.until);
  }

  /** Every link a customer has ever had, oldest first. */
  async linkHistory(accountId: string): Promise<readonly AccountLink[]> {
    return this.store.linksForAccount(accountId);
  }

  /** The customers a reseller holds now. */
  async accountsFor(resellerId: string): Promise<readonly AccountLink[]> {
    return (await this.store.linksForReseller(resellerId)).filter((link) => !link.until);
  }

  /**
   * Every link a reseller has held, open or closed.
   *
   * Commission for a past period has to be worked out from who held the
   * customer then, not from who holds them now.
   */
  async allLinksFor(resellerId: string): Promise<readonly AccountLink[]> {
    return this.store.linksForReseller(resellerId);
  }

  /** The margin that applies to a customer: their override, or the standard. */
  async marginFor(accountId: string): Promise<number | undefined> {
    const link = await this.linkFor(accountId);
    if (!link) return undefined;
    if (link.marginBasisPoints !== undefined) return link.marginBasisPoints;
    return (await this.get(link.resellerId)).marginBasisPoints;
  }
}
