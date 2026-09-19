/**
 * Which site a request belongs to, decided by hostname.
 *
 * Three sites. The console always has a hostname to itself; the marketing site
 * and the customer area may share one. As configured for production:
 *
 *   www.detent.co.uk    the marketing website and the customer area
 *   app.detent.co.uk    the back office, staff only
 *
 * Marketing and the customer area sharing `www` is the ordinary arrangement and
 * costs nothing: the public pages and the signed-in pages are the same product
 * to the same person, and one domain keeps their session on one cookie. Where
 * they share, the `/app` path decides between them.
 *
 * The console is different, and its separate hostname is the point. A path
 * prefix on a shared domain is a boundary maintained by routing code, and
 * routing code is one mistake away from leaking. A separate hostname is a
 * boundary maintained by DNS and TLS: the console is not reachable from the
 * customer domain at all, whatever a handler does, and it can be put behind an
 * allowlist, a VPN or an identity-aware proxy without touching the product.
 *
 * In development one process serves all three on one port, and the prefixes are
 * how they are told apart. That is a development convenience and is refused in
 * a deployment, see `resolveSite`.
 */

export type SiteId = 'marketing' | 'app' | 'console' | 'reseller';

export interface HostConfig {
  /** Hostname for each site. Unset means the site is not served by host. */
  readonly marketingHost?: string;
  readonly appHost?: string;
  readonly consoleHost?: string;
  /**
   * Hostname for the reseller portal. Optional.
   *
   * Unset, the portal is served under /reseller on the customer domain, which
   * is adequate: a reseller is authenticated like a customer and sees only
   * their own book. It may never share the console's hostname, because a
   * reseller is not staff.
   */
  readonly resellerHost?: string;
  /**
   * Hostnames the platform itself serves this app on.
   *
   * Read from the hosting environment rather than configured, and always
   * recognised. Without them the app is unreachable at its own deployment URL
   * the moment a custom domain is configured but DNS has not been cut over , 
   * which is every first deploy. The failure was a bare 404 on every page,
   * which says nothing about why.
   *
   * They serve the public site and the customer area, separated by path. They
   * do not serve the console unless `consoleOnPlatformHost` is set.
   */
  readonly platformHosts?: readonly string[];
  /**
   * Lets the console be reached on the platform hostname.
   *
   * Off by default and never inferred. Before a custom domain is live there is
   * only one hostname, so the choice is between an operator who cannot reach
   * their own back office and a console sharing a hostname with the public
   * site. That is a decision for the person deploying, made explicitly, not one
   * to be made for them by a routing rule.
   */
  readonly consoleOnPlatformHost?: boolean;
  /**
   * Allow path prefixes to select a site, for development on one port.
   *
   * Never true in a deployment: it would make the back office reachable at
   * /console on the marketing domain, which is precisely what a separate
   * hostname exists to prevent.
   */
  readonly allowPathPrefixes: boolean;
}

export function hostConfigFrom(
  env: Record<string, string | undefined>,
  deployed: boolean,
): HostConfig {
  return {
    marketingHost: env['DETENT_MARKETING_HOST']?.trim().toLowerCase(),
    appHost: env['DETENT_APP_HOST']?.trim().toLowerCase(),
    consoleHost: env['DETENT_CONSOLE_HOST']?.trim().toLowerCase(),
    resellerHost: env['DETENT_RESELLER_HOST']?.trim().toLowerCase(),
    platformHosts: platformHostsFrom(env),
    consoleOnPlatformHost: env['DETENT_CONSOLE_ON_PLATFORM_HOST']?.trim() === 'true',
    allowPathPrefixes: !deployed,
  };
}

/**
 * The hostnames the hosting platform serves this app on.
 *
 * Replit publishes them in REPLIT_DOMAINS (comma separated) and, in the
 * editor, REPLIT_DEV_DOMAIN. Other platforms can be added here; the point is
 * that the app is reachable where it is actually served without anybody
 * having to configure it.
 */
export function platformHostsFrom(
  env: Record<string, string | undefined>,
): readonly string[] {
  const raw = [
    ...(env['REPLIT_DOMAINS'] ?? '').split(','),
    env['REPLIT_DEV_DOMAIN'] ?? '',
    env['DETENT_PLATFORM_HOST'] ?? '',
  ];
  return [...new Set(
    raw.map((one) => one.trim().toLowerCase()).filter(Boolean),
  )];
}

