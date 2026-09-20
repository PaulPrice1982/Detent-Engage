import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Api, ApiRequest } from './api.js';
import { originMatches } from './auth.js';
import { serveStatic, type StaticMount } from './static-files.js';
import type { SiteRequest, SiteResponse } from './site-router.js';
import { isPlatformProbe } from './host-routing.js';

/**
 * HTTP transport.
 *
 * Thin by design: it reads the request, hands it to the router, and writes the
 * response. Every security decision, authentication, tenant binding, policy,
 * happens in the router, so nothing here can be bypassed by reaching the
 * transport differently.
 *
 * What did belong here, and was missing (audit SEC-7, PERF-8):
 *
 *  - response security headers. `content-security-policy`,
 *    `strict-transport-security`, `permissions-policy` and the cross-origin
 *    isolation headers were all absent, and `panel.html`, a page designed to
 *    be framed, had no `frame-ancestors` at all, so any site could embed a
 *    tenant's conversation panel;
 *  - server timeouts. `headersTimeout`, `requestTimeout` and `keepAliveTimeout`
 *    were unset, which leaves the process open to slowloris and to socket
 *    exhaustion;
 *  - a default deny on CORS. `*` plus a public key in page source let anyone
 *    drive a tenant's assistant from anywhere.
 */
export interface HttpServerOptions {
  readonly port?: number;
  readonly maxBodyBytes?: number;
  /**
   * Origins permitted to call the session API from a browser.
   *
   * `*` is accepted but no longer the default, and it is not the security
   * control in any case: origin binding happens at authentication, against the
   * tenant's registered origins (audit SEC-5).
   */
  readonly allowedOrigins?: readonly string[];
  /**
   * Directories served as static assets. Tried before the router, and only for
   * GET/HEAD against a real file with a known extension, so no API route can be
   * shadowed by a file on disk.
   */
  readonly staticMounts?: readonly StaticMount[];
  /** Emit HSTS. Off by default: sending it over plain HTTP locks out a dev box. */
  readonly hsts?: boolean;
  /** Frame-ancestors for the panel. Usually every tenant's registered origins. */
  readonly panelFrameAncestors?: readonly string[];
  /** Trust `x-forwarded-for` for the client address. Only behind a known proxy. */
  readonly trustProxy?: boolean;
  readonly timeouts?: {
    readonly headersMs?: number;
    readonly requestMs?: number;
    readonly keepAliveMs?: number;
  };
  /** Maximum simultaneous connections before new ones are refused. */
  readonly maxConnections?: number;
  /**
   * Sites mounted in front of the API: the marketing pages, the console, the
   * reseller portal. A site returning `undefined` declines the request and it
   * falls through to the API.
   *
   * A site mounted at `''` matches every path, which is the arrangement the
   * marketing site uses where the hostname rather than the path decides the
   * site. That is why the API path guard below is not optional.
   */
  readonly sites?: readonly MountedSite[];
  /**
   * Body allowance for a site, which may be handling a file upload, as opposed
   * to `maxBodyBytes` which is the API's own limit. Larger on purpose, and the
   * reason the API limit is applied a second time after the read.
   */
  readonly maxUploadBytes?: number;
}

export interface MountedSite {
  /** URL prefix. `''` matches every path. */
  readonly prefix: string;
  handle(request: SiteRequest): Promise<SiteResponse | undefined>;
}

/**
 * Paths the API owns outright, which no site may answer.
 *
 * A site mounted at `''` matches every path, and a site that answered one of
 * these would take over the endpoint every widget conversation starts with, or
 * the endpoint the platform decides this container is alive by. Checked before
 * any site is consulted rather than relying on each site to decline, because a
 * site that forgets to decline is a site that silently breaks the product.
 *
 * The health paths are here because they were lost exactly that way. Mounting
 * the websites put a catch-all in front of the API, and `/health` stopped being
 * the API's liveness endpoint and started being the marketing site's 404. The
 * platform reads a 404 from its probe as a dead container, stops routing to it
 * and restarts it, which is the failure this repository already documents as
 * having killed three deployments. A probe answered by a website is not a probe.
 *
 * `/` is deliberately not reserved. It is both the platform's default probe and
 * the marketing home page, and the marketing home answers 200, which is what
 * the probe is asking.
 */
