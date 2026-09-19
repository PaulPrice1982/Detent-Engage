/**
 * Shipped copy has to reach a site that is already live.
 *
 * The marketing copy ships in the release and lives in the database, and the
 * seed ran only when the site had no pages at all. So the wording the first
 * deployment happened to create was the wording for ever: a release could
 * rewrite every word of the home page and the live site would carry on showing
 * what it was born with. Reported, correctly, as "the text still says the old
 * thing", after three releases that had each changed it.
 *
 * The rule, and the reason this file exists: newer shipped copy replaces the
 * page it seeded, and **never** replaces a page a person has edited.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryPageStore, PageService } from '../packages/cms/src/pages.js';
import { MARKETING_COPY_REVISION, seedHomePage } from '../packages/server/src/marketing-seed.js';
import { newSection } from '../packages/cms/src/pages.js';

function service(): PageService {
  return new PageService(new InMemoryPageStore());
}

/** The copy as an earlier release shipped it, so a stale site can be built. */
async function seedOldCopy(pages: PageService): Promise<void> {
  await pages.reseed({
    slug: 'home',
    title: 'Old title',
    description: 'Old description.',
    sections: [{ ...newSection('hero', 'ink'), heading: 'Books you meetings.' }],
    revision: 1,
  });
}

describe('a release brings the live site with it', () => {
  it('seeds an empty site and publishes it', async () => {
    const pages = service();
    expect(await seedHomePage(pages, '')).toBe('created');
    const live = await pages.live('home');
    expect(live?.state).toBe('published');
    expect(live!.sections.length).toBeGreaterThan(5);
  });

  it('replaces copy an earlier release seeded, and republishes it', async () => {
    const pages = service();
    await seedOldCopy(pages);
    expect((await pages.live('home'))!.sections[0]!.heading).toBe('Books you meetings.');

    expect(await seedHomePage(pages, '')).toBe('updated');

    const live = await pages.live('home');
    expect(live?.state).toBe('published');
    expect(live!.sections[0]!.heading).not.toBe('Books you meetings.');
    expect(live!.seedRevision).toBe(MARKETING_COPY_REVISION);
  });

  it('does nothing on the second boot of the same release', async () => {
    const pages = service();
    await seedHomePage(pages, '');
    expect(await seedHomePage(pages, '')).toBe('current');
    expect(await seedHomePage(pages, '')).toBe('current');
  });

  it('never overwrites a page somebody edited in the console', async () => {
    const pages = service();
    await seedOldCopy(pages);
    const page = (await pages.findBySlug('home'))!;
    await pages.update(page.pageId, {
      sections: [{ ...newSection('hero', 'ink'), heading: 'Our own words.' }],
    }, 'paul@detent.co.uk');
    await pages.publish(page.pageId, 'paul@detent.co.uk');

    expect(await seedHomePage(pages, '')).toBe('kept-edited');
    expect((await pages.live('home'))!.sections[0]!.heading).toBe('Our own words.');
  });
});

describe('the copy this release ships', () => {
  it('does not sell a booked meeting as the outcome', async () => {
    const pages = service();
    await seedHomePage(pages, '');
    const live = await pages.live('home');
    const text = JSON.stringify(live).toLowerCase();

    // Meetings are still mentioned: the argument is that they are one outcome
    // among several, and a page that never named them could not make it.
    expect(text).toContain('meeting');
    // The promise is the answer, and what the answer leads to.
    expect(text).toContain('does whatever the answer leads to');
    expect(live!.description).not.toContain('books meetings');
  });

  it('compares a person, Detent, and having nobody at all', async () => {
    const pages = service();
    await seedHomePage(pages, '');
    const live = await pages.live('home');
    const comparison = live!.sections.find(
      (section) => section.columns?.some((column) => column.toLowerCase().includes('nobody')),
    );
    expect(comparison, 'the three-way comparison is missing').toBeDefined();
    expect(comparison!.columns).toHaveLength(4);
    // The three answers the reader is choosing between.
    expect(comparison!.columns!.join(' ')).toMatch(/person/i);
    expect(comparison!.columns!.join(' ')).toMatch(/detent/i);
    expect(comparison!.rows!.length).toBeGreaterThanOrEqual(5);
  });

  it('puts a number on the revenue lost by having no agent', async () => {
    const pages = service();
    await seedHomePage(pages, '');
    const live = await pages.live('home');
    const lost = live!.sections.find(
      (section) => section.columns?.some((column) => column.toLowerCase().includes('doing nothing')),
    );
    expect(lost, 'the arithmetic on doing nothing is missing').toBeDefined();
    // Every row must carry both sides: what it cost, and what it was worth.
    for (const row of lost!.rows ?? []) {
      expect(row).toHaveLength(5);
      expect(row.join(' ')).toMatch(/£/);
    }
  });
});
