import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Money } from '@detent/awa-billing';
import {
  assertNoCardData, type ChargeInput, type PaymentIntent, type PaymentMethodSummary,
  type PaymentProvider, type PaymentStatus, type ProviderRef, type RefundResult,
  type SetupInput, type SetupSession, type WebhookEvent,
} from './payment-provider.js';

/**
 * Stripe.
 *
 * Card details are collected by Stripe Checkout, on Stripe's own page, and we
 * receive a token. Detent's servers never see a card number, which keeps the
 * company on PCI DSS SAQ-A, a questionnaire, rather than SAQ-D, an audited
 * programme costing more than this entire system.
 *
 * The HTTP client is injected rather than imported. That keeps the adapter
 * testable without a network, and keeps the build working behind a package
 * firewall, which this repository has already been broken by once.
 */

export interface HttpClient {
  request(input: {
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  }): Promise<{ readonly status: number; readonly body: string }>;
}

export interface StripeOptions {
  /** Secret key. Never leaves this adapter; never enters a log or a prompt. */
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly http: HttpClient;
  readonly baseUrl?: string;
  /** Seconds a webhook signature stays acceptable. Stripe's own default is 300. */
  readonly webhookToleranceSeconds?: number;
  readonly now?: () => number;
}

const STRIPE_BASE = 'https://api.stripe.com/v1';

/** Stripe takes form-encoded bodies with bracket notation for nesting. */
export function encodeForm(values: Record<string, unknown>, prefix = ''): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = encodeForm(value as Record<string, unknown>, name);
      if (nested) pairs.push(nested);
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (typeof item === 'object' && item !== null) {
          pairs.push(encodeForm(item as Record<string, unknown>, `${name}[${index}]`));
        } else {
          pairs.push(`${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(String(item))}`);
        }
      });
    } else {
      pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return pairs.filter(Boolean).join('&');
}

const STATUS_MAP: Readonly<Record<string, PaymentStatus>> = {
  requires_payment_method: 'requires_payment_method',
  requires_confirmation: 'processing',
  requires_action: 'requires_action',
  processing: 'processing',
  succeeded: 'succeeded',
  canceled: 'cancelled',
};

export class StripeError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = 'StripeError';
  }
}