/** Strips the port and lowercases. `Host` carries a port; a config does not. */
export function hostnameOf(header: string | undefined): string {
  if (!header) return '';
  const value = header.trim().toLowerCase();
  // An IPv6 literal is bracketed; the colon inside it is not a port separator.
  if (value.startsWith('[')) return value.slice(0, value.indexOf(']') + 1);
  const colon = value.lastIndexOf(':');
  return colon > 0 ? value.slice(0, colon) : value;
}

export interface SiteMatch {
  readonly site: SiteId;
  /** The path with any development prefix removed. */
  readonly path: string;
  /** True when the site was chosen by hostname rather than by path. */
  readonly byHost: boolean;
}

/**
 * Resolves a request to a site.
 *
 * Hostname first, always. A path prefix is consulted only where prefixes are
 * allowed and no hostname matched, and never for the console when hosts are
 * configured, because a configured console host means the operator has chosen
 * to separate it and a path must not reopen the door.
 */
export function resolveSite(
  config: HostConfig,
  hostHeader: string | undefined,
  path: string,
): SiteMatch | undefined {
  const host = hostnameOf(hostHeader);

  if (config.consoleHost && host === config.consoleHost) {
    // A host dedicated to one site makes that site's root the host's root: a
    // visitor to https://app.detent.co.uk/ asked for the console home, not for
    // a page called "/". Without this the console answers its own domain with
    // a 404, because its routes are all under /console.
    return { site: 'console', path: underPrefix(path, '/console'), byHost: true };
  }

  if (config.resellerHost && host === config.resellerHost) {
    return { site: 'reseller', path: underPrefix(path, '/reseller'), byHost: true };
  }

  const appHere = Boolean(config.appHost) && host === config.appHost;
  const marketingHere = Boolean(config.marketingHost) && host === config.marketingHost;

  // Without a hostname of its own the portal rides on the customer domain.
  // A reseller is authenticated exactly as a customer is, so a path is the
  // right separation here, unlike the console, which is staff.
  const resellerByPath = !config.resellerHost && isResellerPath(path);

  if (appHere && marketingHere) {
    // One hostname, several sites: the path decides. This is a boundary
    // between public pages and signed-in pages, not a security boundary: each
    // signed-in area is protected by its session, as it would be on its own
    // domain.
    if (resellerByPath) return { site: 'reseller', path, byHost: true };
    return { site: isAppPath(path) ? 'app' : 'marketing', path, byHost: true };
  }
  if (resellerByPath && (appHere || marketingHere)) {
    return { site: 'reseller', path, byHost: true };
  }
  if (appHere) {
    return { site: 'app', path: underPrefix(path, '/app'), byHost: true };
  }
  if (marketingHere) {
    // The marketing domain serves marketing and nothing else. A /console path
    // here is not routed to the console; it is simply not found.
    return { site: 'marketing', path, byHost: true };
  }

  // The hostname the platform serves this app on is always recognised. It
  // behaves like the shared customer domain: the public site, the customer
  // area under /app, the reseller portal under /reseller, and the console
  // under /console unless a dedicated console host says otherwise.
  if ((config.platformHosts ?? []).includes(host)) {
    if (isConsolePath(path) && consoleServedOnPlatformHost(config)) {
      return { site: 'console', path, byHost: false };
    }
    if (isResellerPath(path)) return { site: 'reseller', path, byHost: true };
    return { site: isAppPath(path) ? 'app' : 'marketing', path, byHost: true };
  }

  if (!config.allowPathPrefixes) {
    // A deployment with hosts configured serves nothing on an unrecognised
    // hostname. Answering an unknown Host with the marketing site is how a
    // dangling DNS record becomes somebody else's phishing page.
    return undefined;
  }

  if (isConsolePath(path)) {
    return { site: 'console', path, byHost: false };
  }
  if (isResellerPath(path)) {
    return { site: 'reseller', path, byHost: false };
  }
  if (isAppPath(path)) {
    return { site: 'app', path, byHost: false };
  }
  return { site: 'marketing', path, byHost: false };
}

