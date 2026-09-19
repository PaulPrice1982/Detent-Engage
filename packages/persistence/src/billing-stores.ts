import type {
  Account, AccountStore, AccountSubscription, CreditLot, Invoice, InvoiceStore,
  LedgerEntry, LedgerStore, Subscription, SubscriptionStore,
} from '@detent/awa-billing';
import type { Database } from './database.js';

/**
 * Durable money.
 *
 * The rule these follow that the identity stores do not: anything that is
 * reported on gets a real column as well as its place in the document. "What
 * did we invoice in March" should be a query, not a scan that unpacks json.
 *
 * Amounts are bigint minor units. Never a float, 0.1 + 0.2 is not 0.3, and an
 * invoice that disagrees with itself by a penny costs more to explain than the
 * penny is worth.
 */

export class PostgresAccountStore implements AccountStore {
  constructor(private readonly database: Database) {}

  async get(accountId: string): Promise<Account | undefined> {
    const rows = await this.database.query<{ document: Account }>(
      'SELECT document FROM account WHERE account_id = $1', [accountId],
    );
    return rows[0]?.document;
  }

  async findByTenant(tenantId: string): Promise<Account | undefined> {
    const rows = await this.database.query<{ document: Account }>(
      'SELECT document FROM account WHERE tenant_id = $1', [tenantId],
    );
    return rows[0]?.document;
  }

  async put(account: Account): Promise<void> {
    await this.database.query(
      `INSERT INTO account (account_id, tenant_id, name, status, document)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id, name = EXCLUDED.name,
         status = EXCLUDED.status, document = EXCLUDED.document, updated_at = now()`,
      [account.accountId, account.tenantId, account.name, account.status,
        JSON.stringify(account)],
    );
  }

  async list(): Promise<readonly Account[]> {
    const rows = await this.database.query<{ document: Account }>(
      'SELECT document FROM account ORDER BY created_at',
    );
    return rows.map((row) => row.document);
  }

  async getSubscription(accountId: string): Promise<AccountSubscription | undefined> {
    const rows = await this.database.query<{ document: AccountSubscription }>(
      'SELECT document FROM account_subscription WHERE account_id = $1', [accountId],
    );
    return rows[0]?.document;
  }

  async putSubscription(subscription: AccountSubscription): Promise<void> {
    await this.database.query(
      `INSERT INTO account_subscription (account_id, plan_code, document)
       VALUES ($1, $2, $3)
       ON CONFLICT (account_id) DO UPDATE SET
         plan_code = EXCLUDED.plan_code, document = EXCLUDED.document, updated_at = now()`,
      [subscription.accountId, subscription.planCode, JSON.stringify(subscription)],
    );
  }
}

export class PostgresSubscriptionStore implements SubscriptionStore {
  constructor(private readonly database: Database) {}

  async put(subscription: Subscription): Promise<void> {
    await this.database.query(
      `INSERT INTO subscription
         (subscription_id, tenant_id, plan_code, plan_version, state, document)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (subscription_id) DO UPDATE SET
         plan_code = EXCLUDED.plan_code, plan_version = EXCLUDED.plan_version,
         state = EXCLUDED.state, document = EXCLUDED.document, updated_at = now()`,
      [
        subscription.subscriptionId, subscription.tenantId, subscription.planCode,
        // The version a subscription was sold on, lifted out because it is the
        // column that proves a price change did not reach an existing customer.
        (subscription as { planVersion?: number }).planVersion ?? null,
        (subscription as { state?: string }).state ?? 'active',
        JSON.stringify(subscription),
      ],
    );
  }

  async get(subscriptionId: string): Promise<Subscription | undefined> {
    const rows = await this.database.query<{ document: Subscription }>(
      'SELECT document FROM subscription WHERE subscription_id = $1', [subscriptionId],
    );
    return rows[0]?.document;
  }

  async byTenant(tenantId: string): Promise<Subscription | undefined> {
    const rows = await this.database.query<{ document: Subscription }>(
      'SELECT document FROM subscription WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [tenantId],
    );
    return rows[0]?.document;
  }

  async list(): Promise<Subscription[]> {
    const rows = await this.database.query<{ document: Subscription }>(
      'SELECT document FROM subscription ORDER BY updated_at DESC',
    );
    return rows.map((row) => row.document);
  }
}

export class PostgresInvoiceStore implements InvoiceStore {
  constructor(private readonly database: Database) {}

