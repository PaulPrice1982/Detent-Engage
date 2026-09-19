/**
 * The websites, mounted in front of the API on one HTTP server.
 *
 * This connects three pieces that were each finished and none of which were
 * joined: `buildDevSites` builds the marketing site, the customer area, the
 * reseller portal and the staff console; `resolveSite` decides which hostname
 * serves which of them; and `createHttpServer` accepts a list of mounted
 * sites. The entry point built none of it, so every sign-in page, the console
 * and the customer area answered 404 in every deployment, and the only thing
 * actually reachable was the JSON API.
 *
 * One mount rather than one per site, because the decision is made by
 * hostname first and path second: which site owns a path depends on which host
 * asked for it, and a list of prefix mounts cannot express that. Answering an
 * unknown Host with the real site is how a dangling DNS record becomes
 * somebody else's phishing page, so an unrecognised hostname is served no
 * content at all.
 */
import type { DevSites } from './dev-sites.js';
import type { MountedSite } from './http-server.js';
import type { SiteRequest, SiteResponse } from './site-router.js';
import {
  consoleIsElsewhere, hostnameOf, resolveSite, signInAliasFor,
  unrecognisedHostAnswer, type HostConfig,
} from './host-routing.js';
import { consoleElsewherePage } from './not-configured.js';

export interface SiteMountOptions {
  readonly sites: DevSites;
  readonly hosts: HostConfig;
  /** Canonical origin for absolute links and social cards. */
  readonly canonicalOrigin?: string;
}

export function createSiteMount(options: SiteMountOptions): MountedSite {
  const { sites, hosts } = options;

  return {
    // Everything. Which paths belong to a site is decided per request by
    // hostname, and /v1/* is reserved by the transport before any site is
    // consulted.
    prefix: '',

    async handle(request: SiteRequest): Promise<SiteResponse | undefined> {
      const host = request.headers['host'];

      // A staff console asked for on a customer hostname. Named as a setting
      // rather than as a hostname: whoever configured the console host knows
      // it, and anybody else asking a public URL for /console is not entitled
      // to be told where the staff entrance is.
      if (consoleIsElsewhere(hosts, request.path)) {
        return { status: 404, html: consoleElsewherePage() };
      }

      // /signin, /login, /admin and the rest, so somebody typing the obvious
      // thing arrives rather than getting a 404 from the marketing site.
      const alias = signInAliasFor(request.path);
      if (alias) return { status: 303, redirect: alias };

      const match = resolveSite(hosts, host, request.path);
      if (!match) {
        // No site, and still an answer. A hosting platform decides a container
        // is alive by asking for '/' through its own proxy on an internal
        // hostname nobody configured; a 404 there is read as a failed health
        // check and the container is restarted for ever.
        const answer = unrecognisedHostAnswer(request.path);
        return { status: answer.status, html: answer.body };
      }

      const routed: SiteRequest = { ...request, path: match.path };

      if (match.site === 'console') return sites.consoleRouter.handle(routed);
      if (match.site === 'reseller') return sites.resellerRouter.handle(routed);
      if (match.site === 'app') return sites.appRouter.handle(routed);

      const rendered = await sites.marketing(match.path, {
        canonicalOrigin: options.canonicalOrigin,
        // Only the canonical hostname is indexable. Several hostnames serving
        // the same pages is duplicate content, and the one that ranks is
        // whichever the crawler saw first.
        indexable: hostnameOf(host) === hosts.marketingHost,
      });
      return { status: rendered.status, html: rendered.html };
    },
  };
}
