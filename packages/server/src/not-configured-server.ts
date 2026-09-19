/**
 * The server that runs when the application must not.
 *
 * Refusing to serve a product that would lose a customer's data is right.
 * Exiting to say so is not. The platform restarts the process, decides the
 * container is unhealthy, stops routing to it, and reports "failed to start",
 * which names neither the setting that is missing nor the file that says so.
 * Three deployments in a row failed this way with the explanation already
 * written and correct, sitting behind something that threw first.
 *
 * So this answers. It holds no database handle, no session store and no
 * payment client; it cannot, because the reason it exists is that those could
 * not be constructed. It serves the reasons and nothing else.
 *
 * The probe path answers 200 deliberately. A platform routes traffic to a
 * container only while its probe returns 200, and a page nobody can reach
 * explains nothing to anybody. The `x-detent-status` header is what tells a
 * monitor this is a refusal rather than a healthy service, since the status
 * code cannot.
 */
import { createServer, type Server } from 'node:http';
import { isPlatformProbe } from './host-routing.js';
import { notConfiguredPage } from './not-configured.js';

export interface NotConfiguredServerOptions {
  readonly problems: readonly string[];
  /** Written once at boot, so the reason is in the log as well as the browser. */
  readonly log?: (line: string) => void;
}

export function createNotConfiguredServer(options: NotConfiguredServerOptions): Server {
  const problems = options.problems.length > 0
    ? options.problems
    : ['The application is not configured, and no reason was recorded.'];

  const server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const probe = path === '/' || isPlatformProbe(path);

    const headers: Record<string, string> = {
      'x-detent-status': 'not_configured',
      // Nothing here should ever be indexed. A refusal page ranking for the
      // product's own name is a small disaster of its own.
      'x-robots-tag': 'noindex, nofollow',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    };

    // The machine-readable form, for the probe and for a monitor.
    if (path !== '/' && isPlatformProbe(path)) {
      response.writeHead(200, { ...headers, 'content-type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'not_configured', reasons: problems }));
      return;
    }

    // The root is the platform's probe *and* what an operator opens in a
    // browser, so it answers 200 with the page: 200 keeps the container
    // routable, and the page is the explanation.
    response.writeHead(probe ? 200 : 503, {
      ...headers,
      'content-type': 'text/html; charset=utf-8',
    });
    response.end(notConfiguredPage({ problems }));
  });

  const log = options.log;
  if (log) {
    log('Detent is not configured and is serving the reason rather than starting.');
    for (const problem of problems) log(`  - ${problem}`);
  }
  return server;
}