function isApiPath(path: string): boolean {
  if (path.startsWith('/v1/') || path === '/v1') return true;
  return path !== '/' && isPlatformProbe(path);
}

const DEFAULT_TIMEOUTS = { headersMs: 15_000, requestMs: 30_000, keepAliveMs: 5_000 };

export function createHttpServer(api: Api, options: HttpServerOptions = {}): Server {
  const maxBodyBytes = options.maxBodyBytes ?? 256 * 1024;
  const staticMounts = options.staticMounts ?? [];

  const server = createServer((request, response) => {
    void handle(api, request, response, maxBodyBytes, options, staticMounts);
  });

  // Slowloris and socket exhaustion are the two cheapest attacks against a
  // Node server, and both are closed by numbers rather than by code.
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts ?? {}) };
  server.headersTimeout = timeouts.headersMs;
  server.requestTimeout = timeouts.requestMs;
  server.keepAliveTimeout = timeouts.keepAliveMs;
  // Node requires headersTimeout > keepAliveTimeout to avoid a race where a
  // connection is closed while a request is in flight.
  if (server.headersTimeout <= server.keepAliveTimeout) {
    server.headersTimeout = server.keepAliveTimeout + 1_000;
  }
  if (options.maxConnections) server.maxConnections = options.maxConnections;

  /**
   * A request Node's own parser rejected, answered so somebody can act on it.
   *
   * Without this handler Node replies `400 Bad Request` with an empty body and
   * closes the connection. That is indistinguishable, from the outside, from
   * the application refusing the request, and it is the one 400 no log line
   * explains because no application code ever ran: the parser rejected the
   * bytes before the request existed.
   *
   * It cost a release. A verification step got an empty 400 from a malformed
   * header, and there was no way to tell that from a rejected key, a blocked
   * origin or an invalid body, all of which answer with a reason. Behind a
   * proxy or a load balancer that inserts its own headers this is exactly how
   * the fault presents, and the operator has nothing to go on.
   *
   * The reply names the parser's own code and nothing else: no header values,
   * no body, no request line. A malformed request is often malformed because
   * it carries something it should not, and echoing it back would publish it.
   */
  server.on('clientError', (error: NodeJS.ErrnoException, socket) => {
    // A connection the client already dropped, which is ordinary and not a
    // fault worth answering.
    if (socket.destroyed || !socket.writable || error.code === 'ECONNRESET') {
      socket.destroy();
      return;
    }
    const code = typeof error.code === 'string' ? error.code : 'HPE_UNKNOWN';
    const status = code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
    const reason = parseFailureReason(code);
    const body = JSON.stringify({ error: 'MALFORMED_REQUEST', message: reason, code });
    socket.end(
      `HTTP/1.1 ${status} ${status === 431 ? 'Request Header Fields Too Large' : 'Bad Request'}\r\n`
      + 'content-type: application/json; charset=utf-8\r\n'
      + `content-length: ${Buffer.byteLength(body)}\r\n`
      + 'x-content-type-options: nosniff\r\n'
      + 'connection: close\r\n'
      + `\r\n${body}`,
    );
  });

  return server;
}

/**
 * What a parser code actually means, in terms of what to do about it.
 *
 * Naming the code alone is better than an empty body and still leaves somebody
 * searching for it. These are the codes that reach a real deployment, and each
 * one has a cause specific enough to act on.
 */
