import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Money } from '@detent/awa-billing';
import {
  assertNoCardData, type ChargeInput, type PaymentIntent, type PaymentMethodSummary,
  type PaymentProvider, type ProviderRef, type RefundResult, type SetupInput,
  type SetupSession, type WebhookEvent,
} from './payment-provider.js';

/**
 * A sandbox PSP.
 *
 * Present for the same reason the sandbox CRM connector is: the system must be
 * demonstrable and testable end to end without a live vendor account. It
 * behaves like a real provider in the ways that matter, idempotency, 3-D
 * Secure challenges, decline codes, signed webhooks, because those are exactly
 * the paths that go untested when a sandbox is too obliging.
 *
 * It holds no card data, and is written so it could not: the only way to create
 * a payment method here is a hosted setup session, which returns a token.
 *
 * Test amounts drive behaviour deterministically:
 *   ending 01  → declined (insufficient funds)
 *   ending 02  → requires 3-D Secure
 *   ending 03  → provider error
 *   otherwise  → succeeds
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'sandbox';
  private readonly methods = new Map<string, PaymentMethodSummary[]>();
  private readonly payments = new Map<string, PaymentIntent>();
  private readonly byIdempotencyKey = new Map<string, string>();
  private readonly refunds = new Map<string, number>();
  private sequence = 0;

  constructor(
    // Not prefixed like a real Stripe secret: a default that matches a
    // provider's key format is flagged by every secret scanner, and the
    // sandbox has no real credential to imitate.
    private readonly webhookSecret = 'sandbox-webhook-secret',
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private ref(prefix: string): ProviderRef {
    this.sequence += 1;
    return `${prefix}_sbx_${String(this.sequence).padStart(6, '0')}` as ProviderRef;
  }

  async startSetup(input: SetupInput): Promise<SetupSession> {
    const ref = this.ref('seti');
    return {
      ref,
      url: `https://sandbox.detent.local/setup/${ref}?return=${encodeURIComponent(input.returnUrl)}`,
      expiresAt: new Date(Date.parse(this.now()) + 3_600_000).toISOString(),
    };
  }

  /** Test helper: completes a hosted setup, as the provider's page would. */
  attachTestMethod(accountId: string, summary?: Partial<PaymentMethodSummary>): PaymentMethodSummary {
    const method: PaymentMethodSummary = {
      ref: this.ref('pm'),
      kind: 'card',
      last4: '4242',
      brand: 'visa',
      expiryMonth: 12,
      expiryYear: 2030,
      ...summary,
    };
    const existing = this.methods.get(accountId) ?? [];
    this.methods.set(accountId, [...existing, method]);
    return method;
  }

  async listPaymentMethods(accountId: string): Promise<readonly PaymentMethodSummary[]> {
    return this.methods.get(accountId) ?? [];
  }

  async detachPaymentMethod(ref: ProviderRef): Promise<void> {
    for (const [accountId, methods] of this.methods) {
      this.methods.set(accountId, methods.filter((method) => method.ref !== ref));
    }
  }

  async charge(input: ChargeInput): Promise<PaymentIntent> {
    assertNoCardData(input.description, 'charge.description');

    const seen = this.byIdempotencyKey.get(input.idempotencyKey);
    if (seen) {
      const previous = this.payments.get(seen);
      if (previous) return previous;
    }

    const method = (this.methods.get(input.accountId) ?? [])
      .find((candidate) => candidate.ref === input.paymentMethodRef);

    const ref = this.ref('pi');
    const last2 = Math.abs(input.amount.amount) % 100;
    let intent: PaymentIntent;

    if (last2 === 3) {
      throw new Error('Sandbox provider is unavailable.');
    } else if (last2 === 1) {
      intent = {
        ref, status: 'failed', amount: input.amount,
        failureCode: 'insufficient_funds',
        failureMessage: 'The card was declined for insufficient funds.',
        paymentMethod: method, createdAt: this.now(),
      };
    } else if (last2 === 2) {
      // An off-session charge cannot answer a challenge. Failing is correct;
      // retrying it just fails again, and the right response is to email a link.
      intent = input.offSession
        ? {
            ref, status: 'failed', amount: input.amount,
            failureCode: 'authentication_required',
            failureMessage: 'The card requires authentication the customer must complete.',
            paymentMethod: method, createdAt: this.now(),
          }
        : {
            ref, status: 'requires_action', amount: input.amount,
            nextActionUrl: `https://sandbox.detent.local/3ds/${ref}`,
            paymentMethod: method, createdAt: this.now(),
          };
    } else if (!method) {
      intent = {
        ref, status: 'failed', amount: input.amount,
        failureCode: 'payment_method_not_found',
        failureMessage: 'No such payment method on this account.',
        createdAt: this.now(),
      };
    } else {
      intent = {
        ref, status: 'succeeded', amount: input.amount,
        paymentMethod: method, createdAt: this.now(),
      };
    }

    this.payments.set(ref, intent);
    this.byIdempotencyKey.set(input.idempotencyKey, ref);
    return intent;
  }

  async getPayment(ref: ProviderRef): Promise<PaymentIntent | undefined> {
    return this.payments.get(ref);
  }

  async refund(input: {
    readonly paymentRef: ProviderRef;
    readonly amount?: Money;
    readonly reason: string;
    readonly idempotencyKey: string;
  }): Promise<RefundResult> {
    const payment = this.payments.get(input.paymentRef);
    if (!payment || payment.status !== 'succeeded') {
      return {
        ref: this.ref('re'), amount: input.amount ?? { amount: 0, currency: 'GBP' },
        status: 'failed', failureReason: 'payment_not_refundable',
      };
    }
    const amount = input.amount ?? payment.amount;
    const already = this.refunds.get(input.paymentRef) ?? 0;
    if (already + amount.amount > payment.amount.amount) {
      return { ref: this.ref('re'), amount, status: 'failed', failureReason: 'exceeds_payment' };
    }
    this.refunds.set(input.paymentRef, already + amount.amount);
    return { ref: this.ref('re'), amount, status: 'succeeded' };
  }

  /** Signs a payload as the provider would. Test helper. */
  sign(rawBody: string): string {
    return createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');
  }

  async verifyWebhook(rawBody: string, signature: string): Promise<WebhookEvent> {
    const expected = Buffer.from(this.sign(rawBody), 'utf8');
    const given = Buffer.from(signature, 'utf8');
    // Length is compared first because timingSafeEqual throws on a mismatch,
    // and constant time is compared second so a wrong signature leaks nothing.
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw new Error('Webhook signature verification failed.');
    }
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    return {
      id: String(parsed['id'] ?? ''),
      type: String(parsed['type'] ?? ''),
      createdAt: String(parsed['created_at'] ?? this.now()),
      payload: (parsed['data'] as Record<string, unknown>) ?? {},
    };
  }
}
