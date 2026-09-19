import { AwaError } from '@detent/awa-core';
import { parseRetryAfter } from './rate-limit.js';

/**
 * Minimal HTTP port.
 *
 * Connectors depend on this interface, never on global fetch. That is what
 * makes every connector contract-testable offline against recorded vendor
 * responses, which is the difference between a connector suite that runs in CI
 * and one that only runs when five sandboxes happen to be up.
 */
export interface HttpRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export class FetchHttpClient implements HttpClient {
  constructor(private readonly timeoutMs = 10_000) {}

  async send(request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { 'content-type': 'application/json', accept: 'application/json', ...request.headers },
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: controller.signal,
      });
      const text = await response.text();
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
      let body: unknown = text;
      if (text && (headers['content-type'] ?? '').includes('json')) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      return { status: response.status, headers, body };
    } catch (cause) {
      throw new AwaError({
        kind: 'UPSTREAM_UNAVAILABLE',
        message: `http request failed: ${request.method} ${redactUrl(request.url)}`,
        cause,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    // Query strings routinely carry an email being searched for.
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[unparseable url]';
  }
}

/**
 * Translate a vendor HTTP response into the platform's error taxonomy, so the
 * retry and reconciliation logic never has to reason in status codes.
 */
export function classifyResponse(connector: string, response: HttpResponse, context: string): AwaError | undefined {
  if (response.status < 400) return undefined;

  if (response.status === 429) {
    return new AwaError({
      kind: 'RATE_LIMITED',
      message: `${connector} rate limited on ${context}`,
      retryAfterSeconds: (parseRetryAfter(response.headers['retry-after']) ?? 1000) / 1000,
      details: { status: response.status },
    });
  }
  if (response.status === 401 || response.status === 403) {
    // 401 invalid_grant is the revoked-token path in flow 19: the connection is
    // marked degraded and writes are parked, never retried into a hard failure.
    return new AwaError({
      kind: 'CONNECTION_DEGRADED',
      message: `${connector} rejected the tenant credential on ${context}`,
      details: { status: response.status },
    });
  }
  if (response.status === 409) {
    return new AwaError({
      kind: 'CONFLICT',
      message: `${connector} reported a conflict on ${context}`,
      details: { status: response.status, body: response.body },
    });
  }
  if (response.status === 404) {
    return new AwaError({ kind: 'NOT_FOUND', message: `${connector}: not found on ${context}` });
  }
  if (response.status >= 500) {
    return new AwaError({
      kind: 'UPSTREAM_UNAVAILABLE',
      message: `${connector} returned ${response.status} on ${context}`,
      details: { status: response.status },
    });
  }
  return new AwaError({
    kind: 'UPSTREAM_REJECTED',
    message: `${connector} rejected ${context} with ${response.status}`,
    details: { status: response.status, body: response.body },
  });
}
