import type { Money } from '@detent/awa-billing';

/**
 * The payment provider port.
 *
 * One rule governs this entire package:
 *
 *   **Detent never holds a card number.**
 *
 * No PAN, no CVV, no expiry, no raw bank details, not in a variable, not in a
 * log, not in an audit payload, not in a database column, not in transit
 * through our servers. Card data is collected by the provider's own hosted
 * element in the customer's browser and exchanged for an opaque token. We store
 * the token.
 *
 * This is not caution for its own sake. Touching a PAN moves the company from
 * PCI DSS SAQ-A, a questionnaire, to SAQ-D, an audited programme costing more
 * than the entire billing system, and it makes every future breach a card
 * breach. The types below are shaped so that a card number has nowhere to go.
 */

/** An opaque reference issued by the provider. Never a card number. */
export type ProviderRef = string & { readonly __brand?: 'ProviderRef' };

export type PaymentStatus =
  | 'requires_payment_method'
  /** The customer must complete 3-D Secure or another challenge. */
  | 'requires_action'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type PaymentMethodKind = 'card' | 'bacs_debit' | 'sepa_debit' | 'bank_transfer';

/**
 * What we are permitted to keep about a payment method: enough to recognise it
 * in a list, and nothing that could be used to charge it elsewhere.
 */
export interface PaymentMethodSummary {
  readonly ref: ProviderRef;
  readonly kind: PaymentMethodKind;
  /** Last four digits only. Not a PAN and not sufficient to reconstruct one. */
  readonly last4?: string;
  readonly brand?: string;
  readonly expiryMonth?: number;
  readonly expiryYear?: number;
  readonly holderName?: string;
  readonly countryCode?: string;
}

export interface PaymentIntent {
  readonly ref: ProviderRef;
  readonly status: PaymentStatus;
  readonly amount: Money;
  /** Present when the customer must complete a challenge, e.g. 3-D Secure. */
  readonly nextActionUrl?: string;
  readonly failureCode?: string;
  readonly failureMessage?: string;
  readonly paymentMethod?: PaymentMethodSummary;
  readonly createdAt: string;
}

export interface RefundResult {
  readonly ref: ProviderRef;
  readonly amount: Money;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly failureReason?: string;
}

export interface ChargeInput {
  readonly accountId: string;
  readonly amount: Money;
  readonly paymentMethodRef: ProviderRef;
  readonly description: string;
  /**
   * Required, not optional.
   *
   * A retried charge without a key is a double charge, and a double charge is
   * the one billing error a customer never forgets. Making this mandatory in
   * the type means a caller cannot forget it.
   */
  readonly idempotencyKey: string;
  /** Invoice or top-up this payment settles. Recorded with the provider. */
  readonly reference?: string;
  /**
   * Whether the customer is present to answer a 3-D Secure challenge.
   *
   * An off-session charge that triggers a challenge simply fails, and the right
   * response is to email the customer a link, not to retry, which fails again.
   */
  readonly offSession: boolean;
}

export interface SetupInput {
  readonly accountId: string;
  /** Where the provider returns the customer after a challenge. */
  readonly returnUrl: string;
}

/** A hosted collection session. The card is entered on the provider's page. */
export interface SetupSession {
  readonly ref: ProviderRef;
  /** Where to send the customer to enter their details. */
  readonly url: string;
  readonly expiresAt: string;
}

export interface WebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly createdAt: string;
  readonly payload: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly name: string;
  /** Start hosted collection of a payment method. We never see the card. */
  startSetup(input: SetupInput): Promise<SetupSession>;
  /** Payment methods on file for an account. */
  listPaymentMethods(accountId: string): Promise<readonly PaymentMethodSummary[]>;
  detachPaymentMethod(ref: ProviderRef): Promise<void>;
  charge(input: ChargeInput): Promise<PaymentIntent>;
  getPayment(ref: ProviderRef): Promise<PaymentIntent | undefined>;
  refund(input: {
    readonly paymentRef: ProviderRef;
    readonly amount?: Money;
    readonly reason: string;
    readonly idempotencyKey: string;
  }): Promise<RefundResult>;
  /**
   * Verifies a webhook's signature and returns the event.
   *
   * Takes the raw body, not a parsed object: a signature is over exact bytes,
   * and re-serialising a parsed object changes them.
   */
  verifyWebhook(rawBody: string, signature: string): Promise<WebhookEvent>;
}

/**
 * Anything matching these must never be stored, logged or sent onward.
 *
 * A guard rather than a parser: it exists so that a mistake somewhere upstream
 * fails loudly here instead of quietly persisting a card number.
 */
const PAN_LIKE = /\b(?:\d[ -]*?){13,19}\b/;
const CVV_FIELD = /\b(cvv|cvc|cvv2|card_?number|pan|security_?code)\b/i;

export class CardDataError extends Error {
  constructor(where: string) {
    super(
      `Refusing to handle what looks like raw card data in ${where}. ` +
      'Card details must be collected by the provider and exchanged for a token; ' +
      'this system must never see, store or transmit a card number.',
    );
    this.name = 'CardDataError';
  }
}

/**
 * Throws if a value looks like card data. Applied at every boundary where a
 * caller could pass something they should not have.
 */
export function assertNoCardData(value: unknown, where: string): void {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    // Strip separators before testing, since a PAN is commonly pasted grouped.
    if (PAN_LIKE.test(value) && luhn(value.replace(/[^0-9]/g, ''))) throw new CardDataError(where);
    return;
  }
  if (typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (CVV_FIELD.test(key)) throw new CardDataError(`${where}.${key}`);
    assertNoCardData(nested, `${where}.${key}`);
  }
}

/**
 * Luhn check, used only to decide whether a digit string is card-shaped.
 *
 * Without it, an order number or a phone number trips the guard and a
 * legitimate operation is blocked: a false positive here is an outage.
 */
function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let value = digits.charCodeAt(index) - 48;
    if (value < 0 || value > 9) return false;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}
