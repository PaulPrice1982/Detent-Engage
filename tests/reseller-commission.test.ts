import { describe, expect, it } from 'vitest';
import {
  CommissionCalculator, ResellerService, TerritoryRegistry, assertBands, nextBand,
  postcodeArea, type AccountLink,
} from '@detent/awa-reseller';
import { money, type Invoice, type InvoiceStatus } from '@detent/awa-billing';

/**
 * Commission is money paid to a third party on the strength of these numbers.
 * Every case here is one a channel business gets wrong at least once.
 */

function invoice(over: {
  id: string; accountId: string; period: string; status: InvoiceStatus;
  subtotal: number; tax?: number; issuedAt?: string; paidAt?: string; currency?: 'GBP' | 'EUR';
}): Invoice {
  const currency = over.currency ?? 'GBP';
  const subtotal = money(over.subtotal, currency);
  const tax = money(over.tax ?? 0, currency);
  return {
    invoiceId: over.id,
    accountId: over.accountId,
    tenantId: `t_${over.accountId}`,
    status: over.status,
    currency,
    period: over.period,
    lines: [],
    creditsApplied: money(0, currency),
    subtotal,
    tax,
    total: money(subtotal.amount + tax.amount, currency),
    amountDue: money(0, currency),
    amountPaid: money(0, currency),
    createdAt: over.issuedAt ?? '2026-02-01T00:00:00.000Z',
    issuedAt: over.issuedAt ?? '2026-02-01T00:00:00.000Z',
    paidAt: over.paidAt,
  } as Invoice;
}

/**
 * A reseller on individually negotiated flat terms.
 *
 * `banded: false` is stated rather than assumed: since the volume programme
 * exists, a reseller with no answer either way is on it, and these cases are
 * about flat-rate mechanics, VAT, collection, and who held the customer.
 */
const RESELLER = {
  resellerId: 'rsl_1', name: 'Northgate Systems', contactEmail: 'ops@northgate.test',
  status: 'active' as const, marginBasisPoints: 1500, banded: false,
  agreementStart: '2026-01-01', createdAt: '2026-01-01T00:00:00.000Z', createdBy: 'ops',
};

/** The same reseller, on the published volume programme. */
const BANDED = { ...RESELLER, banded: true };

const link = (over: Partial<AccountLink> = {}): AccountLink => ({
  accountId: 'acct_1', resellerId: 'rsl_1', since: '2026-01-01T00:00:00.000Z',
  linkedBy: 'ops', ...over,
});

const calculator = new CommissionCalculator();

describe('what a reseller earns on', () => {
  it('pays on the net amount, never on the VAT', () => {
    // VAT is collected for HMRC and is not revenue. Paying 15% of it is
    // paying 15% of somebody else's money.
    const statement = calculator.statement({
      reseller: RESELLER, links: [link()], period: '2026-02',
      invoices: [invoice({
        id: 'inv_1', accountId: 'acct_1', period: '2026-02', status: 'paid',
        subtotal: 100_000, tax: 20_000, paidAt: '2026-02-10T00:00:00.000Z',
      })],
    });
    // 15% of £1,000.00 net, not of £1,200.00 gross.
    expect(statement.commissionEarned.amount).toBe(15_000);
    expect(statement.collectedSpend.amount).toBe(100_000);
  });

  it('holds an unpaid invoice as pending rather than paying it', () => {
    // Paying on an invoice the customer never settles means clawing it back,
    // which is the most damaging conversation in a channel relationship.
    const statement = calculator.statement({
      reseller: RESELLER, links: [link()], period: '2026-02',
      invoices: [invoice({
        id: 'inv_1', accountId: 'acct_1', period: '2026-02', status: 'open',
        subtotal: 100_000, tax: 20_000,
      })],
    });
    expect(statement.commissionEarned.amount).toBe(0);
    expect(statement.commissionPending.amount).toBe(15_000);
    expect(statement.lines[0]?.state).toBe('pending');
  });

  it('ignores draft, void and written-off invoices', () => {
    const statement = calculator.statement({
      reseller: RESELLER, links: [link()], period: '2026-02',
      invoices: [
        // Not issued: still editable, so promising commission against it
        // promises money against a figure that can still change.
        invoice({ id: 'inv_d', accountId: 'acct_1', period: '2026-02', status: 'draft', subtotal: 50_000 }),
        // Cancelled: never owed.
        invoice({ id: 'inv_v', accountId: 'acct_1', period: '2026-02', status: 'void', subtotal: 50_000 }),
        // Written off: paying commission on revenue we have accepted we will
        // never collect means the write-off costs us twice.
        invoice({ id: 'inv_u', accountId: 'acct_1', period: '2026-02', status: 'uncollectible', subtotal: 50_000 }),
      ],
    });
    expect(statement.lines).toHaveLength(0);
    expect(statement.commissionEarned.amount).toBe(0);
    expect(statement.commissionPending.amount).toBe(0);
  });
});

