import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { FixedClock } from '@detent/awa-core';
import type { UsageRecord } from '@detent/awa-policy';
import {
  CreditLedger, DunningService, InMemoryDunningStore, InMemoryInvoiceStore,
  InMemoryLedgerStore, InvoiceService, PLAN_CATALOGUE, UK_VAT_STANDARD,
  add, allocate, format, isZero, money, rateUsage, sum, taxRateFor, validatePlan,
} from '@detent/awa-billing';

const clock = () => new FixedClock(new Date('2026-03-01T09:00:00.000Z'));
const ledgerFor = () =>
  new CreditLedger(new InMemoryLedgerStore(), new AuditLog(new InMemoryAuditStore()), clock());

const usage = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  tenantId: 't_acme', period: '2026-02',
  conversations: 0, textMessages: 0, voiceMinutes: 0, crmCalls: 0, llmTokens: 0,
  qualifiedOutcomes: 0, enrichmentRecords: 0, companyResolutions: 0,
  spendPence: 0, concurrentVoice: 0,
  ...over,
});

describe('money', () => {
  it('refuses a fractional minor unit rather than rounding silently', () => {
    // A float penny is how a ledger stops reconciling. Fail loudly instead.
    expect(() => money(10.5)).toThrow();
  });

  it('allocates so the parts sum back to exactly the whole', () => {
    const parts = allocate(money(1_000), [1, 1, 1]);
    expect(parts.map((part) => part.amount)).toEqual([334, 333, 333]);
    expect(sum(parts).amount).toBe(1_000);
  });

  it('gives the remainder to the largest weight, deterministically', () => {
    const parts = allocate(money(101), [70, 30]);
    expect(parts.map((part) => part.amount)).toEqual([71, 30]);
    expect(sum(parts).amount).toBe(101);
  });

  it('formats in pounds', () => {
    expect(format(money(123_456))).toBe('£1,234.56');
  });
});

describe('plans', () => {
  it('refuses an enterprise plan left at its unnegotiated zeroes', () => {
    // Invoicing nothing is worse than refusing to invoice: it is silent.
    expect(validatePlan(PLAN_CATALOGUE.enterprise, 'monthly').length).toBeGreaterThan(0);
  });

  it('accepts a standard plan', () => {
    expect(validatePlan(PLAN_CATALOGUE.growth, 'monthly')).toEqual([]);
  });
});

describe('rating', () => {
  it('prices from the same counters the tenant is shown', () => {
    const rated = rateUsage(usage({ conversations: 100, textMessages: 1_000 }), PLAN_CATALOGUE.growth);
    const conversations = rated.lines.find((line) => line.code === 'conversations');
    const messages = rated.lines.find((line) => line.code === 'text_messages');
    // 100 x 35 millis = 3500 millis = 3.5p -> 4p, rounded once at the line.
    expect(conversations?.amount.amount).toBe(4);
    // 1000 x 4 millis = 4000 millis = 4p exactly.
    expect(messages?.amount.amount).toBe(4);
  });

  it('rounds once per line, not per unit', () => {
    // Per-unit rounding would make each of 1000 messages 0p and the line 0p.
    const rated = rateUsage(usage({ textMessages: 1_000 }), PLAN_CATALOGUE.growth);
    expect(rated.total.amount).toBe(4);
  });

  it('omits a line for something that was not used', () => {
    const rated = rateUsage(usage({ conversations: 5 }), PLAN_CATALOGUE.growth);
    expect(rated.lines.map((line) => line.code)).toEqual(['conversations']);
  });

  it('keeps the platform fee out of the creditable total', () => {
    // Credits buy consumption. Letting them erase the subscription turns a
    // goodwill gesture into an unbudgeted discount on recurring revenue.
    const rated = rateUsage(usage({ conversations: 100 }), PLAN_CATALOGUE.growth, {
      includePlatformFee: true, interval: 'monthly',
    });
    expect(rated.nonCreditableTotal.amount).toBe(75_000);
    expect(rated.creditableTotal.amount).toBe(4);
  });

  it('prices confirmed outcomes at the plan fee', () => {
    const rated = rateUsage(usage({ qualifiedOutcomes: 3 }), PLAN_CATALOGUE.growth);
    expect(rated.total.amount).toBe(1_500); // 3 x £5.00
  });
});

