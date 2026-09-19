import { AwaError, systemClock, type Clock } from '@detent/awa-core';
import {
  add, money, percentage, sum, type CurrencyCode, type Invoice, type Money,
} from '@detent/awa-billing';
import { DEFAULT_COMMISSION_BANDS, bandFor, type CommissionBand } from './bands.js';
import type { AccountLink, Reseller } from './resellers.js';

/**
 * What a reseller has earned, and on what.
 *
 * Three commercial decisions are built into this and are worth stating,
 * because each is a place channel businesses routinely lose money:
 *
 * 1. Commission is earned on cash collected, not on invoices raised. Paying a
 *    reseller for an invoice the customer never settles means clawing it back
 *    later, and clawback is the single most damaging conversation in a channel
 *    relationship. An unpaid invoice appears on the statement as pending, so
 *    the reseller can see what is coming and chase it themselves.
 *
 * 2. Commission is calculated on the net amount, never on the VAT. VAT is
 *    collected on behalf of HMRC and is not revenue; paying 15% of it is
 *    paying 15% of somebody else's money.
 *
 * 3. The margin used is the one in force when the customer was held, taken
 *    from the link rather than from the reseller's current rate. A reseller
 *    who negotiates a better rate this quarter does not thereby restate last
 *    quarter's statements.
 */

export type CommissionBasis =
  /** Recurring subscription fees. Always commissionable. */
  | 'subscription'
  /** One-off activation and set-up fees. */
  | 'activation'
  /** Usage above the plan's included allowance. */
  | 'overage';

export interface CommissionLine {
  readonly invoiceId: string;
  readonly invoiceNumber?: string;
  readonly accountId: string;
  readonly period: string;
  /** Net of VAT: the amount commission is calculated on. */
  readonly netAmount: Money;
  readonly marginBasisPoints: number;
  readonly commission: Money;
  /**
   * Whether the customer has paid.
   *
   * 'earned' , paid, and therefore payable to the reseller.
   * 'pending', invoiced but unpaid; shown, not paid.
   */
  readonly state: 'earned' | 'pending';
  readonly paidAt?: string;
}

export interface CommissionStatement {
  readonly resellerId: string;
  readonly resellerName: string;
  /** The period the statement covers, as YYYY-MM. */
  readonly period: string;
  readonly currency: CurrencyCode;
  /** The band this reseller was in for the period, when banded. */
  readonly band?: CommissionBand;
  /** The book the band was decided on: everything collected up to this period. */
  readonly bandedOnVolume?: Money;
  readonly lines: readonly CommissionLine[];
  /** Customer spend, net of VAT, that has been collected. */
  readonly collectedSpend: Money;
  /** Customer spend invoiced but not yet collected. */
  readonly pendingSpend: Money;
  /** Payable now. */
  readonly commissionEarned: Money;
  /** Will become payable when the customer pays. */
  readonly commissionPending: Money;
  readonly generatedAt: string;
}

/**
 * Which invoice lines a reseller earns on.
 *
 * A credit note reduces what the customer paid, so it must reduce commission
 * too, otherwise refunding a customer costs twice.
 */
function commissionableNet(invoice: Invoice): Money {
  // The subtotal, not the total: the total carries VAT. This is the same
  // decision made for credit notes, and for the same reason.
  return invoice.subtotal;
}

export interface StatementInput {
  readonly reseller: Reseller;
  /** Every link this reseller has ever held, so a past period resolves. */
  readonly links: readonly AccountLink[];
  /** The invoices of this reseller's customers for the period. */
  readonly invoices: readonly Invoice[];
  readonly period: string;
  readonly currency?: CurrencyCode;
}

/**
 * Was the customer held by this reseller when the invoice was raised?
 *
 * Comparing against the link's window rather than against "is linked now" is
 * what makes a historical statement reproducible. A customer who left in March
 * still earns their old reseller commission on February.
 */
function heldAt(link: AccountLink, at: string): boolean {
  if (at < link.since) return false;
  return link.until === undefined || at < link.until;
}

export class CommissionCalculator {
  constructor(private readonly clock: Clock = systemClock) {}

