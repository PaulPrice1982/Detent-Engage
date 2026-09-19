import { AwaError, type Clock, systemClock } from '@detent/awa-core';
import {
  add, allocate, isNegative, isZero, money, percentage, subtract, sum, zero,
  type CurrencyCode, type Money,
} from './money.js';
import type { RatedLine, RatedUsage } from './rating.js';

/**
 * Invoicing.
 *
 * An invoice is a legal document, not a view over a balance. Two consequences
 * shape everything here:
 *
 *  1. **An issued invoice is immutable.** It is never edited, never re-rated and
 *     never quietly corrected. A mistake is answered with a credit note, which
 *     is the auditable trail HMRC expects and the one a finance team can follow.
 *  2. **Its number is sequential and gapless per legal entity.** A gap in an
 *     invoice sequence is a question at audit, so numbers are issued in order
 *     under a lock and never reused, even for a voided invoice.
 */

export type InvoiceStatus =
  /** Assembled, not yet issued. Editable; carries no number. */
  | 'draft'
  /** Issued and payable. Immutable from here on. */
  | 'open'
  | 'paid'
  /** Cancelled before payment. Keeps its number; nets to nothing. */
  | 'void'
  /** Written off as unrecoverable. Still owed in law, not expected in fact. */
  | 'uncollectible';

/** Legal reason a line carries no VAT. */
export type TaxTreatment =
  | 'standard'
  /** B2B cross-border: the customer accounts for the tax. */
  | 'reverse_charge'
  | 'zero_rated'
  | 'exempt'
  | 'outside_scope';

export interface TaxRate {
  readonly code: string;
  readonly name: string;
  /** Basis points: 2000 = 20%. */
  readonly basisPoints: number;
  readonly treatment: TaxTreatment;
}

export const UK_VAT_STANDARD: TaxRate = {
  code: 'GB_VAT_STANDARD', name: 'UK VAT (standard rate)', basisPoints: 2_000, treatment: 'standard',
};
export const REVERSE_CHARGE: TaxRate = {
  code: 'EU_REVERSE_CHARGE', name: 'Reverse charge', basisPoints: 0, treatment: 'reverse_charge',
};
export const OUTSIDE_SCOPE: TaxRate = {
  code: 'OUTSIDE_SCOPE', name: 'Outside the scope of UK VAT', basisPoints: 0, treatment: 'outside_scope',
};

export interface InvoiceLine extends RatedLine {
  readonly taxRate: TaxRate;
  readonly taxAmount: Money;
}

export interface Invoice {
  readonly invoiceId: string;
  /** Assigned at issue, never before. Sequential and gapless per entity. */
  readonly number?: string;
  readonly accountId: string;
  readonly tenantId: string;
  readonly status: InvoiceStatus;
  readonly currency: CurrencyCode;
  readonly period: string;
  readonly lines: readonly InvoiceLine[];
  /** Credits spent against this invoice, as a positive amount. */
  readonly creditsApplied: Money;
  readonly subtotal: Money;
  readonly tax: Money;
  readonly total: Money;
  /** Total less anything already paid or credited. */
  readonly amountDue: Money;
  readonly amountPaid: Money;
  readonly createdAt: string;
  readonly issuedAt?: string;
  readonly dueAt?: string;
  readonly paidAt?: string;
  readonly voidedAt?: string;
  readonly voidReason?: string;
  /** Set on a credit note; names the invoice being credited. */
  readonly creditsInvoiceId?: string;
  readonly billingName?: string;
  readonly billingEmail?: string;
  readonly vatNumber?: string;
  readonly countryCode?: string;
  readonly notes?: string;
}

export interface InvoiceStore {
  get(invoiceId: string): Promise<Invoice | undefined>;
  put(invoice: Invoice): Promise<void>;
  listByAccount(accountId: string): Promise<readonly Invoice[]>;
  /** Next number in the sequence for a legal entity. Must be atomic. */
  nextNumber(entity: string, year: number): Promise<number>;
}

export class InMemoryInvoiceStore implements InvoiceStore {
  private readonly invoices = new Map<string, Invoice>();
  private readonly sequences = new Map<string, number>();