describe('which margin applies', () => {
  it('uses the customer-specific override in preference to the standard rate', () => {
    const statement = calculator.statement({
      reseller: RESELLER,
      links: [link({ marginBasisPoints: 2000 })],
      period: '2026-02',
      invoices: [invoice({
        id: 'inv_1', accountId: 'acct_1', period: '2026-02', status: 'paid',
        subtotal: 100_000, paidAt: '2026-02-10T00:00:00.000Z',
      })],
    });
    expect(statement.commissionEarned.amount).toBe(20_000); // 20%, not 15%
  });

  it('pays the reseller who held the customer when the invoice was raised', () => {
    // A customer who moved in March still earns their old reseller commission
    // on February. Reassigning history to whoever holds them today would
    // restate every past statement.
    const statement = calculator.statement({
      reseller: RESELLER,
      links: [link({ since: '2026-01-01T00:00:00.000Z', until: '2026-03-01T00:00:00.000Z' })],
      period: '2026-02',
      invoices: [invoice({
        id: 'inv_feb', accountId: 'acct_1', period: '2026-02', status: 'paid',
        issuedAt: '2026-02-01T00:00:00.000Z', paidAt: '2026-02-10T00:00:00.000Z',
        subtotal: 100_000,
      })],
    });
    expect(statement.commissionEarned.amount).toBe(15_000);

    // The following month, after they left, earns them nothing.
    const after = calculator.statement({
      reseller: RESELLER,
      links: [link({ since: '2026-01-01T00:00:00.000Z', until: '2026-03-01T00:00:00.000Z' })],
      period: '2026-03',
      invoices: [invoice({
        id: 'inv_mar', accountId: 'acct_1', period: '2026-03', status: 'paid',
        issuedAt: '2026-03-05T00:00:00.000Z', paidAt: '2026-03-10T00:00:00.000Z',
        subtotal: 100_000,
      })],
    });
    expect(after.lines).toHaveLength(0);
  });

  it('earns nothing on a customer who was never theirs', () => {
    const statement = calculator.statement({
      reseller: RESELLER, links: [link({ accountId: 'acct_1' })], period: '2026-02',
      invoices: [invoice({
        id: 'inv_x', accountId: 'acct_other', period: '2026-02', status: 'paid',
        subtotal: 100_000, paidAt: '2026-02-10T00:00:00.000Z',
      })],
    });
    expect(statement.lines).toHaveLength(0);
  });
});

describe('statements as a whole', () => {
  it('refuses to mix currencies in one total', () => {
    // A total across two currencies is not money, and a statement nobody can
    // reconcile is worse than a refusal.
    expect(() => calculator.statement({
      reseller: RESELLER, links: [link()], period: '2026-02', currency: 'GBP',
      invoices: [invoice({
        id: 'inv_eur', accountId: 'acct_1', period: '2026-02', status: 'paid',
        subtotal: 100_000, currency: 'EUR', paidAt: '2026-02-10T00:00:00.000Z',
      })],
    })).toThrow(/per currency/);
  });

  it('adds up a lifetime across periods', () => {
    const invoices = [
      invoice({ id: 'i1', accountId: 'acct_1', period: '2026-01', status: 'paid', subtotal: 100_000, issuedAt: '2026-01-01T00:00:00.000Z', paidAt: '2026-01-09T00:00:00.000Z' }),
      invoice({ id: 'i2', accountId: 'acct_1', period: '2026-02', status: 'paid', subtotal: 100_000, paidAt: '2026-02-09T00:00:00.000Z' }),
      invoice({ id: 'i3', accountId: 'acct_1', period: '2026-03', status: 'open', subtotal: 100_000, issuedAt: '2026-03-01T00:00:00.000Z' }),
    ];
    const statements = calculator.statements({ reseller: RESELLER, links: [link()], invoices });
    expect(statements).toHaveLength(3);
    expect(statements[0]?.period).toBe('2026-03'); // newest first

    const lifetime = calculator.lifetime(statements);
    expect(lifetime.commissionEarned.amount).toBe(30_000); // two paid months
    expect(lifetime.commissionPending.amount).toBe(15_000); // one unpaid
    expect(lifetime.collectedSpend.amount).toBe(200_000);
  });
});