  statement(input: StatementInput): CommissionStatement {
    const currency = input.currency ?? 'GBP';
    const byAccount = new Map<string, AccountLink[]>();
    for (const link of input.links) {
      byAccount.set(link.accountId, [...(byAccount.get(link.accountId) ?? []), link]);
    }

    /**
     * The band, decided on the book built up to and including this period.
     *
     * On the whole book rather than the period alone, because a reseller with
     * a large book should not drop to the entry rate because one customer's
     * month was quiet, which is the arrangement they would leave over.
     *
     * Only collected revenue counts towards it. Letting unpaid invoices lift
     * somebody into a higher band pays a better rate on money nobody has.
     */
    const collectedToDate = sum(
      input.invoices
        .filter((one) => one.status === 'paid' && one.period <= input.period
          && one.currency === currency)
        .filter((one) => (byAccount.get(one.accountId) ?? [])
          .some((one2) => heldAt(one2, one.issuedAt ?? one.createdAt)))
        .map((one) => one.subtotal),
      currency,
    );
    const bands = input.reseller.bands ?? DEFAULT_COMMISSION_BANDS;
    const band = input.reseller.banded === false
      ? undefined
      : bandFor(collectedToDate, bands);

    const lines: CommissionLine[] = [];
    for (const invoice of input.invoices) {
      if (invoice.period !== input.period) continue;
      // Only an issued invoice reaches a statement.
      //
      // A draft is not owed yet, and showing it as pending commission promises
      // the reseller money against a figure that is still editable. A voided
      // invoice was never owed. An uncollectible one has been written off, and
      // paying commission on revenue we have accepted we will never see means
      // the write-off costs us twice.
      if (invoice.status === 'draft' || invoice.status === 'void'
          || invoice.status === 'uncollectible') {
        continue;
      }

      const raisedAt = invoice.issuedAt ?? invoice.createdAt;
      const link = (byAccount.get(invoice.accountId) ?? []).find((one) => heldAt(one, raisedAt));
      if (!link) continue; // not this reseller's customer at the time

      if (invoice.currency !== currency) {
        // Mixing currencies in one total produces a number that is not money.
        // Better to refuse than to publish a statement nobody can reconcile.
        throw new AwaError({
          kind: 'CONFLICT',
          message:
            `Invoice ${invoice.invoiceId} is in ${invoice.currency} but the statement is `
            + `in ${currency}. Produce a statement per currency.`,
        });
      }

      /**
       * Precedence, most specific first:
       *   1. a rate agreed for this one customer,
       *   2. the band their volume has earned them,
       *   3. the reseller's flat rate, for anyone not on the programme.
       *
       * A customer-specific rate outranks the band deliberately: it was
       * negotiated for a reason, and having it silently overtaken by a band
       * would change a signed number without anybody deciding to.
       */
      const marginBasisPoints = link.marginBasisPoints
        ?? band?.basisPoints
        ?? input.reseller.marginBasisPoints;
      const netAmount = commissionableNet(invoice);
      const paid = invoice.status === 'paid';

      lines.push({
        invoiceId: invoice.invoiceId,
        invoiceNumber: invoice.number,
        accountId: invoice.accountId,
        period: invoice.period,
        netAmount,
        marginBasisPoints,
        commission: percentage(netAmount, marginBasisPoints),
        state: paid ? 'earned' : 'pending',
        paidAt: invoice.paidAt,
      });
    }

    const earned = lines.filter((line) => line.state === 'earned');
    const pending = lines.filter((line) => line.state === 'pending');

    return {
      resellerId: input.reseller.resellerId,
      resellerName: input.reseller.name,
      period: input.period,
      currency,
      band,
      bandedOnVolume: band ? collectedToDate : undefined,
      lines,
      collectedSpend: sum(earned.map((line) => line.netAmount), currency),
      pendingSpend: sum(pending.map((line) => line.netAmount), currency),
      commissionEarned: sum(earned.map((line) => line.commission), currency),
      commissionPending: sum(pending.map((line) => line.commission), currency),
      generatedAt: new Date(this.clock.nowMs()).toISOString(),
    };
  }

  /**
   * A reseller's whole book, period by period, newest first.
   *
   * Used by the reseller portal and by the back office. Both read the same
   * calculation: a portal that computes commission differently from the
   * statement it is paid against is a support ticket waiting to happen.
   */
  statements(input: Omit<StatementInput, 'period'>): readonly CommissionStatement[] {
    const periods = [...new Set(input.invoices.map((invoice) => invoice.period))]
      .sort().reverse();
    return periods
      .map((period) => this.statement({ ...input, period }))
      .filter((statement) => statement.lines.length > 0);
  }

  /** Lifetime totals across every period, for the portal's headline figures. */
  lifetime(statements: readonly CommissionStatement[], currency: CurrencyCode = 'GBP'): {
    readonly collectedSpend: Money;
    readonly commissionEarned: Money;
    readonly commissionPending: Money;
  } {
    return statements.reduce(
      (running, statement) => ({
        collectedSpend: add(running.collectedSpend, statement.collectedSpend),
        commissionEarned: add(running.commissionEarned, statement.commissionEarned),
        commissionPending: add(running.commissionPending, statement.commissionPending),
      }),
      {
        collectedSpend: money(0, currency),
        commissionEarned: money(0, currency),
        commissionPending: money(0, currency),
      },
    );
  }
}
