import type { Credential, HttpClient } from '@detent/awa-connectors';
import { classifyResponse } from '@detent/awa-connectors';
import type { BillingConnector, BillingFacts, SystemCapabilityDeclaration, SystemLookup } from '../contract.js';

/**
 * Stripe Billing (read-only).
 *
 * Answers the question the CRM cannot: is this person a customer in good
 * standing? A CRM lifecycle stage says someone was sold to. Stripe says whether
 * the money arrived.
 *
 * Every method here is a GET. No write scope is requested, declared or held.
 */
export class StripeBillingConnector implements BillingConnector {
  readonly name = 'stripe';
  readonly category = 'billing' as const;

  constructor(private readonly http: HttpClient, private readonly base = 'https://api.stripe.com/v1') {}

  capabilities(): SystemCapabilityDeclaration {
    return {
      system: this.name,
      category: this.category,
      readOnly: true,
      optionalWrites: [],
      rateLimit: { requestsPerSecond: 25 },
      degradationNotes: [
        'Requires a restricted key with read scopes on customers, subscriptions and invoices only.',
        'Usage against plan is available only where the tenant meters usage in Stripe.',
      ],
    };
  }

  private async get(credential: Credential, path: string): Promise<unknown> {
    const response = await this.http.send({
      method: 'GET',
      url: `${this.base}${path}`,
      headers: { authorization: `Bearer ${credential.accessToken}` },
    });
    const error = classifyResponse(this.name, response, path);
    if (error) throw error;
    return response.body;
  }

  async readBilling(credential: Credential, lookup: SystemLookup): Promise<BillingFacts | undefined> {
    const search = await this.get(credential, `/customers/search?query=${encodeURIComponent(`email:'${lookup.email}'`)}`);
    const customer = ((search as { data?: Array<{ id: string; currency?: string }> }).data ?? [])[0];
    if (!customer) return { isCustomer: false, paymentStatus: 'unknown' };

    const subscriptions = await this.get(credential, `/subscriptions?customer=${customer.id}&status=all&limit=10`);
    const active = ((subscriptions as { data?: StripeSubscription[] }).data ?? [])
      .find((subscription) => subscription.status === 'active' || subscription.status === 'past_due');

    const invoices = await this.get(credential, `/invoices?customer=${customer.id}&status=open&limit=10`);
    const openInvoices = (invoices as { data?: StripeInvoice[] }).data ?? [];
    const oldestDue = openInvoices
      .map((invoice) => invoice.due_date)
      .filter((due): due is number => typeof due === 'number')
      .sort((a, b) => a - b)[0];

    const paymentStatus: BillingFacts['paymentStatus'] =
      active?.status === 'past_due' ? 'overdue'
      : openInvoices.some((invoice) => invoice.attempt_count && invoice.attempt_count > 1) ? 'failed'
      : openInvoices.length > 0 && oldestDue !== undefined && oldestDue * 1000 < Date.now() ? 'overdue'
      : active ? 'current'
      : 'unknown';

    return {
      isCustomer: true,
      planName: active?.items?.data?.[0]?.price?.nickname,
      paymentStatus,
      agedDebtDays: oldestDue === undefined ? undefined : Math.max(0, Math.floor((Date.now() - oldestDue * 1000) / 86_400_000)),
      renewalDate: active?.current_period_end ? new Date(active.current_period_end * 1000).toISOString() : undefined,
      currency: customer.currency?.toUpperCase(),
    };
  }
}

interface StripeSubscription {
  id: string; status: string; current_period_end?: number;
  items?: { data?: Array<{ price?: { nickname?: string } }> };
}
interface StripeInvoice { id: string; due_date?: number; attempt_count?: number }

/**
 * Chargebee (read-only). A second exemplar in the same category, per FR-081:
 * two exemplar connectors per priority-1 category.
 */
export class ChargebeeBillingConnector implements BillingConnector {
  readonly name = 'chargebee';
  readonly category = 'billing' as const;

  constructor(private readonly http: HttpClient, private readonly site: string) {}

  capabilities(): SystemCapabilityDeclaration {
    return {
      system: this.name,
      category: this.category,
      readOnly: true,
      optionalWrites: [],
      rateLimit: { requestsPerSecond: 10 },
      degradationNotes: [
        'Site-specific host; the API key is bound to one Chargebee site.',
        'Aged debt is derived from unpaid invoices and depends on the tenant dunning configuration.',
      ],
    };
  }

  async readBilling(credential: Credential, lookup: SystemLookup): Promise<BillingFacts | undefined> {
    const response = await this.http.send({
      method: 'GET',
      url: `https://${this.site}.chargebee.com/api/v2/customers?email[is]=${encodeURIComponent(lookup.email)}`,
      // Chargebee uses basic auth with the key as the username.
      headers: { authorization: `Basic ${Buffer.from(`${credential.accessToken}:`).toString('base64')}` },
    });
    const error = classifyResponse(this.name, response, 'customers');
    if (error) throw error;

    const list = (response.body as { list?: Array<{ customer?: ChargebeeCustomer }> }).list ?? [];
    const customer = list[0]?.customer;
    if (!customer) return { isCustomer: false, paymentStatus: 'unknown' };

    return {
      isCustomer: true,
      paymentStatus:
        customer.excess_payments && customer.excess_payments > 0 ? 'current'
        : customer.unbilled_charges && customer.unbilled_charges > 0 ? 'overdue'
        : customer.auto_collection === 'off' ? 'unknown'
        : 'current',
      currency: customer.preferred_currency_code,
    };
  }
}

interface ChargebeeCustomer {
  id: string; excess_payments?: number; unbilled_charges?: number;
  auto_collection?: string; preferred_currency_code?: string;
}
