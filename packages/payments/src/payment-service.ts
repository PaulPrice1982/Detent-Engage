import type { AuditLog } from '@detent/awa-audit';
import { AwaError, type Clock, systemClock } from '@detent/awa-core';
import { isPositive, type Money } from '@detent/awa-billing';
import {
  assertNoCardData, type PaymentIntent, type PaymentMethodSummary, type PaymentProvider,
  type ProviderRef, type RefundResult,
} from './payment-provider.js';

/**
 * Payments, with the record-keeping the provider does not do for us.
 *
 * Two things live here that a PSP will not give you:
 *
 *  1. **Idempotency you can prove.** The provider deduplicates by key, but only
 *     within its own retention window and only if the key reached it. A local
 *     record means a repeated charge is refused before it leaves the building,
 *     and the refusal is auditable.
 *  2. **The link between a payment and what it was for.** A PSP knows it took
 *     £420; it does not know that settled invoice DETENT-GB-2026-00042, which
 *     is the question finance actually asks.
 */

export interface PaymentRecord {
  readonly paymentId: string;
  readonly accountId: string;
  readonly providerRef: ProviderRef;
  readonly amount: Money;
  readonly status: PaymentIntent['status'];
  readonly description: string;
  readonly idempotencyKey: string;
  readonly reference?: string;
  readonly failureCode?: string;
  readonly createdAt: string;
  readonly settledAt?: string;
  readonly refundedAmount?: Money;
}

export interface PaymentStore {
  get(paymentId: string): Promise<PaymentRecord | undefined>;
  findByIdempotencyKey(key: string): Promise<PaymentRecord | undefined>;
  put(record: PaymentRecord): Promise<void>;
  listByAccount(accountId: string): Promise<readonly PaymentRecord[]>;
  /** Webhook ids already handled, so a replay changes nothing. */
  hasProcessedEvent(eventId: string): Promise<boolean>;
  markEventProcessed(eventId: string): Promise<void>;
}

export class InMemoryPaymentStore implements PaymentStore {
  private readonly payments = new Map<string, PaymentRecord>();
  private readonly byKey = new Map<string, string>();
  private readonly events = new Set<string>();