describe('the volume programme', () => {
  it('starts a new reseller at 20%', () => {
    const statement = calculator.statement({
      reseller: BANDED, links: [link()], period: '2026-02',
      invoices: [invoice({
        id: 'inv_1', accountId: 'acct_1', period: '2026-02', status: 'paid',
        subtotal: 100_000, paidAt: '2026-02-10T00:00:00.000Z',
      })],
    });
    expect(statement.band?.basisPoints).toBe(2000);
    expect(statement.commissionEarned.amount).toBe(20_000);
  });

  it('lifts the rate as the book grows', () => {
    // £30,000 collected puts them in the top band, and the 50% rate applies to
    // the whole period rather than only to the amount above the threshold.
    const history = Array.from({ length: 3 }, (unused, index) => invoice({
      id: `inv_h${index}`, accountId: 'acct_1', period: '2026-01', status: 'paid',
      subtotal: 1_000_000, issuedAt: '2026-01-01T00:00:00.000Z',
      paidAt: '2026-01-15T00:00:00.000Z',
    }));
    const statement = calculator.statement({
      reseller: BANDED, links: [link()], period: '2026-02',
      invoices: [...history, invoice({
        id: 'inv_now', accountId: 'acct_1', period: '2026-02', status: 'paid',
        subtotal: 100_000, paidAt: '2026-02-10T00:00:00.000Z',
      })],
    });
    expect(statement.band?.label).toBe('Principal');
    expect(statement.band?.basisPoints).toBe(5000);
    expect(statement.commissionEarned.amount).toBe(50_000);
  });

  it('does not let unpaid invoices lift a reseller into a higher band', () => {
    // Paying a better rate on the strength of money nobody has collected is
    // how a band becomes a liability.
    const statement = calculator.statement({
      reseller: BANDED, links: [link()], period: '2026-02',
      invoices: [
        invoice({
          id: 'inv_unpaid', accountId: 'acct_1', period: '2026-01', status: 'open',
          subtotal: 5_000_000, issuedAt: '2026-01-01T00:00:00.000Z',
        }),
        invoice({
          id: 'inv_paid', accountId: 'acct_1', period: '2026-02', status: 'paid',
          subtotal: 100_000, paidAt: '2026-02-10T00:00:00.000Z',
        }),
      ],
    });
    expect(statement.band?.basisPoints).toBe(2000); // still the entry band
  });

  it('lets a customer-specific rate outrank the band', () => {
    // It was negotiated for a reason. Having it silently overtaken by a band
    // would change a signed number without anybody deciding to.
    const statement = calculator.statement({
      reseller: BANDED, links: [link({ marginBasisPoints: 2500 })], period: '2026-02',
      invoices: [invoice({
        id: 'inv_1', accountId: 'acct_1', period: '2026-02', status: 'paid',
        subtotal: 100_000, paidAt: '2026-02-10T00:00:00.000Z',
      })],
    });
    expect(statement.commissionEarned.amount).toBe(25_000);
  });
});

describe('exclusive territories', () => {
  it('reads the area out of a full postcode', () => {
    expect(postcodeArea('M1 4BT')).toBe('M');
    expect(postcodeArea('eh12 9dn')).toBe('EH');
    expect(postcodeArea('W1A1AA')).toBe('W');
    expect(postcodeArea('not a postcode')).toBeUndefined();
  });

  it('refuses to grant an area somebody already holds', async () => {
    // Recording it and sorting it out later means two resellers have both been
    // promised exclusivity in writing, and one promise has to be broken.
    const registry = new TerritoryRegistry();
    await registry.grant({ area: 'M', resellerId: 'rsl_1', grantedBy: 'ops', at: '2026-01-01' });
    await expect(registry.grant({
      area: 'M', resellerId: 'rsl_2', grantedBy: 'ops', at: '2026-01-02',
    })).rejects.toThrow(/already held exclusively/);
    // Re-granting to the same reseller is not a clash, and a full postcode
    // resolves to the same area.
    await registry.grant({
      area: 'm1 4bt', resellerId: 'rsl_1', grantedBy: 'ops', at: '2026-01-02',
    });
    expect(await registry.heldBy('rsl_1')).toEqual(['M']);
  });

  it('routes a lead to the reseller holding its postcode area', async () => {
    const registry = new TerritoryRegistry();
    await registry.grant({
      area: 'EH', resellerId: 'rsl_scot', grantedBy: 'ops', at: '2026-01-01',
    });
    expect(await registry.resellerForPostcode('EH12 9DN')).toBe('rsl_scot');
    // An unheld area belongs to nobody and is worked directly. Giving it to
    // the nearest reseller would be a guess with commission attached.
    expect(await registry.resellerForPostcode('M1 4BT')).toBeUndefined();
    expect(await registry.resellerForPostcode(undefined)).toBeUndefined();
  });

  it('refuses a territory that is not a postcode area', async () => {
    const registry = new TerritoryRegistry();
    await expect(registry.grant({
      area: 'Manchester', resellerId: 'rsl_1', grantedBy: 'ops', at: '2026-01-01',
    })).rejects.toThrow(/not a postcode area/);
  });
});

