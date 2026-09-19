/**
 * The hosting platform's health check must be answered.
 *
 * This is the fault that failed three deployments in a row and presented every
 * time as something else: "built successfully but failed to start", "the
 * deployment is crash looping", and finally "the deployment is failing health
 * checks". The application was running the whole time and answering every
 * configured hostname correctly.
 *
 * A platform decides a container is alive by asking it for "/" and requiring a
 * 200, and it asks through its own proxy, on an internal hostname that is not
 * in REPLIT_DOMAINS and is not any hostname an operator configured. In a
 * deployment every unrecognised hostname resolved to no site and got a 404. So
 * the health check failed, the platform stopped routing to the container and
 * restarted it, and no amount of correct code inside would have changed that.
 *
 * The rule these tests hold: an unknown Host is served no content, and is still
 * answered.
 */
import { describe, expect, it } from 'vitest';
import {
  consoleIsElsewhere, hostConfigFrom, isPlatformProbe, resolveSite, signInAliasFor,
  unrecognisedHostAnswer,
} from '../packages/server/src/host-routing.js';
import { consoleElsewherePage } from '../packages/server/src/not-configured.js';

const deployment = hostConfigFrom({
  DETENT_MARKETING_HOST: 'www.detent.co.uk',
  DETENT_APP_HOST: 'www.detent.co.uk',
  DETENT_CONSOLE_HOST: 'app.detent.co.uk',
  REPLIT_DOMAINS: 'detent-agentic-assistant.replit.app',
}, true);

describe('an unrecognised hostname', () => {
  it('still resolves to no site, which is the security property', () => {
    // Unchanged and deliberate: answering an unknown Host with the real site is
    // how a dangling DNS record becomes somebody else's phishing page.
    expect(resolveSite(deployment, '10.0.0.7:8787', '/')).toBeUndefined();
    expect(resolveSite(deployment, 'localhost:8787', '/pricing')).toBeUndefined();
    expect(resolveSite(deployment, undefined, '/console')).toBeUndefined();
  });

  it('answers the probe path 200 so the platform keeps the container', () => {
    const root = unrecognisedHostAnswer('/');
    expect(root.status).toBe(200);
    expect(root.contentType).toMatch(/text\/plain/);
    expect(unrecognisedHostAnswer('/health').status).toBe(200);
    expect(unrecognisedHostAnswer('/healthz').status).toBe(200);
    expect(unrecognisedHostAnswer('/readyz').status).toBe(200);
  });

  it('gives the probe nothing about what runs here', () => {
    const root = unrecognisedHostAnswer('/');
    expect(root.body).toBe('ok');
    expect(root.body.toLowerCase()).not.toContain('detent');
    expect(root.body.length).toBeLessThan(16);
  });

  it('still serves no page on any other path', () => {
    for (const path of ['/pricing', '/console', '/console/sign-in', '/app', '/reseller']) {
      const answer = unrecognisedHostAnswer(path);
      expect(answer.status, `${path} must not be served`).toBe(404);
      expect(answer.body).toBe('Not found.');
    }
  });

  it('treats only the probe paths as probes', () => {
    expect(isPlatformProbe('/')).toBe(true);
    expect(isPlatformProbe('/health')).toBe(true);
    expect(isPlatformProbe('/pricing')).toBe(false);
    expect(isPlatformProbe('/health/deep')).toBe(false);
    expect(isPlatformProbe('')).toBe(false);
  });
});

describe('a recognised hostname is unaffected', () => {
  it('serves the real site on the platform hostname and the custom domains', () => {
    expect(resolveSite(deployment, 'detent-agentic-assistant.replit.app', '/')?.site)
      .toBe('marketing');
    expect(resolveSite(deployment, 'www.detent.co.uk', '/')?.site).toBe('marketing');
    expect(resolveSite(deployment, 'www.detent.co.uk', '/app')?.site).toBe('app');
    expect(resolveSite(deployment, 'app.detent.co.uk', '/')?.site).toBe('console');
  });

  it('does not reach the console from the public domain', () => {
    expect(resolveSite(deployment, 'www.detent.co.uk', '/console')?.site).toBe('marketing');
  });
});


/**
 * The back office has to be reachable somewhere.
 *
 * The rule that broke it: /console was refused on the platform's own hostname
 * unless an operator had set a flag naming it. That refusal protects the
 * separation between the console and everything else, but the separation only
 * exists once there is a second hostname to separate onto. With no console host
 * configured there is one hostname serving the whole app, and refusing /console
 * on it protected nothing and hid the back office behind the marketing site's
 * 404.
 *
 * It appeared only where a platform hostname exists, which is every Replit
 * workspace and every deployment and no laptop, so it did not reproduce
 * anywhere it was looked for. Reported three times as "the sign in page is not
 * working".
 */
