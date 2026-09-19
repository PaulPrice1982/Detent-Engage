import { describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHttpServer, type Api, type ApiRequest, type ApiResponse } from '@detent/awa-server';

/**
 * The transport, exercised over a real socket.
 *
 * Everything else in the suite calls handlers directly, which is faster and
 * says nothing about whether a request ever completes. These tests exist
 * because a request that never completes is invisible to every other kind of
 * test: nothing throws, nothing returns wrong, the client simply waits.
 */

/** An API that records what it was given and answers immediately. */
function recordingApi(): { api: Api; seen: ApiRequest[] } {
  const seen: ApiRequest[] = [];
  const api = {
    async handle(request: ApiRequest): Promise<ApiResponse> {
      seen.push(request);
      return { status: 200, body: { echoed: request.body ?? null } };
    },
  } as unknown as Api;
  return { api, seen };
}

/**
 * A site mounted at '': the arrangement the marketing site uses, where the
 * hostname rather than the path decides the site. Every path matches it, so
 * every path passes through it, including the API's.
 */
const CATCH_ALL_SITE = {
  prefix: '',
  async handle(request: { path: string }) {
    if (request.path.startsWith('/v1/')) return undefined; // declined
    return { status: 200, html: '<p>site</p>' };
  },
};

async function withServer<T>(
  options: Parameters<typeof createHttpServer>[1],
  api: Api,
  body: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = createHttpServer(api, options);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  try {
    return await body(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

/**
 * Every request here is given a deadline. Without one a regression does not
 * fail this suite, it hangs it, and a hung suite is reported as a timeout in
 * CI with no indication of which request never came back.
 */
async function fetchWithin(url: string, init: RequestInit, ms = 4000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

describe('a POST to the API when a site is mounted at the root', () => {
  it('answers instead of hanging', async () => {
    // The regression this pins: the site mount reads the request body before
    // the site loop, because a site may be handling a form. A site mounted at
    // '' matches every path, so an API POST had its body read there too, was
    // declined by the site, and then reached the API's own body read, which
    // waited for an 'end' event that had already fired. It never came, and the
    // request hung until the client gave up. Every conversation the widget
    // starts is a POST to /v1/sessions.
    const { api, seen } = recordingApi();
    const response = await withServer(
      { sites: [CATCH_ALL_SITE] },
      api,
      (baseUrl) => fetchWithin(`${baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jurisdiction: 'UK' }),
      }),
    );

    expect(response.status).toBe(200);
    // The body has to arrive intact, not merely arrive. Reading a consumed
    // stream could as easily have produced an empty body as a hang, and an
    // empty body would have failed silently as a missing field.
    expect(seen[0]?.body).toEqual({ jurisdiction: 'UK' });
  });

  it('still refuses a body over the API limit', async () => {
    // The body is now read under the larger upload allowance, so the API's own
    // limit has to be applied afterwards or it would be silently lifted.
    const { api } = recordingApi();
    const response = await withServer(
      { sites: [CATCH_ALL_SITE], maxBodyBytes: 64 },
      api,
      (baseUrl) => fetchWithin(`${baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(500) }),
      }),
    );
    expect(response.status).toBe(413);
  });

  it('lets the site answer a path it claims', async () => {
    const { api, seen } = recordingApi();
    const response = await withServer(
      { sites: [CATCH_ALL_SITE] },
      api,
      (baseUrl) => fetchWithin(`${baseUrl}/app/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'email=a%40b.c',
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('site');
    expect(seen).toHaveLength(0); // never reached the API
  });

  it('answers a POST when no site is mounted at all', async () => {
    // The other branch: with no site, the API reads the body itself.
    const { api, seen } = recordingApi();
    const response = await withServer({}, api, (baseUrl) =>
      fetchWithin(`${baseUrl}/v1/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ direct: true }),
      }));
    expect(response.status).toBe(200);
    expect(seen[0]?.body).toEqual({ direct: true });
  });
});