  async get(invoiceId: string): Promise<Invoice | undefined> {
    const rows = await this.database.query<{ document: Invoice }>(
      'SELECT document FROM invoice WHERE invoice_id = $1', [invoiceId],
    );
    return rows[0]?.document;
  }

  async put(invoice: Invoice): Promise<void> {
    await this.database.query(
      `INSERT INTO invoice
         (invoice_id, invoice_number, account_id, tenant_id, status, currency, period,
          subtotal_minor, tax_minor, total_minor, amount_due_minor, issued_at, paid_at, document)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (invoice_id) DO UPDATE SET
         invoice_number = EXCLUDED.invoice_number, status = EXCLUDED.status,
         subtotal_minor = EXCLUDED.subtotal_minor, tax_minor = EXCLUDED.tax_minor,
         total_minor = EXCLUDED.total_minor, amount_due_minor = EXCLUDED.amount_due_minor,
         issued_at = EXCLUDED.issued_at, paid_at = EXCLUDED.paid_at,
         document = EXCLUDED.document`,
      [
        invoice.invoiceId, invoice.number ?? null, invoice.accountId, invoice.tenantId,
        invoice.status, invoice.currency, invoice.period,
        invoice.subtotal.amount, invoice.tax.amount, invoice.total.amount,
        invoice.amountDue.amount,
        invoice.issuedAt ?? null, invoice.paidAt ?? null,
        JSON.stringify(invoice),
      ],
    );
  }

  async listByAccount(accountId: string): Promise<readonly Invoice[]> {
    const rows = await this.database.query<{ document: Invoice }>(
      'SELECT document FROM invoice WHERE account_id = $1 ORDER BY period, created_at',
      [accountId],
    );
    return rows.map((row) => row.document);
  }

  /**
   * The next invoice number for an entity and year.
   *
   * A single statement, so two requests issuing at once cannot both read the
   * same last number. Reading then writing would produce duplicate invoice
   * numbers under exactly the load that makes them hardest to unpick, and a
   * gapless sequence is a legal requirement rather than a nicety.
   */
  async nextNumber(entity: string, year: number): Promise<number> {
    const rows = await this.database.query<{ last_number: number }>(
      `INSERT INTO invoice_sequence (entity, year, last_number)
       VALUES ($1, $2, 1)
       ON CONFLICT (entity, year) DO UPDATE
         SET last_number = invoice_sequence.last_number + 1
       RETURNING last_number`,
      [entity, year],
    );
    return Number(rows[0]!.last_number);
  }
}

export class PostgresLedgerStore implements LedgerStore {
  constructor(private readonly database: Database) {}

  async appendEntry(entry: LedgerEntry): Promise<void> {
    await this.database.query(
      `INSERT INTO credit_ledger_entry
         (entry_id, account_id, sequence, idempotency_key, document)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        entry.entryId, entry.accountId, entry.sequence,
        entry.idempotencyKey ?? null, JSON.stringify(entry),
      ],
    );
  }

  async putLot(lot: CreditLot): Promise<void> {
    await this.database.query(
      `INSERT INTO credit_lot (lot_id, account_id, document)
       VALUES ($1, $2, $3)
       ON CONFLICT (lot_id) DO UPDATE SET document = EXCLUDED.document`,
      [lot.lotId, lot.accountId, JSON.stringify(lot)],
    );
  }

  async lots(accountId: string): Promise<CreditLot[]> {
    const rows = await this.database.query<{ document: CreditLot }>(
      'SELECT document FROM credit_lot WHERE account_id = $1 ORDER BY created_at', [accountId],
    );
    return rows.map((row) => row.document);
  }

  async entries(accountId: string): Promise<LedgerEntry[]> {
    // In sequence order, not insertion order. The ledger is read as a chain.
    const rows = await this.database.query<{ document: LedgerEntry }>(
      'SELECT document FROM credit_ledger_entry WHERE account_id = $1 ORDER BY sequence',
      [accountId],
    );
    return rows.map((row) => row.document);
  }

  async lastSequence(accountId: string): Promise<number> {
    const rows = await this.database.query<{ last: string | null }>(
      'SELECT max(sequence)::text AS last FROM credit_ledger_entry WHERE account_id = $1',
      [accountId],
    );
    return Number(rows[0]?.last ?? 0);
  }

  async findByIdempotencyKey(accountId: string, key: string): Promise<LedgerEntry | undefined> {
    const rows = await this.database.query<{ document: LedgerEntry }>(
      'SELECT document FROM credit_ledger_entry WHERE account_id = $1 AND idempotency_key = $2',
      [accountId, key],
    );
    return rows[0]?.document;
  }
}