describe('reaching the back office', () => {
  const preview = hostConfigFrom({ REPLIT_DEV_DOMAIN: 'x.picard.replit.dev' }, false);
  const deployedBare = hostConfigFrom({ REPLIT_DOMAINS: 'detent.replit.app' }, true);
  const deployedWithConsoleHost = hostConfigFrom({
    REPLIT_DOMAINS: 'detent.replit.app',
    DETENT_CONSOLE_HOST: 'app.detent.co.uk',
    DETENT_MARKETING_HOST: 'www.detent.co.uk',
    DETENT_APP_HOST: 'www.detent.co.uk',
  }, true);

  it('serves the console on the workspace preview hostname', () => {
    for (const path of ['/console', '/console/signin', '/console/website']) {
      expect(resolveSite(preview, 'x.picard.replit.dev', path)?.site, path).toBe('console');
    }
  });

  it('serves the console on a deployment that has no console host of its own', () => {
    expect(resolveSite(deployedBare, 'detent.replit.app', '/console/signin')?.site)
      .toBe('console');
  });

  it('still keeps it off the platform hostname once it has a host of its own', () => {
    // Here the refusal means something: the operator has chosen the separation.
    expect(resolveSite(deployedWithConsoleHost, 'detent.replit.app', '/console/signin')?.site)
      .toBe('marketing');
    expect(consoleIsElsewhere(deployedWithConsoleHost, '/console/signin')).toBe(true);
    // And it is explained rather than 404ing as an unknown marketing page.
    expect(consoleIsElsewhere(deployedBare, '/console/signin')).toBe(false);
    expect(consoleIsElsewhere(deployedWithConsoleHost, '/pricing')).toBe(false);
  });

  it('reaches it on the platform hostname when the operator asks, DNS pending', () => {
    const pending = hostConfigFrom({
      REPLIT_DOMAINS: 'detent.replit.app',
      DETENT_CONSOLE_HOST: 'app.detent.co.uk',
      DETENT_CONSOLE_ON_PLATFORM_HOST: 'true',
    }, true);
    expect(resolveSite(pending, 'detent.replit.app', '/console/signin')?.site).toBe('console');
    expect(consoleIsElsewhere(pending, '/console/signin')).toBe(false);
  });

  it('never serves the console from a customer domain', () => {
    // The property the separate hostname exists for, unchanged by any of this.
    expect(resolveSite(deployedWithConsoleHost, 'www.detent.co.uk', '/console')?.site)
      .toBe('marketing');
    expect(resolveSite(deployedWithConsoleHost, 'www.detent.co.uk', '/console/signin')?.site)
      .toBe('marketing');
  });

  it('leaves the customer and reseller sign-ins where they were', () => {
    expect(resolveSite(preview, 'x.picard.replit.dev', '/app/signin')?.site).toBe('app');
    expect(resolveSite(preview, 'x.picard.replit.dev', '/reseller/signin')?.site)
      .toBe('reseller');
  });
});


describe('the page shown when the console is somewhere else', () => {
  it('names the setting that reaches it, and not the hostname', () => {
    const page = consoleElsewherePage();
    expect(page).toContain('DETENT_CONSOLE_ON_PLATFORM_HOST');
    expect(page).toContain('noindex');
    // Whoever configured the console host knows it. Nobody else is entitled to
    // be told where the staff entrance is by asking a public URL.
    expect(page).not.toContain('detent.co.uk');
  });
});

/**
 * A guessed sign-in address lands somewhere.
 *
 * The sign-in page was reported as not loading four times while it was being
 * served correctly at /console/signin. The public site does not link to the
 * back office, on purpose, so the only way to it is a remembered path, and
 * every reasonable guess (/signin, /login, /admin) answered with the marketing
 * site's 404. Being technically right about those is worth less than landing
 * the person where they were going.
 */
describe('the addresses people type when they want to sign in', () => {
  it('recognises the obvious guesses, in any case', () => {
    for (const path of ['/signin', '/sign-in', '/login', '/log-in', '/admin', '/SignIn']) {
      expect(signInAliasFor(path), path).toBeDefined();
    }
  });

  it('leaves the real pages alone', () => {
    for (const path of ['/', '/pricing', '/console/signin', '/app/signin', '/logins']) {
      expect(signInAliasFor(path), path).toBeUndefined();
    }
  });
});