  async get(invoiceId: string): Promise<Invoice | undefined> {
    return this.invoices.get(invoiceId);
  }
  async put(invoice: Invoice): Promise<void> {
    this.invoices.set(invoice.invoiceId, invoice);
  }
  async listByAccount(accountId: string): Promise<readonly Invoice[]> {
    return [...this.invoices.values()]
      .filter((invoice) => invoice.accountId === accountId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async nextNumber(entity: string, year: number): Promise<number> {
    const key = `${entity}:${year}`;
    const next = (this.sequences.get(key) ?? 0) + 1;
    this.sequences.set(key, next);
    return next;
  }
}

/**
 * Chooses the tax treatment.
 *
 * Deliberately conservative and deliberately narrow: it handles the three cases
 * a UK SaaS seller meets daily and refuses to guess at anything else. Tax
 * treatment invented by software is a liability, so an unrecognised case falls
 * back to standard-rated, which errs towards charging tax rather than failing to.
 */
export function taxRateFor(input: {
  readonly sellerCountry?: string;
  readonly customerCountry?: string;
  readonly customerVatNumber?: string;
}): TaxRate {
  const seller = (input.sellerCountry ?? 'GB').toUpperCase();
  const customer = (input.customerCountry ?? seller).toUpperCase();

  if (customer === seller) return UK_VAT_STANDARD;
  // Cross-border B2B with a validated VAT number: the customer accounts for it.
  if (input.customerVatNumber && input.customerVatNumber.trim().length > 0) return REVERSE_CHARGE;
  // Cross-border without a VAT number is treated as standard-rated rather than
  // guessed at. Getting this right needs the customer's status, which is a
  // commercial decision, not an inference.
  return UK_VAT_STANDARD;
}

export interface AssembleInput {
  readonly invoiceId: string;
  readonly accountId: string;
  readonly rated: RatedUsage;
  /** Credits available to spend. Applied to creditable lines only. */
  readonly creditsAvailable?: Money;
  readonly taxRate?: TaxRate;
  readonly billingName?: string;
  readonly billingEmail?: string;
  readonly vatNumber?: string;
  readonly countryCode?: string;
  readonly notes?: string;
}

export class InvoiceService {
  constructor(
    private readonly store: InvoiceStore,
    private readonly clock: Clock = systemClock,
    /** Legal entity the sequence belongs to. */
    private readonly entity = 'DETENT-GB',
    private readonly paymentTermsDays = 14,
  ) {}

  /**
   * Builds a draft from a rating.
   *
   * Credits are applied here rather than at rating because applying them is a
   * decision about one invoice, while a rating is a statement about a period.
   * Credits are spread across creditable lines by value, so a partial balance
   * reduces every line proportionally instead of clearing the first and leaving
   * the rest, which is what makes a part-credited invoice legible.
   */
  async assemble(input: AssembleInput): Promise<Invoice> {
    const { rated } = input;
    const currency = rated.currency;
    const taxRate = input.taxRate ?? taxRateFor({
      customerCountry: input.countryCode,
      customerVatNumber: input.vatNumber,
    });

    const creditsAvailable = input.creditsAvailable ?? zero(currency);
    if (isNegative(creditsAvailable)) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'Credits available cannot be negative.' });
    }

    const creditable = rated.lines.filter((line) => line.kind === 'usage' || line.kind === 'outcome');
    const creditableTotal = sum(creditable.map((line) => line.amount), currency);
    const creditsApplied = money(
      Math.min(creditsAvailable.amount, Math.max(creditableTotal.amount, 0)),
      currency,
    );

    // Spread by line value so the reduction is proportional and the parts sum
    // back to exactly the credit applied.
    const weights = creditable.map((line) => Math.max(line.amount.amount, 0));
    const spread = creditsApplied.amount > 0 && weights.some((weight) => weight > 0)
      ? allocate(creditsApplied, weights)
      : creditable.map(() => zero(currency));

    const lines: InvoiceLine[] = [];
    let creditIndex = 0;
    for (const line of rated.lines) {
      const isCreditable = line.kind === 'usage' || line.kind === 'outcome';
      const credited = isCreditable ? (spread[creditIndex++] ?? zero(currency)) : zero(currency);
      const net = subtract(line.amount, credited);
      lines.push({
        ...line,
        amount: net,
        taxRate,
        // Tax follows the net amount: credits reduce consideration, so they
        // reduce the VAT with it.
        taxAmount: taxRate.basisPoints === 0 ? zero(currency) : percentage(net, taxRate.basisPoints),
      });
    }

