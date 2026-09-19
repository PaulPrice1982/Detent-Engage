import { describe, expect, it } from 'vitest';
import { FixedClock } from '@detent/awa-core';
import {
  InMemoryPageStore, PageService, escapeHtml, newSection, normaliseSlug,
  renderSection, safeHref, slugProblem,
} from '@detent/awa-cms';
import {
  checkHosts, hostnameOf, platformHostsFrom, recognisedHosts, resolveSite, type HostConfig,
} from '@detent/awa-server';

const clock = () => new FixedClock(new Date('2026-03-01T09:00:00.000Z'));
const service = () => new PageService(new InMemoryPageStore(), clock());
const draft = async (over: Record<string, string> = {}) => {
  const pages = service();
  const page = await pages.create({
    slug: 'how-it-works', title: 'How it works',
    description: 'What the assistant does.', createdBy: 'paul@detentgtm.io', ...over,
  });
  return { pages, page };
};

describe('page addresses', () => {
  it('normalises what an author types', () => {
    expect(normaliseSlug('/How It Works/')).toBe('how-it-works');
    expect(normaliseSlug('  Pricing  ')).toBe('pricing');
  });

  it('refuses an address that would shadow part of the product', () => {
    // A page at /app or /console would hide a site. Silently renaming it gives
    // an author a page at an address they will not find.
    for (const reserved of ['app', 'console', 'health', 'v1', 'widget']) {
      expect(slugProblem(reserved)).toMatch(/reserved/i);
    }
    expect(slugProblem('how-it-works')).toBeUndefined();
  });

  it('refuses a page with no description', async () => {
    // It is what a buyer reads in a search result before seeing the page.
    await expect(draft({ description: '' })).rejects.toThrow(/search results/i);
  });

  it('refuses a second page at the same address', async () => {
    const { pages } = await draft();
    await expect(pages.create({
      slug: 'how-it-works', title: 'Other', description: 'x', createdBy: 'u',
    })).rejects.toThrow(/already a page/i);
  });
});

describe('drafts and publishing', () => {
  it('creates a page as a draft, invisible to visitors', async () => {
    const { pages, page } = await draft();
    expect(page.state).toBe('draft');
    expect(await pages.live('how-it-works')).toBeUndefined();
  });

  it('publishes it', async () => {
    const { pages, page } = await draft();
    await pages.publish(page.pageId, 'paul@detentgtm.io');
    expect((await pages.live('how-it-works'))?.title).toBe('How it works');
  });

  it('keeps serving the published version while an edit is in progress', async () => {
    // A half-finished edit is never what a visitor sees.
    const { pages, page } = await draft();
    await pages.publish(page.pageId, 'paul@detentgtm.io');
    await pages.update(page.pageId, { title: 'Half-written new title' }, 'paul@detentgtm.io');

    expect((await pages.get(page.pageId))?.state).toBe('draft');
    expect((await pages.live('how-it-works'))?.title).toBe('How it works');

    await pages.publish(page.pageId, 'paul@detentgtm.io');
    expect((await pages.live('how-it-works'))?.title).toBe('Half-written new title');
  });

  it('refuses to publish a page with no sections', async () => {
    const { pages, page } = await draft();
    await pages.update(page.pageId, { sections: [] }, 'u');
    await expect(pages.publish(page.pageId, 'u')).rejects.toThrow(/blank/i);
  });

  it('takes a page off the site without deleting it', async () => {
    const { pages, page } = await draft();
    await pages.publish(page.pageId, 'u');
    await pages.archive(page.pageId, 'u');
    expect(await pages.live('how-it-works')).toBeUndefined();
    expect(await pages.get(page.pageId)).toBeDefined();
  });
});