describe('band tables', () => {
  it('refuses a table that does not start at zero', () => {
    // A new reseller's first sale would fall through every band and earn
    // nothing.
    expect(() => assertBands([{ fromAmount: 100, basisPoints: 2000, label: 'x' }]))
      .toThrow(/start at zero/);
  });

  it('refuses bands out of order', () => {
    expect(() => assertBands([
      { fromAmount: 0, basisPoints: 2000, label: 'a' },
      { fromAmount: 0, basisPoints: 3000, label: 'b' },
    ])).toThrow(/ascending/);
  });

  it('says what the next band takes', () => {
    const next = nextBand(money(1_000_00));
    expect(next?.band.label).toBe('Silver');
    expect(next?.shortfall).toBe(1_500_00);
    // Nothing above the top band.
    expect(nextBand(money(99_999_00))).toBeUndefined();
  });
});

describe('the reseller register', () => {
  it('refuses a margin above 100%', async () => {
    // A margin over 100% pays out more than the customer paid in.
    const service = new ResellerService();
    await expect(service.create({
      name: 'Greedy Ltd', contactEmail: 'a@b.c', marginBasisPoints: 10_001,
      agreementStart: '2026-01-01', createdBy: 'ops',
    })).rejects.toThrow(/100%/);
  });

  it('refuses a fractional basis point', async () => {
    const service = new ResellerService();
    await expect(service.create({
      name: 'Odd Ltd', contactEmail: 'a@b.c', marginBasisPoints: 1500.5,
      agreementStart: '2026-01-01', createdBy: 'ops',
    })).rejects.toThrow(/whole basis points/);
  });

  it('closes the previous link when a customer moves reseller', async () => {
    const service = new ResellerService();
    const first = await service.create({
      name: 'First', contactEmail: 'a@b.c', marginBasisPoints: 1500,
      agreementStart: '2026-01-01', createdBy: 'ops',
    });
    const second = await service.create({
      name: 'Second', contactEmail: 'd@e.f', marginBasisPoints: 1000,
      agreementStart: '2026-01-01', createdBy: 'ops',
    });

    await service.linkAccount({ accountId: 'acct_1', resellerId: first.resellerId, linkedBy: 'ops' });
    await service.linkAccount({ accountId: 'acct_1', resellerId: second.resellerId, linkedBy: 'ops' });

    const history = await service.linkHistory('acct_1');
    expect(history).toHaveLength(2);
    expect(history[0]?.until).toBeDefined();   // closed, not deleted
    expect(history[1]?.until).toBeUndefined(); // current

    expect((await service.linkFor('acct_1'))?.resellerId).toBe(second.resellerId);
    expect(await service.accountsFor(first.resellerId)).toHaveLength(0);
    // The old reseller's history survives, so past statements still resolve.
    expect(await service.allLinksFor(first.resellerId)).toHaveLength(1);
  });

  it('applies the override margin when one is set, and the standard when not', async () => {
    const service = new ResellerService();
    const reseller = await service.create({
      name: 'Standard', contactEmail: 'a@b.c', marginBasisPoints: 1500,
      agreementStart: '2026-01-01', createdBy: 'ops',
    });
    await service.linkAccount({ accountId: 'acct_std', resellerId: reseller.resellerId, linkedBy: 'ops' });
    await service.linkAccount({
      accountId: 'acct_neg', resellerId: reseller.resellerId, linkedBy: 'ops',
      marginBasisPoints: 2250,
    });
    expect(await service.marginFor('acct_std')).toBe(1500);
    expect(await service.marginFor('acct_neg')).toBe(2250);
    expect(await service.marginFor('acct_unknown')).toBeUndefined();
  });
});
