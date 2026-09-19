import type { HttpClient } from './stripe-provider.js';

/**
 * The HTTP client the Stripe adapter takes, backed by fetch.
 *
 * The adapter takes a client rather than calling fetch itself so it can be
 * tested without a network. That left the real one unwritten, so the platform
 * shipped with a payment provider that could not reach Stripe and a sandbox
 * provider wired in its place: setting STRIPE_SECRET_KEY changed nothing, and
 * the product could not take a payment at all.
 *
 * A timeout is not optional here. A card call with no deadline is a request
 * that can hold a customer on a spinner until they give up, and give up on a
 * checkout is the most expensive thing a payment page can do.
 */
export class FetchStripeHttp implements HttpClient {
  constructor(private readonly timeoutMs = 20_000) {}

  async request(input: {
    readonly method: 'GET' | 'POST';
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
  }): Promise<{ readonly status: number; readonly body: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(input.url, {
        method: input.method,
        headers: { ...input.headers },
        ...(input.body === undefined ? {} : { body: input.body }),
        signal: controller.signal,
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      // Never the request. It carries the secret key in a header and the card
      // token in the body, and an error string ends up in a log.
      const reason = error instanceof Error ? error.name : 'unknown error';
      return { status: 0, body: JSON.stringify({ error: { message: `Stripe unreachable: ${reason}` } }) };
    } finally {
      clearTimeout(timer);
    }
  }
}