describe('sections', () => {
  it('alternates the background so a page has rhythm without thought', async () => {
    const { pages, page } = await draft();
    const withTwo = await pages.addSection(page.pageId, 'features', 'u');
    const tones = withTwo.sections.map((section) => section.tone);
    expect(tones[1]).not.toBe(tones[0]);
  });

  it('reorders sections, because order is the layout', async () => {
    const { pages, page } = await draft();
    let current = await pages.addSection(page.pageId, 'features', 'u');
    const second = current.sections[1]!.sectionId;
    current = await pages.moveSection(page.pageId, second, 'up', 'u');
    expect(current.sections[0]!.sectionId).toBe(second);
  });

  it('does nothing when a section cannot move further', async () => {
    const { pages, page } = await draft();
    const first = page.sections[0]!.sectionId;
    const after = await pages.moveSection(page.pageId, first, 'up', 'u');
    expect(after.sections[0]!.sectionId).toBe(first);
  });

  it('removes a section', async () => {
    const { pages, page } = await draft();
    const after = await pages.removeSection(page.pageId, page.sections[0]!.sectionId, 'u');
    expect(after.sections.length).toBe(0);
  });
});

describe('rendering author content', () => {
  it('escapes everything an author typed', () => {
    // They are colleagues, not attackers, but "we trust the author" is how a
    // pasted snippet becomes a script tag on the homepage.
    const html = renderSection({
      ...newSection('prose'),
      heading: '<script>alert(1)</script>',
      items: [{ body: '<img onerror=x>' }],
    });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;script&gt;');
  });

  it('refuses a javascript: link typed into a console field', () => {
    // It would be stored cross-site scripting on the marketing site, in the
    // one field nobody thought to check.
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('data:text/html,<script>')).toBeUndefined();
    expect(safeHref('//evil.example')).toBeUndefined();
    expect(safeHref('http://insecure.example')).toBeUndefined();
  });

  it('allows a same-site path, an https URL and an anchor', () => {
    expect(safeHref('/pricing')).toBe('/pricing');
    expect(safeHref('https://app.detentgtm.io/signup')).toBe('https://app.detentgtm.io/signup');
    expect(safeHref('#pricing')).toBe('#pricing');
  });

  it('turns blank lines into paragraphs and keeps them escaped', () => {
    const html = renderSection({ ...newSection('prose'), items: [{ body: 'One <b>\n\nTwo' }] });
    expect(html).toContain('<p>One &lt;b&gt;</p>');
    expect(html).toContain('<p>Two</p>');
  });

  it('escapes a title that contains markup', () => {
    expect(escapeHtml('<a href="x">')).toBe('&lt;a href=&quot;x&quot;&gt;');
  });
});