/**
 * What to answer a request on a hostname nothing is configured for.
 *
 * This is the fault that cost three deployments. A hosting platform decides
 * whether a container is alive by asking it for `/` and requiring a 200, and it
 * asks through its own proxy, on its own internal hostname, which is not a
 * hostname anybody configured and is not the one in `REPLIT_DOMAINS`. Every
 * such request resolved to no site and got a 404. The platform read that as a
 * failed health check, stopped routing to the container and restarted it, and
 * reported "the deployment is failing health checks" and "built successfully
 * but failed to start" about an application that was running perfectly and
 * answering every real hostname correctly.
 *
 * So a probe path answers, and answers with nothing: no page, no branding, no
 * indication of what runs here. An unknown Host is still served no content,
 * which is the point of refusing it, because answering an unknown Host with the
 * real site is how a dangling DNS record becomes somebody else's phishing page.
 * Two words of plain text give that away to nobody and keep the container
 * alive.
 */
export interface HostMissAnswer {
  readonly status: number;
  readonly body: string;
  readonly contentType: string;
}

export function unrecognisedHostAnswer(path: string): HostMissAnswer {
  return isPlatformProbe(path)
    ? { status: 200, body: 'ok', contentType: 'text/plain; charset=utf-8' }
    : { status: 404, body: 'Not found.', contentType: 'text/html; charset=utf-8' };
}

/**
 * Paths a hosting platform uses to ask whether the container is alive.
 *
 * `/` is the default on Replit, Cloud Run and most load balancers. The others
 * are the conventional alternatives, included because a platform that is
 * reconfigured to use one must not reintroduce the same failure.
 */
export function isPlatformProbe(path: string): boolean {
  return path === '/' || path === '/health' || path === '/healthz'
    || path === '/_health' || path === '/livez' || path === '/readyz';
}

/**
 * Whether /console is answered on the platform's own hostname.
 *
 * This is the rule that made the back office unreachable, and it is worth
 * stating exactly. Refusing /console on the platform hostname protects the
 * separation between the console and everything else. But that separation only
 * exists once there is a second hostname to separate onto. With no
 * DETENT_CONSOLE_HOST configured there is one hostname in the world serving
 * this app, and refusing to answer /console on it protects nothing at all: it
 * just means nobody can reach their own back office, and what they see is the
 * marketing site's 404, which explains none of that.
 *
 * It cost this deployment several rounds. The symptom is "the sign in page does
 * not load", and it appeared only where a platform hostname exists, which is
 * every Replit workspace and every deployment and no laptop, so it did not
 * reproduce anywhere it was looked for.
 *
 * So the console is served here when any of three things is true:
 *
 *  - the operator asked for it with DETENT_CONSOLE_ON_PLATFORM_HOST, which is
 *    how you reach it while a configured console domain is not yet resolving;
 *  - path prefixes are allowed, which is development and the workspace preview,
 *    where one process serves everything on one port by design;
 *  - no console host is configured, so there is nowhere else it could be.
 *
 * It is refused only in the case the refusal is actually for: a deployment that
 * has been given a console hostname of its own. A customer-facing domain is
 * never affected either way, because a request on DETENT_MARKETING_HOST or
 * DETENT_APP_HOST is resolved before this and never reaches it.
 */
export function consoleServedOnPlatformHost(config: HostConfig): boolean {
  return config.consoleOnPlatformHost === true
    || config.allowPathPrefixes
    || !config.consoleHost;
}

/**
 * True when the console exists but is deliberately not answered here.
 *
 * The one remaining way to ask for a back office and be told nothing. It gets a
 * page naming the setting that reaches it, rather than a marketing 404, and the
 * page does not name the console's hostname: whoever configured it knows it,
 * and anybody else is not entitled to a map.
 */
export function consoleIsElsewhere(config: HostConfig, path: string): boolean {
  return isConsolePath(path) && Boolean(config.consoleHost)
    && !consoleServedOnPlatformHost(config);
}

function isConsolePath(path: string): boolean {
  return path === '/console' || path.startsWith('/console/');
}

/**
 * The addresses people actually type when they want to sign in.
 *
 * None of these existed, so every one of them answered with the marketing
 * site's 404. The sign-in page was reported as not loading for four rounds
 * while it was being served correctly at /console/signin, and a person looking
 * for a way in has no reason to know that: the public site does not link to
 * the back office, on purpose, so the only route to it is a remembered path.
 *
 * A guess that lands is worth more than a 404 that is technically correct.
 */
const SIGN_IN_ALIASES = new Set([
  '/signin', '/sign-in', '/login', '/log-in', '/admin', '/console/login',
  '/signin/', '/login/',
]);

