import { AwaError, newId, type Clock, systemClock } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import { add, isPositive, money, subtract, sum, zero, type CurrencyCode, type Money } from './money.js';

/**
 * The credit ledger: lot-anchored, append-only, drawn down oldest-expiry first.
 *
 * Three properties, and each exists because of a specific way credit systems go
 * wrong:
 *
 *  1. **Lots, not a balance.** Credits are granted in lots with their own
 *     expiry and origin. A single running balance cannot answer "which of these
 *     expire on Friday" or "how much of this was the goodwill grant we owe back
 *     on cancellation", and both questions get asked.
 *  2. **Append-only.** A correction is a compensating entry, never an edit. An
 *     adjustable balance is a balance nobody can defend in a dispute.
 *  3. **Drawdown is anchored to the lot it consumed.** Refunding a top-up means
 *     reversing the entries that lot funded, which is impossible if drawdown
 *     only decremented a total.
 */
export type LedgerEntryKind =
  | 'grant_included'
  | 'grant_purchased'
  | 'grant_goodwill'
  | 'grant_promotional'
  | 'drawdown'
  | 'expiry'
  | 'adjustment'
  | 'reversal';

export interface CreditLot {
  readonly lotId: string;
  readonly accountId: string;
  readonly kind: Extract<LedgerEntryKind, `grant_${string}`>;
  readonly granted: Money;
  /** Remaining, derived from entries. Held for read speed, never authoritative. */
  remaining: Money;
  readonly grantedAt: string;
  readonly expiresAt?: string;
  /** Invoice or payment that funded this lot, where it was purchased. */
  readonly sourceRef?: string;
  readonly reason: string;
  readonly grantedBy: string;
  /** True where the lot was paid for, so it is refundable on cancellation. */
  readonly refundable: boolean;
}

export interface LedgerEntry {
  readonly entryId: string;
  readonly accountId: string;
  readonly sequence: number;
  readonly kind: LedgerEntryKind;
  /** Positive adds to the balance, negative removes. Never zero. */
  readonly amount: Money;
  /** The lot this entry acts on. Every entry has one; nothing floats free. */
  readonly lotId: string;
  readonly at: string;
  readonly reason: string;
  readonly actor: string;
  readonly correlationId: string;
  /** For a reversal, the entry it reverses. */
  readonly reversesEntryId?: string;
  readonly idempotencyKey?: string;
}

export interface CreditBalance {
  readonly accountId: string;
  readonly currency: CurrencyCode;
  readonly total: Money;
  readonly expiringWithin30Days: Money;
  readonly refundable: Money;
  readonly lots: readonly CreditLot[];
}

export interface LedgerStore {
  appendEntry(entry: LedgerEntry): Promise<void>;
  putLot(lot: CreditLot): Promise<void>;
  lots(accountId: string): Promise<CreditLot[]>;
  entries(accountId: string): Promise<LedgerEntry[]>;
  lastSequence(accountId: string): Promise<number>;
  findByIdempotencyKey(accountId: string, key: string): Promise<LedgerEntry | undefined>;
}

export class InMemoryLedgerStore implements LedgerStore {
  private readonly entriesByAccount = new Map<string, LedgerEntry[]>();
  private readonly lotsByAccount = new Map<string, Map<string, CreditLot>>();

  async appendEntry(entry: LedgerEntry): Promise<void> {
    const list = this.entriesByAccount.get(entry.accountId) ?? [];
    list.push(entry);
    this.entriesByAccount.set(entry.accountId, list);
  }
  async putLot(lot: CreditLot): Promise<void> {
    const lots = this.lotsByAccount.get(lot.accountId) ?? new Map();
    lots.set(lot.lotId, lot);
    this.lotsByAccount.set(lot.accountId, lots);
  }
  async lots(accountId: string): Promise<CreditLot[]> {
    return [...(this.lotsByAccount.get(accountId)?.values() ?? [])];
  }
  async entries(accountId: string): Promise<LedgerEntry[]> {
    return [...(this.entriesByAccount.get(accountId) ?? [])];
  }
  async lastSequence(accountId: string): Promise<number> {
    const list = this.entriesByAccount.get(accountId) ?? [];
    return list.length === 0 ? 0 : list[list.length - 1]!.sequence;
  }
  async findByIdempotencyKey(accountId: string, key: string): Promise<LedgerEntry | undefined> {
    return (this.entriesByAccount.get(accountId) ?? []).find((entry) => entry.idempotencyKey === key);
  }
}

export interface GrantInput {
  readonly accountId: string;
  readonly amount: Money;
  readonly kind: CreditLot['kind'];
  readonly reason: string;
  readonly grantedBy: string;
  readonly correlationId: string;
  readonly expiresAt?: string;
  readonly sourceRef?: string;
  readonly idempotencyKey?: string;
}