export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  private readonly base: string;
  private readonly now: () => number;

  constructor(private readonly options: StripeOptions) {
    this.base = options.baseUrl ?? STRIPE_BASE;
    this.now = options.now ?? (() => Date.now());
  }

  private async call(
    path: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.options.apiKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      // Pinned, so a Stripe API change is a deliberate upgrade rather than a
      // surprise on a Tuesday.
      'stripe-version': '2024-06-20',
    };
    // Stripe deduplicates on this key for 24 hours. It is the second line of
    // defence; the first is the local record in PaymentService.
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

    const response = await this.options.http.request({
      method: body ? 'POST' : 'GET',
      url: `${this.base}${path}`,
      headers,
      body: body ? encodeForm(body) : undefined,
    });

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(response.body) as Record<string, unknown>;
    } catch {
      throw new StripeError('Stripe returned an unreadable response.', undefined, response.status);
    }
    if (response.status >= 400) {
      const error = (parsed['error'] ?? {}) as Record<string, unknown>;
      throw new StripeError(
        typeof error['message'] === 'string' ? error['message'] : 'Stripe rejected the request.',
        typeof error['code'] === 'string' ? error['code'] : undefined,
        response.status,
      );
    }
    return parsed;
  }

  /**
   * A hosted page that collects a card and saves it for later.
   *
   * Checkout in `setup` mode: no charge, just a saved payment method. The
   * activation fee and the first subscription payment are taken afterwards,
   * once the account exists: a payment taken before the account is created is
   * a payment nobody can match to anything.
   */
  async startSetup(input: SetupInput): Promise<SetupSession> {
    const session = await this.call('/checkout/sessions', {
      mode: 'setup',
      currency: 'gbp',
      client_reference_id: input.accountId,
      success_url: `${input.returnUrl}?setup=complete&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${input.returnUrl}?setup=cancelled`,
      metadata: { accountId: input.accountId },
    });
    return {
      ref: String(session['id']) as ProviderRef,
      url: String(session['url']),
      expiresAt: new Date(this.now() + 3_600_000).toISOString(),
    };
  }

  /**
   * A hosted page that collects a card and charges the activation fee at once.
   *
   * One page, one card entry, both outcomes: the fee is taken and the method is
   * saved for the subscription. Asking a customer to enter a card twice at
   * sign-up loses some of them.
   */
  async startActivation(input: {
    readonly accountId: string;
    readonly returnUrl: string;
    readonly activationFee: Money;
    readonly description: string;
  }): Promise<SetupSession> {
    const session = await this.call('/checkout/sessions', {
      mode: 'payment',
      client_reference_id: input.accountId,
      success_url: `${input.returnUrl}?activation=complete&session={CHECKOUT_SESSION_ID}`,
      cancel_url: `${input.returnUrl}?activation=cancelled`,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: input.activationFee.currency.toLowerCase(),
          unit_amount: input.activationFee.amount,
          product_data: { name: input.description },
        },
      }],
      // Saves the card from the same entry, so the subscription can be charged
      // later without asking again.
      payment_intent_data: { setup_future_usage: 'off_session' },
      metadata: { accountId: input.accountId, kind: 'activation_fee' },
    });
    return {
      ref: String(session['id']) as ProviderRef,
      url: String(session['url']),
      expiresAt: new Date(this.now() + 3_600_000).toISOString(),
    };
  }

  async listPaymentMethods(accountId: string): Promise<readonly PaymentMethodSummary[]> {
    const customer = await this.customerFor(accountId);
    if (!customer) return [];
    const result = await this.call(`/payment_methods?customer=${encodeURIComponent(customer)}&type=card`);
    const data = Array.isArray(result['data']) ? result['data'] : [];
    return data.map((entry) => toMethod(entry as Record<string, unknown>));
  }

  async detachPaymentMethod(ref: ProviderRef): Promise<void> {
    await this.call(`/payment_methods/${encodeURIComponent(ref)}/detach`, {});
  }

  async charge(input: ChargeInput): Promise<PaymentIntent> {
    assertNoCardData(input.description, 'stripe.charge.description');
    const customer = await this.customerFor(input.accountId);

    const intent = await this.call('/payment_intents', {
      amount: input.amount.amount,
      currency: input.amount.currency.toLowerCase(),
      customer,
      payment_method: input.paymentMethodRef,
      description: input.description,
      confirm: true,
      // Off-session tells Stripe the customer is not there to answer a
      // challenge, so a card needing one declines rather than hanging.
      off_session: input.offSession,
      metadata: { accountId: input.accountId, reference: input.reference ?? '' },
    }, input.idempotencyKey);

    return toIntent(intent, input.amount);
  }

  async getPayment(ref: ProviderRef): Promise<PaymentIntent | undefined> {
    try {
      const intent = await this.call(`/payment_intents/${encodeURIComponent(ref)}`);
      return toIntent(intent);
    } catch (error) {
      if (error instanceof StripeError && error.status === 404) return undefined;
      throw error;
    }
  }

  async refund(input: {
    readonly paymentRef: ProviderRef;
    readonly amount?: Money;
    readonly reason: string;
    readonly idempotencyKey: string;
  }): Promise<RefundResult> {
    try {
      const refund = await this.call('/refunds', {
        payment_intent: input.paymentRef,
        amount: input.amount?.amount,
        // Stripe only accepts a fixed set here; the real reason goes in
        // metadata, where it is searchable and not silently rejected.
        reason: 'requested_by_customer',
        metadata: { detent_reason: input.reason },
      }, input.idempotencyKey);
      const status = String(refund['status']);
      return {
        ref: String(refund['id']) as ProviderRef,
        amount: input.amount ?? { amount: Number(refund['amount'] ?? 0), currency: 'GBP' },
        status: status === 'succeeded' ? 'succeeded' : status === 'failed' ? 'failed' : 'pending',
      };
    } catch (error) {
      return {
        ref: '' as ProviderRef,
        amount: input.amount ?? { amount: 0, currency: 'GBP' },
        status: 'failed',
        failureReason: error instanceof Error ? error.message : 'Refund failed.',
      };
    }
  }

  /**
   * Verifies a Stripe webhook signature.
   *
   * Signed over `timestamp.payload`, compared in constant time, and the
   * timestamp checked against a tolerance, without the timestamp check a
   * captured webhook can be replayed forever, which is how a refund event gets
   * re-applied.
   */
  async verifyWebhook(rawBody: string, signature: string): Promise<WebhookEvent> {
    const parts = new Map<string, string>();
    for (const segment of signature.split(',')) {
      const [key, value] = segment.split('=', 2);
      if (key && value) parts.set(key.trim(), value.trim());
    }
    const timestamp = parts.get('t');
    const provided = parts.get('v1');
    if (!timestamp || !provided) throw new Error('Webhook signature is malformed.');

    const age = Math.abs(Math.floor(this.now() / 1000) - Number(timestamp));
    const tolerance = this.options.webhookToleranceSeconds ?? 300;
    if (!Number.isFinite(age) || age > tolerance) {
      throw new Error('Webhook timestamp is outside the tolerance window.');
    }

    const expected = createHmac('sha256', this.options.webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(provided, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error('Webhook signature verification failed.');
    }

    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const data = (parsed['data'] ?? {}) as Record<string, unknown>;
    const object = (data['object'] ?? {}) as Record<string, unknown>;
    return {
      id: String(parsed['id'] ?? ''),
      type: String(parsed['type'] ?? ''),
      createdAt: new Date(Number(parsed['created'] ?? 0) * 1000).toISOString(),
      payload: {
        payment_ref: object['id'],
        account_id: ((object['metadata'] ?? {}) as Record<string, unknown>)['accountId'],
        amount: object['amount'],
        status: object['status'],
      },
    };
  }

  /** Signs a payload as Stripe would. For tests and local verification. */
  signWebhook(rawBody: string, timestampSeconds = Math.floor(this.now() / 1000)): string {
    const signature = createHmac('sha256', this.options.webhookSecret)
      .update(`${timestampSeconds}.${rawBody}`)
      .digest('hex');
    return `t=${timestampSeconds},v1=${signature}`;
  }

  /** Finds or creates the Stripe customer for an account. */
  async ensureCustomer(input: {
    readonly accountId: string;
    readonly email: string;
    readonly name?: string;
  }): Promise<ProviderRef> {
    const existing = await this.customerFor(input.accountId);
    if (existing) return existing as ProviderRef;
    const customer = await this.call('/customers', {
      email: input.email,
      name: input.name,
      metadata: { accountId: input.accountId },
    }, `customer_${input.accountId}`);
    return String(customer['id']) as ProviderRef;
  }

  private async customerFor(accountId: string): Promise<string | undefined> {
    const query = encodeURIComponent(`metadata['accountId']:'${accountId}'`);
    const result = await this.call(`/customers/search?query=${query}`);
    const data = Array.isArray(result['data']) ? result['data'] : [];
    const first = data[0] as Record<string, unknown> | undefined;
    return first ? String(first['id']) : undefined;
  }
}