function parseFailureReason(code: string): string {
  const preamble = 'This request was rejected by the HTTP parser before it reached '
    + 'the application, so it was not refused by authentication, origin or schema. ';
  switch (code) {
    case 'HPE_HEADER_OVERFLOW':
      return 'The request headers are larger than this server accepts.';
    case 'HPE_LF_EXPECTED':
    case 'HPE_CR_EXPECTED':
    case 'HPE_STRICT':
    case 'HPE_INVALID_EOF_STATE':
      return preamble
        + 'A line ending is wrong: there is a carriage return without its line feed. '
        + 'A program talking to this service does not do that. A command that was '
        + 'copied and pasted does, and the usual carrier is a value pasted into a '
        + 'header, such as an API key that brought a line break with it. Retype the '
        + 'request on one line rather than pasting it, or run `pnpm smoke`, which '
        + 'makes the same request from Node with no shell in the way.';
    case 'HPE_INVALID_HEADER_TOKEN':
      return preamble
        + 'A header name contains a character that is not allowed in one, usually a '
        + 'space. Check the headers being sent, and any proxy in front of this '
        + 'service that adds its own.';
    case 'HPE_INVALID_CONTENT_LENGTH':
    case 'HPE_UNEXPECTED_CONTENT_LENGTH':
      return preamble
        + 'The content-length does not agree with the body that followed it.';
    case 'HPE_INVALID_METHOD':
      return preamble + 'The request line does not begin with a method this server knows.';
    case 'HPE_INVALID_VERSION':
      return preamble + 'The request line does not name an HTTP version this server speaks.';
    default:
      return preamble
        + 'Check for a malformed header, a bad content-length, or a proxy in front '
        + 'of this service inserting one.';
  }
}

/**
 * Why the server could not take the port, in the operator's words.
 *
 * Without this a failed `listen` reaches Node's default handler for an
 * unhandled 'error' event, which prints a stack trace through node:net and
 * exits. The reason is in there, on the fourth line, under two frames of
 * internals, and the first thing anybody reads is "throw er". A container that
 * cannot start should say what it needs, not how it died.
 *
 * The commonest case by far is a previous instance still holding the port,
 * which on a platform that runs a managed process looks like the new release
 * simply not starting.
 */
export function listenFailureMessage(
  error: NodeJS.ErrnoException,
  port: number,
  host: string,
): string {
  switch (error.code) {
    case 'EADDRINUSE':
      return `Nothing started: ${host}:${port} is already in use.\n`
        + '  Something else is listening there, almost always an earlier instance of\n'
        + '  this service that was not stopped. Stop it and start again, or set PORT\n'
        + '  to a free port. Two instances cannot share one port, and the one that\n'
        + '  already holds it is serving the older release.';
    case 'EACCES':
      return `Nothing started: not permitted to listen on ${host}:${port}.\n`
        + (port < 1024
          ? '  Ports below 1024 need privileges most containers do not have. Listen on\n'
            + '  a high port and map it, which is what the platform expects anyway.'
          : '  Check whether the host or a sandbox policy restricts this port.');
    case 'EADDRNOTAVAIL':
      return `Nothing started: ${host} is not an address this machine has.\n`
        + '  Set HOST to 0.0.0.0 to listen on every interface, which is what a\n'
        + '  container behind a proxy needs.';
    default:
      return `Nothing started: could not listen on ${host}:${port} (${error.code ?? 'unknown'}).\n`
        + `  ${error.message}`;
  }
}

/**
 * Response security headers.
 *
 * The API and the panel need different policies: the API returns JSON and
 * should be frameable by nobody, while the panel is *designed* to be framed,
 * by the tenant's own site and nowhere else.
 */
export function securityHeaders(options: {
  readonly kind: 'api' | 'panel' | 'page' | 'asset';
  readonly hsts?: boolean;
  readonly frameAncestors?: readonly string[];
}): Record<string, string> {
  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // No geolocation, camera, microphone or payment from any of our surfaces.
    'permissions-policy': 'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
    'cross-origin-resource-policy': options.kind === 'api' ? 'same-origin' : 'cross-origin',
  };

  if (options.hsts) {
    headers['strict-transport-security'] = 'max-age=63072000; includeSubDomains; preload';
  }

  if (options.kind === 'panel' || options.kind === 'page') {
    const framing = options.kind === 'panel'
      ? (options.frameAncestors?.length ? options.frameAncestors.join(' ') : "'none'")
      // The console and the install page are ours and are never embedded.
      : "'none'";
    headers['content-security-policy'] = [
      "default-src 'self'",
      "base-uri 'none'",
      // Same origin, not none. Every page this server renders that does
      // anything, signing in, creating an account, approving a payment, does
      // it with a form posting back here, and `'none'` blocks the submission
      // itself. It still refuses a form that posts anywhere else, which is
      // what the directive is for.
      "form-action 'self'",
      "img-src 'self' data:",
      // No `'unsafe-inline'`: every style and script on our own pages is a
      // file on this origin, which is what makes the policy worth having
      // (audit SEC-7).
      "style-src 'self'",
      // Attributes only. The renderers carry roughly a hundred `style="..."`
      // attributes for one-off widths and margins; this permits those and
      // still refuses an inline <style> block and any third-party stylesheet.
      "style-src-attr 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
      "object-src 'none'",
      `frame-ancestors ${framing}`,
    ].join('; ');
    if (options.kind === 'page') headers['cross-origin-opener-policy'] = 'same-origin';
    return headers;
  }

  headers['content-security-policy'] = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
  headers['cross-origin-opener-policy'] = 'same-origin';
  return headers;
}