describe('credit ledger', () => {
  it('draws down oldest-expiring first', async () => {
    const ledger = ledgerFor();
    await ledger.grant({
      accountId: 'a1', kind: 'grant_purchased', amount: money(1_000),
      expiresAt: '2026-12-31T00:00:00.000Z', reason: 'top-up', grantedBy: 'ops', correlationId: 'c_grant1',
    });
    await ledger.grant({
      accountId: 'a1', kind: 'grant_included', amount: money(1_000),
      expiresAt: '2026-04-30T00:00:00.000Z', reason: 'plan', grantedBy: 'system', correlationId: 'c_grant2',
    });
    const result = await ledger.drawdown({
      accountId: 'a1', amount: money(1_200), reason: 'usage', correlationId: 'c1',
    });
    expect(result.drawn.amount).toBe(1_200);
    const balance = await ledger.balance('a1');
    expect(balance.total.amount).toBe(800);
    // The April lot is consumed first, so what remains is the purchased lot.
    expect(balance.refundable.amount).toBe(800);
  });

  it('is idempotent on a repeated drawdown key', async () => {
    const ledger = ledgerFor();
    await ledger.grant({
      accountId: 'a1', kind: 'grant_included', amount: money(1_000),
      expiresAt: '2026-12-31T00:00:00.000Z', reason: 'plan', grantedBy: 'system', correlationId: 'c_grant2',
    });
    const input = {
      accountId: 'a1', amount: money(300), reason: 'usage',
      correlationId: 'c1', idempotencyKey: 'k1',
    };
    await ledger.drawdown(input);
    await ledger.drawdown(input);
    expect((await ledger.balance('a1')).total.amount).toBe(700);
  });
});

describe('invoicing', () => {
  const service = () => new InvoiceService(new InMemoryInvoiceStore(), clock());

  it('applies credits to usage but never to the platform fee', async () => {
    const rated = rateUsage(usage({ qualifiedOutcomes: 2 }), PLAN_CATALOGUE.growth, {
      includePlatformFee: true, interval: 'monthly',
    });
    const invoice = await service().assemble({
      invoiceId: 'inv_1', accountId: 'a1', rated,
      creditsAvailable: money(100_000), countryCode: 'GB',
    });
    // Only the £10 of outcomes is creditable, so that is all the credit spent.
    expect(invoice.creditsApplied.amount).toBe(1_000);
    expect(invoice.subtotal.amount).toBe(75_000);
  });

  it('charges VAT on the net of credits, not the gross', async () => {
    const rated = rateUsage(usage({ qualifiedOutcomes: 2 }), PLAN_CATALOGUE.growth);
    const invoice = await service().assemble({
      invoiceId: 'inv_2', accountId: 'a1', rated,
      creditsAvailable: money(500), taxRate: UK_VAT_STANDARD,
    });
    // £10 of outcomes less £5 credit = £5 net, VAT £1.
    expect(invoice.subtotal.amount).toBe(500);
    expect(invoice.tax.amount).toBe(100);
    expect(invoice.total.amount).toBe(600);
  });

  it('issues a gapless sequential number and will not issue twice', async () => {
    const invoices = service();
    const rated = rateUsage(usage({ qualifiedOutcomes: 1 }), PLAN_CATALOGUE.growth);
    await invoices.assemble({ invoiceId: 'i1', accountId: 'a1', rated });
    await invoices.assemble({ invoiceId: 'i2', accountId: 'a1', rated });
    const first = await invoices.issue('i1');
    const second = await invoices.issue('i2');
    expect(first.number).toBe('DETENT-GB-2026-00001');
    expect(second.number).toBe('DETENT-GB-2026-00002');
    await expect(invoices.issue('i1')).rejects.toThrow();
  });

  it('settles a nil invoice at issue instead of opening a chase for nothing', async () => {
    const invoices = service();
    const rated = rateUsage(usage(), PLAN_CATALOGUE.growth);
    await invoices.assemble({ invoiceId: 'i0', accountId: 'a1', rated });
    const issued = await invoices.issue('i0');
    expect(issued.status).toBe('paid');
    expect(isZero(issued.total)).toBe(true);
  });

  it('will not void a paid invoice: that is what a credit note is for', async () => {
    const invoices = service();
    const rated = rateUsage(usage({ qualifiedOutcomes: 1 }), PLAN_CATALOGUE.growth);
    await invoices.assemble({ invoiceId: 'i1', accountId: 'a1', rated });
    const issued = await invoices.issue('i1');
    await invoices.recordPayment('i1', issued.total);
    await expect(invoices.void('i1', 'mistake')).rejects.toThrow();
  });

  it('refuses to void without a reason', async () => {
    const invoices = service();
    const rated = rateUsage(usage({ qualifiedOutcomes: 1 }), PLAN_CATALOGUE.growth);
    await invoices.assemble({ invoiceId: 'i1', accountId: 'a1', rated });
    await invoices.issue('i1');
    await expect(invoices.void('i1', '   ')).rejects.toThrow();
  });

  it('raises a credit note that nets the original to nothing', async () => {
    const invoices = service();
    const rated = rateUsage(usage({ qualifiedOutcomes: 4 }), PLAN_CATALOGUE.growth);
    await invoices.assemble({ invoiceId: 'i1', accountId: 'a1', rated, taxRate: UK_VAT_STANDARD });
    const issued = await invoices.issue('i1');
    const note = await invoices.creditNote({
      creditNoteId: 'cn1', invoiceId: 'i1', reason: 'billed in error',
    });
    expect(note.creditsInvoiceId).toBe('i1');
    expect(note.number).toBe('DETENT-GB-CN-2026-00001');
    expect(add(issued.total, note.total).amount).toBe(0);
  });

  it('credits net of tax, so a full credit note does not double-count VAT', async () => {
    // Defaulting the credit to the tax-inclusive total and then recomputing VAT
    // on it credits the tax twice, and the pair fails to net to nothing.
    const invoices = service();
    const rated = rateUsage(usage({ qualifiedOutcomes: 4 }), PLAN_CATALOGUE.growth);
    await invoices.assemble({ invoiceId: 'i1', accountId: 'a1', rated, taxRate: UK_VAT_STANDARD });
    const issued = await invoices.issue('i1');
    const note = await invoices.creditNote({
      creditNoteId: 'cn1', invoiceId: 'i1', reason: 'billed in error',
    });
    expect(issued.subtotal.amount).toBe(2_000);
    expect(issued.tax.amount).toBe(400);
    expect(note.subtotal.amount).toBe(-2_000);
    expect(note.tax.amount).toBe(-400);
    expect(add(issued.total, note.total).amount).toBe(0);
  });

  it('refuses a credit note larger than the net value of the invoice', async () => {
    const invoices = service();
    const rated = rateUsage(usage({ qualifiedOutcomes: 1 }), PLAN_CATALOGUE.growth);
    await invoices.assemble({ invoiceId: 'i1', accountId: 'a1', rated });
    await invoices.issue('i1');
    await expect(invoices.creditNote({
      creditNoteId: 'cn1', invoiceId: 'i1', amount: money(999_999), reason: 'oops',
    })).rejects.toThrow();
  });
});

