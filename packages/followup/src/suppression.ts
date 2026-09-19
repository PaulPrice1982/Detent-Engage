import { createHash } from 'node:crypto';
import type { Clock } from '@detent/awa-core';
import { systemClock } from '@detent/awa-core';

/**
 * The global suppression list (FR-057).
 *
 * "A global suppression list operates across all tenants for any address that
 * has opted out anywhere, which no competitor offers and which materially
 * reduces tenant risk."
 *
 * The obvious objection is that this is cross-tenant state in a product whose
 * central claim is tenant isolation. The reconciliation: addresses are stored
 * as salted digests and never as plaintext, so the list cannot be read back as
 * a customer list; the only operation it supports is "is this address
 * suppressed", answered yes or no; and it is *only* consulted to refuse a send.
 * It can stop a message and it can never cause one, which is why the isolation
 * argument does not apply to it in the direction that matters.
 */
export interface SuppressionRecord {
  readonly digest: string;
  readonly suppressedAt: string;
  readonly reason: 'opt_out' | 'bounce' | 'complaint' | 'tenant_request';
  /** The tenant whose message prompted the opt-out. Not the scope of it. */
  readonly originTenantId: string;
}

export interface SuppressionStore {
  add(record: SuppressionRecord): Promise<void>;
  has(digest: string): Promise<boolean>;
  count(): Promise<number>;
}

export class InMemorySuppressionStore implements SuppressionStore {
  private readonly records = new Map<string, SuppressionRecord>();
  async add(record: SuppressionRecord): Promise<void> { this.records.set(record.digest, record); }
  async has(digest: string): Promise<boolean> { return this.records.has(digest); }
  async count(): Promise<number> { return this.records.size; }
}

export class SuppressionList {
  constructor(
    private readonly store: SuppressionStore,
    /** Platform-wide salt. Rotating it would orphan the list, so it does not rotate. */
    private readonly salt: string,
    private readonly clock: Clock = systemClock,
  ) {}

  private digest(email: string): string {
    return createHash('sha256').update(`${this.salt}:${email.trim().toLowerCase()}`).digest('hex');
  }

  async suppress(email: string, reason: SuppressionRecord['reason'], originTenantId: string): Promise<void> {
    await this.store.add({
      digest: this.digest(email),
      suppressedAt: this.clock.iso(),
      reason,
      originTenantId,
    });
  }

  async isSuppressed(email: string): Promise<boolean> {
    return this.store.has(this.digest(email));
  }

  async size(): Promise<number> {
    return this.store.count();
  }
}

/**
 * Platform-enforced frequency caps (FR-057).
 *
 * "Frequency caps are platform-enforced, not tenant-configurable upward." A
 * tenant may set a lower cap; `effectiveCap` takes the minimum, so a tenant
 * configuration of 50 does not raise the ceiling.
 */
export const PLATFORM_MAX_FOLLOWUPS_PER_CONVERSATION = 1;
export const PLATFORM_MAX_FOLLOWUPS_PER_RECIPIENT_PER_30_DAYS = 3;

export function effectiveCap(tenantConfigured: number): number {
  return Math.min(tenantConfigured, PLATFORM_MAX_FOLLOWUPS_PER_CONVERSATION);
}

export interface SendRecord {
  readonly tenantId: string;
  readonly recipientDigest: string;
  readonly conversationId: string;
  readonly sentAt: string;
  readonly lane: string;
}

export class FrequencyLedger {
  private readonly sends: SendRecord[] = [];

  constructor(
    private readonly salt: string,
    private readonly clock: Clock = systemClock,
  ) {}

  private digest(email: string): string {
    return createHash('sha256').update(`${this.salt}:${email.trim().toLowerCase()}`).digest('hex');
  }

  record(tenantId: string, email: string, conversationId: string, lane: string): void {
    this.sends.push({
      tenantId,
      recipientDigest: this.digest(email),
      conversationId,
      sentAt: this.clock.iso(),
      lane,
    });
  }

  countForConversation(conversationId: string, lane: string): number {
    return this.sends.filter((send) => send.conversationId === conversationId && send.lane === lane).length;
  }

  /** Across every tenant, because the cap protects the recipient, not the tenant. */
  countForRecipientInWindow(email: string, days: number): number {
    const digest = this.digest(email);
    const cutoff = new Date(this.clock.nowMs() - days * 86_400_000).toISOString();
    return this.sends.filter((send) => send.recipientDigest === digest && send.sentAt >= cutoff).length;
  }
}