    const subtotal = sum(lines.map((line) => line.amount), currency);
    const tax = sum(lines.map((line) => line.taxAmount), currency);
    const total = add(subtotal, tax);

    const invoice: Invoice = {
      invoiceId: input.invoiceId,
      accountId: input.accountId,
      tenantId: rated.tenantId,
      status: 'draft',
      currency,
      period: rated.period,
      lines,
      creditsApplied,
      subtotal,
      tax,
      total,
      amountDue: total,
      amountPaid: zero(currency),
      createdAt: this.clock.iso(),
      billingName: input.billingName,
      billingEmail: input.billingEmail,
      vatNumber: input.vatNumber,
      countryCode: input.countryCode,
      notes: input.notes,
    };
    await this.store.put(invoice);
    return invoice;
  }

  /**
   * Issues a draft: assigns the number, sets the due date, makes it immutable.
   */
  async issue(invoiceId: string): Promise<Invoice> {
    const invoice = await this.require(invoiceId);
    if (invoice.status !== 'draft') {
      throw new AwaError({ kind: 'CONFLICT', message: `Only a draft can be issued; this invoice is ${invoice.status}.` });
    }
    const issuedAt = this.clock.iso();
    const year = Number(issuedAt.slice(0, 4));
    const sequence = await this.store.nextNumber(this.entity, year);
    const number = `${this.entity}-${year}-${String(sequence).padStart(5, '0')}`;

    const dueAt = new Date(Date.parse(issuedAt) + this.paymentTermsDays * 86_400_000).toISOString();
    // A nil invoice is issued and immediately settled rather than left open: an
    // open invoice for nothing is a dunning ladder waiting to chase £0.
    const settled = isZero(invoice.total);
    const issued: Invoice = {
      ...invoice,
      status: settled ? 'paid' : 'open',
      number,
      issuedAt,
      dueAt,
      paidAt: settled ? issuedAt : undefined,
    };
    await this.store.put(issued);
    return issued;
  }

  /** Records a payment. Partial payments are allowed and reduce the balance. */
  async recordPayment(invoiceId: string, amount: Money): Promise<Invoice> {
    const invoice = await this.require(invoiceId);
    if (invoice.status !== 'open' && invoice.status !== 'uncollectible') {
      throw new AwaError({ kind: 'CONFLICT', message: `Cannot pay an invoice that is ${invoice.status}.` });
    }
    if (!isPositiveMoney(amount)) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'A payment must be positive.' });
    }
    const amountPaid = add(invoice.amountPaid, amount);
    const amountDue = subtract(invoice.total, amountPaid);
    const paid = amountDue.amount <= 0;
    const updated: Invoice = {
      ...invoice,
      amountPaid,
      amountDue: paid ? zero(invoice.currency) : amountDue,
      status: paid ? 'paid' : invoice.status === 'uncollectible' ? 'open' : invoice.status,
      paidAt: paid ? this.clock.iso() : invoice.paidAt,
    };
    await this.store.put(updated);
    return updated;
  }

  /**
   * Voids an unpaid invoice. It keeps its number: the sequence stays gapless , 
   * and nets to nothing. A *paid* invoice is never voided; it is credited.
   */
  async void(invoiceId: string, reason: string): Promise<Invoice> {
    const invoice = await this.require(invoiceId);
    if (invoice.status === 'paid') {
      throw new AwaError({ kind: 'CONFLICT', message: 'A paid invoice is corrected with a credit note, not voided.' });
    }
    if (invoice.status === 'void') return invoice;
    if (!reason.trim()) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'Voiding an invoice requires a reason.' });
    }
    const voided: Invoice = {
      ...invoice,
      status: 'void',
      voidedAt: this.clock.iso(),
      voidReason: reason,
      amountDue: zero(invoice.currency),
    };
    await this.store.put(voided);
    return voided;
  }

  /** Marks an open invoice unrecoverable. It remains legally owed. */
  async writeOff(invoiceId: string, reason: string): Promise<Invoice> {
    const invoice = await this.require(invoiceId);
    if (invoice.status !== 'open') {
      throw new AwaError({ kind: 'CONFLICT', message: `Only an open invoice can be written off; this is ${invoice.status}.` });
    }
    if (!reason.trim()) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'Writing off an invoice requires a reason.' });
    }
    const updated: Invoice = { ...invoice, status: 'uncollectible', notes: reason };
    await this.store.put(updated);
    return updated;
  }

  /**
   * Raises a credit note against an issued invoice.
   *
   * This is the only way to correct an issued invoice. Full or partial; a
   * partial credit is spread across lines by value, for the same reason credits
   * are. The note is issued immediately: a draft credit note helps nobody.
   */
  async creditNote(input: {
    readonly creditNoteId: string;
    readonly invoiceId: string;
    /**
     * **Net of tax.** Tax is recomputed on the credited net at each line's own
     * rate, exactly as it was charged. Passing a tax-inclusive figure here
     * would credit the VAT twice, once in the amount, once in the recomputed
     * tax, and leave the pair failing to net to nothing.
     */
    readonly amount?: Money;
    readonly reason: string;
  }): Promise<Invoice> {
    const original = await this.require(input.invoiceId);
    if (original.status === 'draft') {
      throw new AwaError({ kind: 'CONFLICT', message: 'A draft is edited or discarded, not credited.' });
    }
    if (!input.reason.trim()) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'A credit note requires a reason.' });
    }
    const currency = original.currency;
    const full = input.amount ?? original.subtotal;
    if (!isPositiveMoney(full)) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'A credit note must be for a positive amount.' });
    }
    if (full.amount > original.subtotal.amount) {
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: 'A credit note cannot exceed the net value of the invoice it credits.',
      });
    }

    const weights = original.lines.map((line) => Math.max(line.amount.amount, 0));
    const spread = weights.some((weight) => weight > 0)
      ? allocate(full, weights)
      : original.lines.map(() => zero(currency));

    const lines: InvoiceLine[] = original.lines.map((line, index) => {
      const credited = spread[index] ?? zero(currency);
      const negated = money(-credited.amount, currency);
      return {
        ...line,
        amount: negated,
        taxAmount: line.taxRate.basisPoints === 0
          ? zero(currency)
          : percentage(negated, line.taxRate.basisPoints),
      };
    });

    const subtotal = sum(lines.map((line) => line.amount), currency);
    const tax = sum(lines.map((line) => line.taxAmount), currency);
    const total = add(subtotal, tax);
    const issuedAt = this.clock.iso();
    const year = Number(issuedAt.slice(0, 4));
    const sequence = await this.store.nextNumber(`${this.entity}-CN`, year);

    const note: Invoice = {
      invoiceId: input.creditNoteId,
      number: `${this.entity}-CN-${year}-${String(sequence).padStart(5, '0')}`,
      accountId: original.accountId,
      tenantId: original.tenantId,
      status: 'open',
      currency,
      period: original.period,
      lines,
      creditsApplied: zero(currency),
      subtotal,
      tax,
      total,
      amountDue: total,
      amountPaid: zero(currency),
      createdAt: issuedAt,
      issuedAt,
      creditsInvoiceId: original.invoiceId,
      billingName: original.billingName,
      billingEmail: original.billingEmail,
      vatNumber: original.vatNumber,
      countryCode: original.countryCode,
      notes: input.reason,
    };
    await this.store.put(note);
    return note;
  }

  async get(invoiceId: string): Promise<Invoice | undefined> {
    return this.store.get(invoiceId);
  }

  async listByAccount(accountId: string): Promise<readonly Invoice[]> {
    return this.store.listByAccount(accountId);
  }

  /** Open invoices past their due date, oldest first. The dunning input. */
  async overdue(accountId: string, asOfIso: string): Promise<readonly Invoice[]> {
    const invoices = await this.store.listByAccount(accountId);
    return invoices
      .filter((invoice) => invoice.status === 'open' && invoice.dueAt !== undefined && invoice.dueAt < asOfIso)
      .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
  }

  private async require(invoiceId: string): Promise<Invoice> {
    const invoice = await this.store.get(invoiceId);
    if (!invoice) throw new AwaError({ kind: 'NOT_FOUND', message: `No invoice ${invoiceId}.` });
    return invoice;
  }
}

function isPositiveMoney(amount: Money): boolean {
  return amount.amount > 0;
}

/** Days an invoice is past due, or 0 if it is not. */
export function daysOverdue(invoice: Invoice, asOfIso: string): number {
  if (invoice.status !== 'open' || !invoice.dueAt) return 0;
  const elapsed = Date.parse(asOfIso) - Date.parse(invoice.dueAt);
  return elapsed <= 0 ? 0 : Math.floor(elapsed / 86_400_000);
}