export function signInAliasFor(path: string): string | undefined {
  const normalised = path.toLowerCase();
  return SIGN_IN_ALIASES.has(normalised) ? normalised : undefined;
}

function isAppPath(path: string): boolean {
  return path === '/app' || path.startsWith('/app/');
}

function isResellerPath(path: string): boolean {
  return path === '/reseller' || path.startsWith('/reseller/');
}

/**
 * Places a path under a site's prefix, leaving one already there alone.
 *
 * `/` becomes `/console`, `/sign-in` becomes `/console/sign-in`, and
 * `/console/website` is untouched, so a link written either way resolves, and
 * the routers keep matching the single set of paths they already know.
 */
function underPrefix(path: string, prefix: string): string {
  if (path === prefix || path.startsWith(`${prefix}/`)) return path;
  return path === '/' ? prefix : `${prefix}${path}`;
}

/**
 * The absolute base URL for a site, for links in emails and redirects.
 *
 * Falls back to the development origin so a reset link works on a laptop.
 */
export function baseUrlFor(
  site: SiteId,
  config: HostConfig,
  fallbackOrigin: string,
): string {
  const host = site === 'console' ? config.consoleHost
    : site === 'app' ? config.appHost
    : site === 'reseller' ? (config.resellerHost ?? config.appHost)
    : config.marketingHost;
  if (!host) return fallbackOrigin;
  return `https://${host}`;
}

export interface HostProblem {
  readonly message: string;
}

/**
 * Every hostname that will be answered, for the boot banner.
 *
 * Printed at startup because the failure this exists for: a request arriving
 * on a hostname nothing is configured for, produces a 404 that says nothing.
 * Being able to compare the URL in the browser against this list turns a
 * mystery into a glance.
 */
export function recognisedHosts(config: HostConfig): readonly string[] {
  return [...new Set([
    config.marketingHost, config.appHost, config.consoleHost, config.resellerHost,
    ...(config.platformHosts ?? []),
  ].filter((one): one is string => Boolean(one)))].sort();
}

/**
 * Checks the host configuration before the server starts.
 *
 * A deployment that shares a hostname between the console and anything else has
 * lost the separation entirely, and it is worth refusing rather than serving.
 * Marketing and the customer area sharing one is fine and expected.
 */
export function checkHosts(config: HostConfig, deployed: boolean): HostProblem[] {
  const problems: HostProblem[] = [];
  if (!deployed) return problems;

  const onPlatform = (config.platformHosts ?? []).length > 0;

  if (!config.consoleHost) {
    // Only a problem when there is no platform hostname either. With one, the
    // app serves the public site and the customer area there and the console
    // is simply not reachable until it is given a host, which is a safe
    // default, not a broken one.
    if (!onPlatform) {
      problems.push({
        message:
          'DETENT_CONSOLE_HOST is not set and no platform hostname was detected. Without ' +
          'either, nothing is reachable. Set DETENT_CONSOLE_HOST, or run where the platform ' +
          'provides a hostname.',
      });
    }
  } else {
    if (config.consoleHost === config.marketingHost) {
      problems.push({
        message:
          'DETENT_CONSOLE_HOST is the same hostname as DETENT_MARKETING_HOST. The back ' +
          'office would be reachable from the public site. Give the console its own host.',
      });
    }
    if (config.consoleHost === config.resellerHost) {
      problems.push({
        message:
          'DETENT_CONSOLE_HOST is the same hostname as DETENT_RESELLER_HOST. A reseller '
          + 'is not staff, and the back office would be reachable from their portal.',
      });
    }
    if (config.consoleHost === config.appHost) {
      problems.push({
        message:
          'DETENT_CONSOLE_HOST is the same hostname as DETENT_APP_HOST. The back office ' +
          'would be reachable from the customer area. Give the console its own host.',
      });
    }
  }

  // Both are served on the platform hostname when it exists, so neither is
  // required to be configured. They are required when it does not.
  if (!config.marketingHost && !onPlatform) {
    problems.push({
      message:
        'DETENT_MARKETING_HOST is not set and no platform hostname was detected, so no ' +
        'hostname serves the public website.',
    });
  }
  if (!config.appHost && !onPlatform) {
    problems.push({
      message:
        'DETENT_APP_HOST is not set and no platform hostname was detected, so customers ' +
        'cannot reach their account. Set it to the marketing host to serve both from one domain.',
    });
  }
  return problems;
}