async function handle(
  api: Api,
  request: IncomingMessage,
  response: ServerResponse,
  maxBodyBytes: number,
  options: HttpServerOptions,
  staticMounts: readonly StaticMount[],
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const origin = request.headers.origin;
  const allowedOrigins = options.allowedOrigins ?? [];
  const allowOrigin = allowedOrigins.includes('*')
    ? '*'
    : (origin && originMatches(origin, allowedOrigins) ? origin : '');

  /**
   * The panel is designed to be framed by the tenant's own site; the console
   * and the install page are ours and are framed by nobody; everything else is
   * API JSON, which needs the strictest policy of the three.
   *
   * Decided by who answers the path, not by how the path is spelled. It used
   * to be decided by file extension, and every page this server renders is
   * served from an extensionless path: the whole back office, the whole
   * customer area, the reseller portal and every sign-in page were given the
   * API policy, `default-src 'none'`. Nothing 404ed and nothing errored. They
   * simply arrived in the browser with their own stylesheet refused and
   * rendered as unstyled documents, while curl, which enforces no policy,
   * showed them as perfect.
   */
  const kind = url.pathname.endsWith('/panel.html')
    ? 'panel' as const
    : isApiPath(url.pathname) ? 'api' as const : 'page' as const;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...securityHeaders({
      kind,
      hsts: options.hsts,
      frameAncestors: options.panelFrameAncestors,
    }),
  };
  if (allowOrigin) {
    headers['access-control-allow-origin'] = allowOrigin;
    headers['access-control-allow-headers'] = 'authorization, content-type, x-correlation-id';
    headers['access-control-allow-methods'] = 'GET, POST, PATCH, DELETE, OPTIONS';
    headers['access-control-max-age'] = '600';
    headers['vary'] = 'origin';
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, headers).end();
    return;
  }

  // Static assets are served before the router. `serveStatic` only answers for
  // a file that actually exists with a content type we recognise, so an API
  // path always falls through to the router below.
  if (staticMounts.length > 0 && (await serveStatic(staticMounts, request, response, headers))) {
    return;
  }

  const sites = options.sites ?? [];
  // Longest prefix first, so a site at '/console' is offered the request
  // before a catch-all at ''. Sorting here rather than requiring the caller to
  // pass them in order: mount order is not something a composition root should
  // have to get right.
  const candidates = sites
    .filter((site) => url.pathname.startsWith(site.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  // Read once, whatever answers.
  //
  // The regression this ordering exists for: the body was read for the site
  // and then read again for the API. The second read waited for an 'end' event
  // that had already fired, so an API POST behind a catch-all site hung until
  // the client gave up, and every conversation the widget starts is a POST.
  //
  // Read under the upload allowance because a site may be taking a file, then
  // measured against the API's own limit below, or the API limit would be
  // silently lifted for anyone who put a site in front of it.
  const maxUploadBytes = Math.max(options.maxUploadBytes ?? 8 * 1024 * 1024, maxBodyBytes);
  let rawBodyBuffer: Buffer;
  try {
    rawBodyBuffer = await readBody(request, maxUploadBytes);
  } catch {
    response.writeHead(413, headers).end(JSON.stringify({ error: 'SCHEMA_INVALID', message: 'Request body is too large.' }));
    return;
  }
  const rawBody = rawBodyBuffer.toString('utf8');

  if (candidates.length > 0 && !isApiPath(url.pathname)) {
    const siteRequest: SiteRequest = {
      method: request.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers as Record<string, string | undefined>,
      rawBody,
      rawBodyBuffer,
    };
    for (const site of candidates) {
      const answer = await site.handle(siteRequest);
      // `undefined` is a decline, not an error: the request falls through to
      // the next site and then to the API.
      if (!answer) continue;
      writeSiteResponse(response, headers, answer);
      return;
    }
  }

  // The API's own limit, applied to a body that was read under the larger one.
  if (rawBodyBuffer.byteLength > maxBodyBytes) {
    response.writeHead(413, headers).end(JSON.stringify({ error: 'SCHEMA_INVALID', message: 'Request body is too large.' }));
    return;
  }

  let body: unknown;
  if (rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody);
    } catch {
      response.writeHead(400, headers).end(JSON.stringify({ error: 'SCHEMA_INVALID', message: 'Body must be JSON.' }));
      return;
    }
  }

  const apiRequest: ApiRequest = {
    method: request.method ?? 'GET',
    path: url.pathname,
    headers: request.headers as Record<string, string | undefined>,
    body,
    // The raw body is retained for webhook signature verification: a signature
    // is over the exact bytes sent, not over a re-serialised object.
    rawBody,
    query: Object.fromEntries(url.searchParams),
    ip: clientAddress(request, options.trustProxy === true),
  };

  const result = await api.handle(apiRequest);

  if (result.stream) {
    await writeEventStream(response, { ...headers, ...result.headers }, result.stream);
    return;
  }

  const payload = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
  response.writeHead(result.status, { ...headers, ...result.headers }).end(payload);
}