describe('which site a request belongs to', () => {
  // The production plan: one customer domain, one staff domain.
  const hosts: HostConfig = {
    marketingHost: 'www.detent.co.uk',
    appHost: 'www.detent.co.uk',
    consoleHost: 'app.detent.co.uk',
    allowPathPrefixes: false,
  };

  it('serves the public site and the customer area from one hostname', () => {
    expect(resolveSite(hosts, 'www.detent.co.uk', '/')?.site).toBe('marketing');
    expect(resolveSite(hosts, 'www.detent.co.uk', '/pricing')?.site).toBe('marketing');
    expect(resolveSite(hosts, 'www.detent.co.uk', '/app')?.site).toBe('app');
    expect(resolveSite(hosts, 'www.detent.co.uk', '/app/knowledge')?.site).toBe('app');
  });

  it('serves the console at the root of its own hostname', () => {
    // https://app.detent.co.uk/ is a request for the console home. Without the
    // prefix mapping the console answers its own domain with a 404, because
    // every route it has lives under /console.
    const match = resolveSite(hosts, 'app.detent.co.uk', '/');
    expect(match?.site).toBe('console');
    expect(match?.path).toBe('/console');
    expect(resolveSite(hosts, 'app.detent.co.uk', '/sign-in')?.path).toBe('/console/sign-in');
    // A link already written with the prefix still resolves, unchanged.
    expect(resolveSite(hosts, 'app.detent.co.uk', '/console/website')?.path)
      .toBe('/console/website');
  });

  it('will not serve the console from the customer domain', () => {
    // The property the separate hostname exists for. A path prefix is a
    // boundary maintained by routing code; a hostname is maintained by DNS.
    expect(resolveSite(hosts, 'www.detent.co.uk', '/console')?.site).toBe('marketing');
    expect(resolveSite(hosts, 'www.detent.co.uk', '/console/accounts')?.site).toBe('marketing');
  });

  it('maps a dedicated customer hostname onto the app root', () => {
    // If the customer area is later moved to app.detent.co.uk of its own, the
    // same mapping applies, and no link has to change.
    const split: HostConfig = {
      marketingHost: 'www.detent.co.uk',
      appHost: 'my.detent.co.uk',
      consoleHost: 'ops.detent.co.uk',
      allowPathPrefixes: false,
    };
    expect(resolveSite(split, 'my.detent.co.uk', '/')?.path).toBe('/app');
    expect(resolveSite(split, 'my.detent.co.uk', '/knowledge')?.path).toBe('/app/knowledge');
    expect(resolveSite(split, 'my.detent.co.uk', '/')?.site).toBe('app');
  });

  it('serves nothing on an unrecognised hostname in a deployment', () => {
    // Answering an unknown Host with the marketing site is how a dangling DNS
    // record becomes somebody else's phishing page.
    expect(resolveSite(hosts, 'random.example', '/')).toBeUndefined();
  });

  it('falls back to path prefixes only in development', () => {
    const dev: HostConfig = { allowPathPrefixes: true };
    expect(resolveSite(dev, 'localhost:8787', '/console')?.site).toBe('console');
    expect(resolveSite(dev, 'localhost:8787', '/app/billing')?.site).toBe('app');
    expect(resolveSite(dev, 'localhost:8787', '/')?.site).toBe('marketing');
  });

  it('strips the port from a Host header', () => {
    expect(hostnameOf('app.detent.co.uk:443')).toBe('app.detent.co.uk');
    expect(hostnameOf('LOCALHOST:8787')).toBe('localhost');
    expect(hostnameOf('[::1]:8787')).toBe('[::1]');
  });

  it('refuses a deployment with no console host', () => {
    expect(checkHosts({ allowPathPrefixes: false }, true).length).toBeGreaterThan(0);
  });

  it('accepts the console alongside a shared customer hostname', () => {
    // Replaces an earlier test that refused ANY two sites sharing a hostname.
    // That rule was wrong: it also refused marketing and the customer area
    // sharing www, which is the intended production arrangement and is not a
    // security boundary. Only the console is required to stand alone.
    expect(checkHosts(hosts, true)).toEqual([]);
  });

  it('refuses the console sharing a hostname with a customer surface', () => {
    const shared = checkHosts({
      marketingHost: 'www.detent.co.uk', appHost: 'www.detent.co.uk',
      consoleHost: 'www.detent.co.uk', allowPathPrefixes: false,
    }, true);
    expect(shared.some((problem) => /same hostname/i.test(problem.message))).toBe(true);
  });

  it('refuses a deployment where no hostname serves the customer area', () => {
    const problems = checkHosts({
      marketingHost: 'www.detent.co.uk',
      consoleHost: 'app.detent.co.uk', allowPathPrefixes: false,
    }, true);
    expect(problems.some((problem) => /DETENT_APP_HOST/.test(problem.message))).toBe(true);
  });

  it('checks nothing in development, where one port serves all three', () => {
    expect(checkHosts({ allowPathPrefixes: true }, false)).toEqual([]);
  });

  it('still serves on the hostname the platform gave it', () => {
    // The failure this pins, which took a live deployment dark: custom domains
    // were configured before DNS pointed at anything, so every request arrived
    // on the platform's own hostname, matched nothing, and got a 404 on every
    // page, including the sign-in page, with no indication of why.
    const withPlatform: HostConfig = {
      ...hosts,
      platformHosts: ['detent-agentic-assistant.replit.app'],
    };
    const at = (path: string) =>
      resolveSite(withPlatform, 'detent-agentic-assistant.replit.app', path);

    expect(at('/')?.site).toBe('marketing');
    expect(at('/app/signin')?.site).toBe('app');
    expect(at('/reseller')?.site).toBe('reseller');
    // The back office is still not there. A deploy URL is a public address.
    expect(at('/console/signin')?.site).toBe('marketing');
    // And the custom domains keep working alongside it.
    expect(resolveSite(withPlatform, 'app.detent.co.uk', '/')?.site).toBe('console');
  });

  it('puts the console on the platform hostname only when told to', () => {
    // Before a custom domain resolves there is one hostname, so the choice is
    // between an operator locked out of their own back office and a console
    // sharing an address with the public site. Explicit, never inferred.
    const opted: HostConfig = {
      ...hosts,
      platformHosts: ['detent-agentic-assistant.replit.app'],
      consoleOnPlatformHost: true,
    };
    expect(resolveSite(opted, 'detent-agentic-assistant.replit.app', '/console/signin')?.site)
      .toBe('console');
    expect(resolveSite(opted, 'detent-agentic-assistant.replit.app', '/')?.site)
      .toBe('marketing');
  });

  it('accepts a deployment configured with nothing but a platform hostname', () => {
    // The first deploy, before any custom domain exists. Refusing to start
    // here would mean the app can never be deployed before DNS is ready.
    expect(checkHosts({
      allowPathPrefixes: false,
      platformHosts: ['detent-agentic-assistant.replit.app'],
    }, true)).toEqual([]);
  });

  it('still refuses a deployment with no hostname at all', () => {
    const problems = checkHosts({ allowPathPrefixes: false }, true);
    expect(problems.length).toBeGreaterThan(0);
  });

  it('reads the platform hostnames the host actually publishes', () => {
    expect(platformHostsFrom({ REPLIT_DOMAINS: 'a.replit.app,b.replit.app' }))
      .toEqual(['a.replit.app', 'b.replit.app']);
    expect(platformHostsFrom({ REPLIT_DEV_DOMAIN: 'X.Replit.DEV' })).toEqual(['x.replit.dev']);
    expect(platformHostsFrom({})).toEqual([]);
  });

  it('lists every hostname it will answer, for the boot banner', () => {
    // A 404 on every page is a mystery until you can compare the URL in the
    // browser against this list.
    expect(recognisedHosts({
      ...hosts, platformHosts: ['x.replit.app'],
    })).toEqual(['app.detent.co.uk', 'www.detent.co.uk', 'x.replit.app']);
  });

  it('serves the reseller portal on the customer domain when it has no host', () => {
    // A reseller authenticates exactly as a customer does and sees only their
    // own book, so a path on the customer domain is an adequate separation.
    expect(resolveSite(hosts, 'www.detent.co.uk', '/reseller')?.site).toBe('reseller');
    expect(resolveSite(hosts, 'www.detent.co.uk', '/reseller/statements')?.site).toBe('reseller');
    // And it is still not the console.
    expect(resolveSite(hosts, 'www.detent.co.uk', '/console')?.site).toBe('marketing');
  });

  it('gives the reseller portal its own hostname when one is configured', () => {
    const withPortal: HostConfig = { ...hosts, resellerHost: 'partners.detent.co.uk' };
    const match = resolveSite(withPortal, 'partners.detent.co.uk', '/');
    expect(match?.site).toBe('reseller');
    expect(match?.path).toBe('/reseller');
    // Once it has its own host, the path on the customer domain stops routing
    // there: one address for one thing.
    expect(resolveSite(withPortal, 'www.detent.co.uk', '/reseller')?.site).toBe('marketing');
  });

  it('refuses the console sharing a hostname with the reseller portal', () => {
    // A reseller is not staff.
    const problems = checkHosts({
      marketingHost: 'www.detent.co.uk', appHost: 'www.detent.co.uk',
      consoleHost: 'app.detent.co.uk', resellerHost: 'app.detent.co.uk',
      allowPathPrefixes: false,
    }, true);
    expect(problems.some((problem) => /RESELLER_HOST/.test(problem.message))).toBe(true);
  });
});