export interface DrawdownResult {
  readonly drawn: Money;
  readonly shortfall: Money;
  readonly entries: readonly LedgerEntry[];
}

export class CreditLedger {
  /** Per-account serialisation: two concurrent drawdowns must not both see the
   *  same balance and both succeed. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly store: LedgerStore,
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
  ) {}

  private serialise<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(accountId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.queues.set(accountId, next.catch(() => undefined));
    return next;
  }

  async grant(input: GrantInput): Promise<CreditLot> {
    if (!isPositive(input.amount)) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'a credit grant must be a positive amount' });
    }
    return this.serialise(input.accountId, async () => {
      if (input.idempotencyKey) {
        const existing = await this.store.findByIdempotencyKey(input.accountId, input.idempotencyKey);
        if (existing) {
          const lots = await this.store.lots(input.accountId);
          const lot = lots.find((candidate) => candidate.lotId === existing.lotId);
          if (lot) return lot;
        }
      }

      const lot: CreditLot = {
        lotId: newId('wr', this.clock.nowMs()),
        accountId: input.accountId,
        kind: input.kind,
        granted: input.amount,
        remaining: input.amount,
        grantedAt: this.clock.iso(),
        expiresAt: input.expiresAt,
        sourceRef: input.sourceRef,
        reason: input.reason,
        grantedBy: input.grantedBy,
        // Only money that changed hands is refundable. Included and goodwill
        // credits are not, and treating them as refundable is how a cancellation
        // turns into a refund of something nobody paid for.
        refundable: input.kind === 'grant_purchased',
      };
      await this.store.putLot(lot);
      await this.append({
        accountId: input.accountId, kind: input.kind, amount: input.amount, lotId: lot.lotId,
        reason: input.reason, actor: input.grantedBy, correlationId: input.correlationId,
        idempotencyKey: input.idempotencyKey,
      });

      await this.audit.write({
        tenantId: input.accountId, type: 'policy_allowed', correlationId: input.correlationId,
        actor: 'platform_admin',
        payload: {
          change: 'credit_granted', kind: input.kind, amountPence: input.amount.amount,
          currency: input.amount.currency, lotId: lot.lotId, reason: input.reason,
          grantedBy: input.grantedBy, expiresAt: input.expiresAt,
        },
      });
      return lot;
    });
  }

  /**
   * Draw down against lots, oldest expiry first, then oldest grant.
   *
   * Expiry order rather than grant order: consuming credit that is about to
   * expire before credit that is not is the outcome the customer would choose,
   * and doing it the other way round quietly destroys value they paid for.
   */
  async drawdown(input: {
    accountId: string; amount: Money; reason: string; correlationId: string;
    idempotencyKey?: string; allowPartial?: boolean;
  }): Promise<DrawdownResult> {
    return this.serialise(input.accountId, async () => {
      if (input.idempotencyKey) {
        const existing = await this.store.findByIdempotencyKey(input.accountId, input.idempotencyKey);
        if (existing) {
          return { drawn: money(-existing.amount.amount, existing.amount.currency), shortfall: zero(input.amount.currency), entries: [existing] };
        }
      }

      const now = this.clock.iso();
      const available = (await this.store.lots(input.accountId))
        .filter((lot) => isPositive(lot.remaining) && (!lot.expiresAt || lot.expiresAt > now))
        .sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999') || a.grantedAt.localeCompare(b.grantedAt));

      const total = sum(available.map((lot) => lot.remaining), input.amount.currency);
      if (total.amount < input.amount.amount && input.allowPartial !== true) {
        return { drawn: zero(input.amount.currency), shortfall: subtract(input.amount, total), entries: [] };
      }

      let outstanding = input.amount;
      const entries: LedgerEntry[] = [];

      for (const lot of available) {
        if (!isPositive(outstanding)) break;
        const take = outstanding.amount < lot.remaining.amount ? outstanding : lot.remaining;
        lot.remaining = subtract(lot.remaining, take);
        await this.store.putLot(lot);
        entries.push(await this.append({
          accountId: input.accountId, kind: 'drawdown',
          amount: money(-take.amount, take.currency), lotId: lot.lotId,
          reason: input.reason, actor: 'system', correlationId: input.correlationId,
          idempotencyKey: entries.length === 0 ? input.idempotencyKey : undefined,
        }));
        outstanding = subtract(outstanding, take);
      }

      return {
        drawn: subtract(input.amount, outstanding),
        shortfall: outstanding,
        entries,
      };
    });
  }