  async get(paymentId: string): Promise<PaymentRecord | undefined> {
    return this.payments.get(paymentId);
  }
  async findByIdempotencyKey(key: string): Promise<PaymentRecord | undefined> {
    const id = this.byKey.get(key);
    return id ? this.payments.get(id) : undefined;
  }
  async put(record: PaymentRecord): Promise<void> {
    this.payments.set(record.paymentId, record);
    this.byKey.set(record.idempotencyKey, record.paymentId);
  }
  async listByAccount(accountId: string): Promise<readonly PaymentRecord[]> {
    return [...this.payments.values()]
      .filter((record) => record.accountId === accountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async hasProcessedEvent(eventId: string): Promise<boolean> {
    return this.events.has(eventId);
  }
  async markEventProcessed(eventId: string): Promise<void> {
    this.events.add(eventId);
  }
}

export interface TakePaymentInput {
  readonly paymentId: string;
  readonly accountId: string;
  readonly tenantId: string;
  readonly amount: Money;
  readonly paymentMethodRef: ProviderRef;
  readonly description: string;
  readonly idempotencyKey: string;
  readonly reference?: string;
  /** False when an operator is taking the payment with the customer present. */
  readonly offSession?: boolean;
  /** Who initiated it. Recorded; required for an operator-taken payment. */
  readonly actor: string;
}

export class PaymentService {
  /** Serialises per account so two charges cannot both read a stale record. */
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly provider: PaymentProvider,
    private readonly store: PaymentStore,
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
  ) {}

  private serialise<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(accountId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.queues.set(accountId, next.catch(() => undefined));
    return next;
  }

  /** Begins hosted collection. The card is entered on the provider's page. */
  async startSetup(accountId: string, returnUrl: string): Promise<{ url: string; ref: ProviderRef }> {
    const session = await this.provider.startSetup({ accountId, returnUrl });
    return { url: session.url, ref: session.ref };
  }

  async paymentMethods(accountId: string): Promise<readonly PaymentMethodSummary[]> {
    return this.provider.listPaymentMethods(accountId);
  }

  /**
   * Takes a payment.
   *
   * Idempotent by key: a repeat returns the original record rather than
   * charging again. This is checked locally before the provider is called, so a
   * duplicate never reaches the network.
   */
  async take(input: TakePaymentInput): Promise<PaymentRecord> {
    if (!isPositive(input.amount)) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'A payment must be for a positive amount.' });
    }
    if (!input.idempotencyKey.trim()) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'A payment requires an idempotency key.' });
    }
    // The guard is here because this is where a well-meaning caller would pass
    // a card number if the system ever let them.
    assertNoCardData(input.description, 'payment.description');
    assertNoCardData(input.reference, 'payment.reference');

    return this.serialise(input.accountId, async () => {
      const existing = await this.store.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return existing;

      let intent: PaymentIntent;
      try {
        intent = await this.provider.charge({
          accountId: input.accountId,
          amount: input.amount,
          paymentMethodRef: input.paymentMethodRef,
          description: input.description,
          idempotencyKey: input.idempotencyKey,
          reference: input.reference,
          offSession: input.offSession ?? true,
        });
      } catch (error) {
        // A provider outage must still leave a record, or a retry with the same
        // key cannot be recognised as a retry.
        const failed: PaymentRecord = {
          paymentId: input.paymentId, accountId: input.accountId,
          providerRef: '' as ProviderRef, amount: input.amount, status: 'failed',
          description: input.description, idempotencyKey: input.idempotencyKey,
          reference: input.reference, failureCode: 'provider_unavailable',
          createdAt: this.clock.iso(),
        };
        await this.store.put(failed);
        await this.writeAudit(input.tenantId, 'payment_failed', failed, input.actor,
          error instanceof Error ? error.message : 'provider unavailable');
        return failed;
      }

      const record: PaymentRecord = {
        paymentId: input.paymentId,
        accountId: input.accountId,
        providerRef: intent.ref,
        amount: input.amount,
        status: intent.status,
        description: input.description,
        idempotencyKey: input.idempotencyKey,
        reference: input.reference,
        failureCode: intent.failureCode,
        createdAt: this.clock.iso(),
        settledAt: intent.status === 'succeeded' ? this.clock.iso() : undefined,
      };
      await this.store.put(record);
      await this.writeAudit(
        input.tenantId,
        intent.status === 'succeeded' ? 'payment_taken' : 'payment_failed',
        record, input.actor, intent.failureMessage,
      );
      return record;
    });
  }

  /**
   * Refunds a settled payment.
   *
   * Refunds are never automatic. This is called only by an approved operator
   * action, money leaving the business is a decision, and it needs a name
   * against it and a reason in the log.
   */
  async refund(input: {
    readonly paymentId: string;
    readonly tenantId: string;
    readonly amount?: Money;
    readonly reason: string;
    readonly idempotencyKey: string;
    readonly actor: string;
  }): Promise<RefundResult> {
    const record = await this.store.get(input.paymentId);
    if (!record) throw new AwaError({ kind: 'NOT_FOUND', message: `No payment ${input.paymentId}.` });
    if (record.status !== 'succeeded') {
      throw new AwaError({
        kind: 'CONFLICT',
        message: `Only a settled payment can be refunded; this one is ${record.status}.`,
      });
    }
    if (!input.reason.trim()) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'A refund requires a reason.' });
    }
    const already = record.refundedAmount?.amount ?? 0;
    const requested = input.amount?.amount ?? (record.amount.amount - already);
    if (requested <= 0) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'A refund must be for a positive amount.' });
    }
    if (already + requested > record.amount.amount) {
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: 'Refunds cannot exceed the payment they refund.',
      });
    }

    const result = await this.provider.refund({
      paymentRef: record.providerRef,
      amount: { amount: requested, currency: record.amount.currency },
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    });

    if (result.status !== 'failed') {
      await this.store.put({
        ...record,
        refundedAmount: { amount: already + requested, currency: record.amount.currency },
      });
    }
    await this.audit.write({
      tenantId: input.tenantId, type: 'payment_refunded', actor: 'platform_admin',
      // A refund is correlated to the payment it reverses, so the pair replays
      // together from the audit log.
      correlationId: record.paymentId,
      payload: {
        paymentId: record.paymentId, amount: requested, currency: record.amount.currency,
        reason: input.reason, status: result.status, actor: input.actor,
      },
    });
    return result;
  }

  /**
   * Handles a provider webhook.
   *
   * Signature first, then replay check, then act. A webhook is an unauthenticated
   * HTTP request until its signature is verified, and providers retry, so the
   * same event arrives more than once as a matter of course rather than as an
   * attack.
   */
  async handleWebhook(rawBody: string, signature: string, tenantId: string): Promise<{
    readonly handled: boolean;
    readonly reason?: string;
  }> {
    const event = await this.provider.verifyWebhook(rawBody, signature);
    if (await this.store.hasProcessedEvent(event.id)) {
      return { handled: false, reason: 'already_processed' };
    }
    await this.store.markEventProcessed(event.id);

    const ref = typeof event.payload['payment_ref'] === 'string'
      ? (event.payload['payment_ref'] as string)
      : undefined;

    if (ref) {
      const records = [...(await this.store.listByAccount(
        typeof event.payload['account_id'] === 'string' ? event.payload['account_id'] as string : '',
      ))];
      const record = records.find((candidate) => candidate.providerRef === ref);
      if (record) {
        const status = event.type.endsWith('succeeded') ? 'succeeded'
          : event.type.endsWith('failed') ? 'failed'
          : record.status;
        await this.store.put({
          ...record,
          status,
          settledAt: status === 'succeeded' ? this.clock.iso() : record.settledAt,
        });
      }
    }

    await this.audit.write({
      tenantId, type: 'payment_webhook_received', actor: 'system',
      correlationId: event.id,
      payload: { eventId: event.id, eventType: event.type },
    });
    return { handled: true };
  }

  async listByAccount(accountId: string): Promise<readonly PaymentRecord[]> {
    return this.store.listByAccount(accountId);
  }

  private async writeAudit(
    tenantId: string,
    type: 'payment_taken' | 'payment_failed',
    record: PaymentRecord,
    actor: string,
    detail?: string,
  ): Promise<void> {
    await this.audit.write({
      tenantId, type, actor: 'platform_admin',
      correlationId: record.paymentId,
      payload: {
        paymentId: record.paymentId,
        // The provider reference is recorded; nothing about the card is.
        providerRef: record.providerRef,
        amount: record.amount.amount,
        currency: record.amount.currency,
        status: record.status,
        reference: record.reference,
        actor,
        detail,
      },
    });
  }
}