/**
 * Server-sent events (audit UX-2).
 *
 * Each chunk has already been validated by the orchestrator before it reaches
 * here; this writes bytes and nothing else. The comment ping on open defeats
 * proxies that buffer until the first newline, which is how a "streaming"
 * endpoint ends up arriving all at once.
 */
async function writeEventStream(
  response: ServerResponse,
  headers: Record<string, string>,
  stream: AsyncIterable<{ event: string; data: unknown }>,
): Promise<void> {
  response.writeHead(200, {
    ...headers,
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    connection: 'keep-alive',
  });
  response.write(': open\n\n');

  try {
    for await (const chunk of stream) {
      if (response.writableEnded) break;
      response.write(`event: ${chunk.event}\ndata: ${JSON.stringify(chunk.data)}\n\n`);
    }
  } catch {
    if (!response.writableEnded) {
      response.write(`event: error\ndata: ${JSON.stringify({ message: 'The stream ended unexpectedly.' })}\n\n`);
    }
  } finally {
    if (!response.writableEnded) response.end();
  }
}

/**
 * Client address.
 *
 * `x-forwarded-for` is only read when the deployment says it sits behind a
 * proxy it controls. Trusting it by default would make the per-IP limiter
 * trivially defeatable by a header (audit SEC-2b).
 */
function clientAddress(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const candidate = first?.split(',')[0]?.trim();
    if (candidate) return candidate;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        // Paused rather than destroyed. Destroying the socket here kills the
        // connection before the 413 can be written, and the client sees a
        // dropped connection instead of the reason it was refused.
        request.pause();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

/** A site answers with HTML or a redirect, never with API JSON. */
function writeSiteResponse(
  response: ServerResponse,
  headers: Record<string, string>,
  answer: SiteResponse,
): void {
  const siteHeaders: Record<string, string | string[]> = { ...headers };
  if (answer.cookies && answer.cookies.length > 0) {
    siteHeaders['set-cookie'] = [...answer.cookies];
  }
  if (answer.redirect) {
    siteHeaders['location'] = answer.redirect;
    response.writeHead(answer.status, siteHeaders).end();
    return;
  }
  siteHeaders['content-type'] = 'text/html; charset=utf-8';
  response.writeHead(answer.status, siteHeaders).end(answer.html ?? '');
}