  /**
   * Reverse an entry with a compensating entry. Nothing is ever edited or
   * deleted: a ledger you can amend is a ledger nobody can rely on, and the
   * reversal is itself the evidence that a correction was made and by whom.
   */
  async reverse(input: {
    accountId: string; entryId: string; reason: string; actor: string; correlationId: string;
  }): Promise<LedgerEntry> {
    return this.serialise(input.accountId, async () => {
      const entries = await this.store.entries(input.accountId);
      const original = entries.find((entry) => entry.entryId === input.entryId);
      if (!original) {
        throw new AwaError({ kind: 'NOT_FOUND', message: `ledger entry ${input.entryId} not found` });
      }
      if (entries.some((entry) => entry.reversesEntryId === input.entryId)) {
        throw new AwaError({ kind: 'CONFLICT', message: `entry ${input.entryId} has already been reversed` });
      }

      const lots = await this.store.lots(input.accountId);
      const lot = lots.find((candidate) => candidate.lotId === original.lotId);
      if (lot) {
        lot.remaining = subtract(lot.remaining, original.amount);
        await this.store.putLot(lot);
      }

      const reversal = await this.append({
        accountId: input.accountId, kind: 'reversal',
        amount: money(-original.amount.amount, original.amount.currency),
        lotId: original.lotId, reason: input.reason, actor: input.actor,
        correlationId: input.correlationId, reversesEntryId: original.entryId,
      });

      await this.audit.write({
        tenantId: input.accountId, type: 'policy_allowed', correlationId: input.correlationId,
        actor: 'platform_admin',
        payload: { change: 'credit_entry_reversed', reversed: original.entryId, reason: input.reason, actor: input.actor },
      });
      return reversal;
    });
  }

  /** Expire lots past their date. Idempotent: an expired lot has nothing left. */
  async expireLots(accountId: string, correlationId: string): Promise<Money> {
    return this.serialise(accountId, async () => {
      const now = this.clock.iso();
      const lots = await this.store.lots(accountId);
      let expired = zero('GBP');

      for (const lot of lots) {
        if (!lot.expiresAt || lot.expiresAt > now || !isPositive(lot.remaining)) continue;
        const amount = lot.remaining;
        lot.remaining = zero(amount.currency);
        await this.store.putLot(lot);
        await this.append({
          accountId, kind: 'expiry', amount: money(-amount.amount, amount.currency),
          lotId: lot.lotId, reason: `Lot expired on ${lot.expiresAt}`, actor: 'system',
          correlationId,
        });
        expired = add(expired, amount);
      }
      return expired;
    });
  }

  async balance(accountId: string, currency: CurrencyCode = 'GBP'): Promise<CreditBalance> {
    const now = this.clock.iso();
    const horizon = new Date(this.clock.nowMs() + 30 * 86_400_000).toISOString();
    const lots = (await this.store.lots(accountId))
      .filter((lot) => !lot.expiresAt || lot.expiresAt > now)
      .sort((a, b) => (a.expiresAt ?? '9999').localeCompare(b.expiresAt ?? '9999'));

    return {
      accountId,
      currency,
      total: sum(lots.map((lot) => lot.remaining), currency),
      expiringWithin30Days: sum(
        lots.filter((lot) => lot.expiresAt && lot.expiresAt <= horizon).map((lot) => lot.remaining),
        currency,
      ),
      refundable: sum(lots.filter((lot) => lot.refundable).map((lot) => lot.remaining), currency),
      lots,
    };
  }

  async statement(accountId: string): Promise<LedgerEntry[]> {
    return (await this.store.entries(accountId)).sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Reconcile the cached lot remainders against the entries that produced them.
   * Run in CI and by the console: a divergence means something wrote a lot
   * without an entry, which is the one bug class this design exists to prevent.
   */
  async reconcile(accountId: string): Promise<{ consistent: boolean; discrepancies: string[] }> {
    const entries = await this.store.entries(accountId);
    const lots = await this.store.lots(accountId);
    const discrepancies: string[] = [];

    for (const lot of lots) {
      const derived = entries
        .filter((entry) => entry.lotId === lot.lotId)
        .reduce((total, entry) => total + entry.amount.amount, 0);
      if (derived !== lot.remaining.amount) {
        discrepancies.push(
          `lot ${lot.lotId}: cached remaining ${lot.remaining.amount} but entries sum to ${derived}`,
        );
      }
    }
    return { consistent: discrepancies.length === 0, discrepancies };
  }

  private async append(input: Omit<LedgerEntry, 'entryId' | 'sequence' | 'at'>): Promise<LedgerEntry> {
    const entry: LedgerEntry = {
      ...input,
      entryId: newId('aud', this.clock.nowMs()),
      sequence: (await this.store.lastSequence(input.accountId)) + 1,
      at: this.clock.iso(),
    };
    await this.store.appendEntry(entry);
    return entry;
  }
}