function toMethod(entry: Record<string, unknown>): PaymentMethodSummary {
  const card = (entry['card'] ?? {}) as Record<string, unknown>;
  const billing = (entry['billing_details'] ?? {}) as Record<string, unknown>;
  return {
    ref: String(entry['id']) as ProviderRef,
    kind: 'card',
    // Only the last four. Not a PAN, and not enough to reconstruct one.
    last4: card['last4'] ? String(card['last4']) : undefined,
    brand: card['brand'] ? String(card['brand']) : undefined,
    expiryMonth: card['exp_month'] ? Number(card['exp_month']) : undefined,
    expiryYear: card['exp_year'] ? Number(card['exp_year']) : undefined,
    holderName: billing['name'] ? String(billing['name']) : undefined,
    countryCode: card['country'] ? String(card['country']) : undefined,
  };
}

function toIntent(intent: Record<string, unknown>, fallbackAmount?: Money): PaymentIntent {
  const status = STATUS_MAP[String(intent['status'])] ?? 'failed';
  const error = (intent['last_payment_error'] ?? {}) as Record<string, unknown>;
  const nextAction = (intent['next_action'] ?? {}) as Record<string, unknown>;
  const redirect = (nextAction['redirect_to_url'] ?? {}) as Record<string, unknown>;
  return {
    ref: String(intent['id']) as ProviderRef,
    status,
    amount: fallbackAmount ?? {
      amount: Number(intent['amount'] ?? 0),
      currency: String(intent['currency'] ?? 'gbp').toUpperCase() as Money['currency'],
    },
    nextActionUrl: redirect['url'] ? String(redirect['url']) : undefined,
    failureCode: error['code'] ? String(error['code']) : undefined,
    failureMessage: error['message'] ? String(error['message']) : undefined,
    createdAt: new Date(Number(intent['created'] ?? 0) * 1000).toISOString(),
  };
}
