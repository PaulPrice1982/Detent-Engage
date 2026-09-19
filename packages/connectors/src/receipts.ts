import { newId, type CanonicalOperation, type Clock, type WriteReceipt, type WriteReceiptState, systemClock } from '@detent/awa-core';

/**
 * Write receipts (section 16.5).
 *
 * The receipt is written before the external call and confirmed after it. That
 * ordering is the whole mechanism: a crash between call and confirmation leaves
 * a PENDING receipt, which reconciliation can resolve by reading back, whereas
 * a receipt written after the call would leave no trace of the attempt at all.
 */
export interface WriteReceiptStore {
  find(tenantId: string, idempotencyKey: string): Promise<WriteReceipt | undefined>;
  put(receipt: WriteReceipt): Promise<void>;
  listByState(tenantId: string, state: WriteReceiptState): Promise<WriteReceipt[]>;
}

export class InMemoryWriteReceiptStore implements WriteReceiptStore {
  private readonly receipts = new Map<string, WriteReceipt>();
  private key(tenantId: string, idempotencyKey: string): string { return `${tenantId}::${idempotencyKey}`; }

  async find(tenantId: string, idempotencyKey: string): Promise<WriteReceipt | undefined> {
    return this.receipts.get(this.key(tenantId, idempotencyKey));
  }
  async put(receipt: WriteReceipt): Promise<void> {
    this.receipts.set(this.key(receipt.tenantId, receipt.idempotencyKey), receipt);
  }
  async listByState(tenantId: string, state: WriteReceiptState): Promise<WriteReceipt[]> {
    return [...this.receipts.values()].filter((r) => r.tenantId === tenantId && r.state === state);
  }
}

export class WriteReceiptService {
  constructor(
    private readonly store: WriteReceiptStore,
    private readonly clock: Clock = systemClock,
  ) {}

  /**
   * Claim an idempotency key. Returns the existing receipt when the same
   * logical write has already been confirmed, which is how a retried tool call
   * returns the original external id instead of creating a second record.
   */
  async claim(input: {
    tenantId: string;
    correlationId: string;
    idempotencyKey: string;
    connector: string;
    operation: CanonicalOperation;
  }): Promise<{ receipt: WriteReceipt; alreadyConfirmed: boolean }> {
    const existing = await this.store.find(input.tenantId, input.idempotencyKey);
    if (existing?.state === 'CONFIRMED') {
      return { receipt: existing, alreadyConfirmed: true };
    }

    const now = this.clock.iso();
    const receipt: WriteReceipt = existing
      ? { ...existing, state: 'PENDING', attempts: existing.attempts + 1, updatedAt: now }
      : {
          id: newId('wr', this.clock.nowMs()),
          tenantId: input.tenantId,
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
          connector: input.connector,
          operation: input.operation,
          state: 'PENDING',
          attempts: 1,
          createdAt: now,
          updatedAt: now,
        };
    await this.store.put(receipt);
    return { receipt, alreadyConfirmed: false };
  }

  async confirm(receipt: WriteReceipt, externalId: string): Promise<WriteReceipt> {
    const updated: WriteReceipt = { ...receipt, state: 'CONFIRMED', externalId, updatedAt: this.clock.iso() };
    await this.store.put(updated);
    return updated;
  }

  async fail(receipt: WriteReceipt, error: string, retryable: boolean): Promise<WriteReceipt> {
    const updated: WriteReceipt = {
      ...receipt,
      // A retryable failure stays in the reconciliation queue rather than being
      // recorded as a final failure. Section 28: repair asynchronously.
      state: retryable ? 'RECONCILING' : 'FAILED',
      lastError: error,
      updatedAt: this.clock.iso(),
    };
    await this.store.put(updated);
    return updated;
  }

  async pendingReconciliation(tenantId: string): Promise<WriteReceipt[]> {
    return this.store.listByState(tenantId, 'RECONCILING');
  }
}