describe('tax treatment', () => {
  it('charges UK VAT domestically', () => {
    expect(taxRateFor({ customerCountry: 'GB' }).treatment).toBe('standard');
  });

  it('reverse-charges a cross-border customer with a VAT number', () => {
    expect(taxRateFor({ customerCountry: 'DE', customerVatNumber: 'DE123456789' }).treatment)
      .toBe('reverse_charge');
  });

  it('does not invent a treatment for a cross-border customer without one', () => {
    // Erring towards charging tax is recoverable; failing to charge it is not.
    expect(taxRateFor({ customerCountry: 'DE' }).treatment).toBe('standard');
  });
});

describe('dunning', () => {
  const overdue = (days: number) => ({
    invoiceId: 'i1', accountId: 'a1', tenantId: 't_acme', status: 'open' as const,
    currency: 'GBP' as const, period: '2026-01', lines: [],
    creditsApplied: money(0), subtotal: money(10_000), tax: money(2_000),
    total: money(12_000), amountDue: money(12_000), amountPaid: money(0),
    createdAt: '2026-01-01T00:00:00.000Z', issuedAt: '2026-01-01T00:00:00.000Z',
    dueAt: new Date(Date.parse('2026-03-01T09:00:00.000Z') - days * 86_400_000).toISOString(),
  });

  it('does nothing while an invoice is merely late by a day', async () => {
    const service = new DunningService(new InMemoryDunningStore(), clock());
    const state = await service.assess('a1', [overdue(1)]);
    expect(state.stage).toBe('current');
  });

  it('degrades before it suspends', async () => {
    const service = new DunningService(new InMemoryDunningStore(), clock());
    expect((await service.assess('a1', [overdue(22)])).stage).toBe('degraded');
  });

  it('jumps to the rung actually reached rather than stepping through', async () => {
    const service = new DunningService(new InMemoryDunningStore(), clock());
    const state = await service.assess('a1', [overdue(40)]);
    expect(state.stage).toBe('suspended');
    expect(state.awaitingApproval).toBe(true);
  });

  it('will not suspend without a named operator', async () => {
    const service = new DunningService(new InMemoryDunningStore(), clock());
    const state = await service.assess('a1', [overdue(40)]);
    await expect(service.applyStep('a1', state.pendingStep!)).rejects.toThrow();
    await expect(service.applyStep('a1', state.pendingStep!, 'ops@detent')).resolves.toBeDefined();
  });

  it('respects a hold, because chasing an agreed payment plan loses accounts', async () => {
    const store = new InMemoryDunningStore();
    const service = new DunningService(store, clock());
    await service.hold('a1', '2026-06-01T00:00:00.000Z', 'payment plan agreed');
    expect((await service.assess('a1', [overdue(40)])).stage).toBe('current');
  });

  it('clears once nothing is overdue', async () => {
    const service = new DunningService(new InMemoryDunningStore(), clock());
    await service.assess('a1', [overdue(40)]);
    expect((await service.assess('a1', [])).stage).toBe('current');
  });
});
