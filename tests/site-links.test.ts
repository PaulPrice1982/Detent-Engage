/**
 * Every link on the public site has to go somewhere a visitor can reach.
 *
 * This is the sign-in fault, and it was never in the routing. With no
 * DETENT_APP_HOST configured, every "Sign in" and "Start free" link on the
 * marketing site was written as `http://localhost:8787/app/signin`, and
 * localhost on a visitor's phone is that visitor's own machine. The links went
 * nowhere for everybody who ever opened the site.
 *
 * It survived four rounds of looking because every check was a curl at a path.
 * `/app/signin` answered 200 the entire time. Nobody read the href.
 *
 * So the rule is about what the page hands the reader, not about what the
 * server answers: a rendered page may not contain a link to localhost, to a
 * port, or to any absolute address that is not a configured hostname.
 */
import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { FixedClock } from '@detent/awa-core';
import { buildDevSites } from '../packages/server/src/dev-sites.js';

const base = () => ({
  audit: new AuditLog(new InMemoryAuditStore()),
  clock: new FixedClock(new Date('2026-09-06T09:00:00.000Z')),
  sessionSecret: 'a-session-secret-long-enough-for-the-check',
});

/** Every href in a rendered page. */
function hrefsOf(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe('the links a visitor is given', () => {
  it('never point at localhost, whatever the app base url is', async () => {
    // The exact configuration the deployment ran in: a platform hostname and
    // no DETENT_APP_HOST, which is every first deploy.
    const sites = await buildDevSites({ ...base(), appBaseUrl: '/app' });
    for (const slug of ['/', '/become-a-reseller', '/privacy', '/terms', '/cookies']) {
      const page = await sites.marketing(slug);
      for (const href of hrefsOf(page.html)) {
        expect(href, `${slug} links to ${href}`).not.toMatch(/localhost/i);
        expect(href, `${slug} links to ${href}`).not.toMatch(/127\.0\.0\.1/);
        // A port in a public link is a development address that escaped.
        expect(href, `${slug} links to ${href}`).not.toMatch(/:\d{2,5}\//);
      }
    }
  });

  it('offers a way to sign in and a way to sign up, on the home page', async () => {
    const sites = await buildDevSites({ ...base(), appBaseUrl: '/app' });
    const hrefs = hrefsOf((await sites.marketing('/')).html);
    expect(hrefs.some((href) => href.endsWith('/signin')), 'no sign-in link').toBe(true);
    expect(hrefs.some((href) => href.includes('/signup')), 'no sign-up link').toBe(true);
  });

  it('resolves those links against the host that served the page', async () => {
    const sites = await buildDevSites({ ...base(), appBaseUrl: '/app' });
    const hrefs = hrefsOf((await sites.marketing('/')).html);
    const signIn = hrefs.find((href) => href.endsWith('/signin'));
    // Relative, so it works on the platform hostname, on a custom domain and on
    // a laptop, without any of them being configured.
    expect(signIn).toBe('/app/signin');
  });

  it('writes an absolute link only when the customer area has its own host', async () => {
    // Then it is necessary: the customer area is on a different domain from the
    // marketing site, and a relative link would stay on the wrong one.
    const sites = await buildDevSites({ ...base(), appBaseUrl: 'https://app.detent.co.uk' });
    const hrefs = hrefsOf((await sites.marketing('/')).html);
    expect(hrefs).toContain('https://app.detent.co.uk/signin');
  });
});
