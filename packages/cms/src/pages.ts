import { randomBytes } from 'node:crypto';
import { AwaError, type Clock, systemClock } from '@detent/awa-core';

/**
 * The marketing site's content model.
 *
 * Pages are built from **sections**, and a section is a typed block with a
 * chosen layout, not free HTML. That is the decision the whole design rests
 * on, and it is deliberate:
 *
 *  - A page assembled from typed sections cannot be broken by an author. There
 *    is no way to leave a tag open, no way to paste a script, and no way to
 *    produce a page that looks wrong on a phone.
 *  - It renders inside the brand rather than beside it. Someone adding a page
 *    at four in the afternoon gets Detent's typography and spacing because
 *    those are not theirs to set.
 *  - The content is data, so it can be versioned, previewed, rolled back and
 *    audited, all of which are impossible once a page is a blob of markup.
 *
 * The cost is that an author cannot do anything the section types do not
 * support. That is the correct trade for a marketing site of ten pages, and the
 * answer when it stops being correct is a new section type, not an escape hatch.
 */

export type SectionKind =
  /** Full-width opening statement with up to two calls to action. */
  | 'hero'
  /** Two to four cards. The commonest section on any marketing page. */
  | 'features'
  /** Two columns, framed as a contrast: what usually happens, what we do. */
  | 'contrast'
  /** A single large claim, set as a statement rather than a paragraph. */
  | 'statement'
  /** Body copy with an optional heading. Paragraphs only. */
  | 'prose'
  /** Questions and answers. */
  | 'faq'
  /** Pricing, drawn live from the plan catalogue rather than typed. */
  | 'pricing'
  /** A closing call to action. */
  | 'cta'
  /** A labelled list of steps, numbered in order. */
  | 'steps'
  /** A recorded demonstration of the product, with a written description. */
  | 'demo'
  /** A comparison table. Rows are authored as text, one line each. */
  | 'table';

export type SectionTone = 'light' | 'tint' | 'ink';

export interface SectionItem {
  readonly heading?: string;
  readonly body?: string;
  /** Used by 'contrast' to separate the two columns. */
  readonly column?: 'left' | 'right';
}

export interface Section {
  readonly sectionId: string;
  readonly kind: SectionKind;
  /** Small label above the heading. */
  readonly kicker?: string;
  readonly heading?: string;
  readonly lede?: string;
  readonly items: readonly SectionItem[];
  readonly primaryActionLabel?: string;
  readonly primaryActionHref?: string;
  readonly secondaryActionLabel?: string;
  readonly secondaryActionHref?: string;
  /** Background treatment. Alternating tones is what gives a page rhythm. */
  readonly tone: SectionTone;
  /**
   * A demonstration recording: the video, the still shown before it plays, and
   * a written description of what it shows.
   *
   * The description is not a caption. A video is invisible to a screen reader,
   * to a search engine, and to anyone on a connection that will not carry it , 
   * three audiences a marketing page cannot afford to lose. Whatever the video
   * demonstrates has to be readable as text beside it.
   */
  readonly mediaSrc?: string;
  readonly mediaPoster?: string;
  readonly mediaDescription?: string;
  /**
   * Column headings for a table section.
   *
   * Kept separate from the rows so the header can be styled and, more
   * importantly, so a screen reader is told which cells are headers. A table
   * whose first row merely looks like a heading is a table nobody can read
   * without sight.
   */
  readonly columns?: readonly string[];
  /**
   * Rows, each a list of cells.
   *
   * Authored in the console as one line per row with cells separated by a
   * vertical bar, which is the most a non-technical author should have to
   * learn to edit a table. Rows shorter than the header are padded rather
   * than rejected: a half-finished table should render, not 500.
   */
  readonly rows?: readonly (readonly string[])[];
  /** Emphasises one column: the one the page is arguing for. */
  readonly highlightColumn?: number;
}

export type PageState = 'draft' | 'published' | 'archived';

export interface Page {
  readonly pageId: string;
  /** URL path, without a leading slash. Empty string is the home page. */
  readonly slug: string;
  readonly title: string;
  /** The meta description. Shown in search results, so it is not optional. */
  readonly description: string;
  readonly state: PageState;
  readonly sections: readonly Section[];
  /** Shown in the site's own navigation, in this order. */
  readonly navLabel?: string;
  readonly navOrder?: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly publishedAt?: string;
  readonly publishedBy?: string;
  /** The published version, kept while a draft is edited. */
  readonly publishedSnapshot?: Omit<Page, 'publishedSnapshot'>;
  /**
   * Which revision of the shipped copy this page was seeded from.
   *
   * The marketing copy ships in the release and lives in the database, and
   * before this the two could not be reconciled: the seed ran only when there
   * were no pages at all, so the first deployment fixed the wording of the site
   * for ever. A release could rewrite every word of the home page and the live
   * site would carry on showing the copy it was born with, which is exactly
   * what happened.
   *
   * Absent means seeded before this existed, and therefore older than anything
   * shipping now. See PageService.reseed.
   */
  readonly seedRevision?: number;
}

export interface PageStore {
  get(pageId: string): Promise<Page | undefined>;
  findBySlug(slug: string): Promise<Page | undefined>;
  put(page: Page): Promise<void>;
  list(): Promise<readonly Page[]>;
  delete(pageId: string): Promise<void>;
}

export class InMemoryPageStore implements PageStore {
  private readonly pages = new Map<string, Page>();
  async get(pageId: string): Promise<Page | undefined> { return this.pages.get(pageId); }
  async findBySlug(slug: string): Promise<Page | undefined> {
    return [...this.pages.values()].find((page) => page.slug === slug);
  }
  async put(page: Page): Promise<void> { this.pages.set(page.pageId, page); }
  async list(): Promise<readonly Page[]> {
    return [...this.pages.values()].sort((a, b) =>
      (a.navOrder ?? 999) - (b.navOrder ?? 999) || a.slug.localeCompare(b.slug));
  }
  async delete(pageId: string): Promise<void> { this.pages.delete(pageId); }
}

/**
 * Normalises a slug.
 *
 * Reserved prefixes are refused rather than rewritten: a page at `app` or
 * `console` would shadow a site, and silently renaming it to `app-2` gives an
 * author a page they did not ask for at an address they will not find.
 */
const RESERVED = new Set(['app', 'console', 'api', 'v1', 'widget', 'health', 'admin', 'static']);

export function normaliseSlug(input: string): string {
  return input.trim().toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9/-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export function slugProblem(slug: string): string | undefined {
  const first = slug.split('/')[0] ?? '';
  if (RESERVED.has(first)) {
    return `"${first}" is reserved: a page there would shadow part of the product.`;
  }
  if (slug.length > 120) return 'That address is too long.';
  return undefined;
}

export function newSection(kind: SectionKind, tone: SectionTone = 'light'): Section {
  return {
    sectionId: `sec_${randomBytes(6).toString('base64url')}`,
    kind,
    tone,
    items: defaultItemsFor(kind),
  };
}

/**
 * Sensible starting content for a new section.
 *
 * An empty section renders as an empty box, and an author looking at an empty
 * box does not know what the section is for. Placeholder items show the shape.
 */
function defaultItemsFor(kind: SectionKind): readonly SectionItem[] {
  switch (kind) {
    case 'features':
      return [
        { heading: 'First point', body: 'What it does and why it matters.' },
        { heading: 'Second point', body: 'What it does and why it matters.' },
        { heading: 'Third point', body: 'What it does and why it matters.' },
      ];
    case 'contrast':
      return [
        { column: 'left', body: 'What usually happens.' },
        { column: 'right', body: 'What we do instead.' },
      ];
    case 'faq':
      return [{ heading: 'A question a buyer asks', body: 'The answer.' }];
    case 'steps':
      return [
        { heading: 'Step one', body: 'What happens first.' },
        { heading: 'Step two', body: 'What happens next.' },
      ];
    case 'prose':
      return [{ body: 'Body copy.' }];
    case 'demo':
      return [{ body: 'Describe what the recording shows.' }];
    case 'table':
      return [];
    default:
      return [];
  }
}

export interface CreatePageInput {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly navLabel?: string;
  readonly navOrder?: number;
  readonly createdBy: string;
}

/**
 * The author name the seed writes under.
 *
 * A page whose last editor is this has never been touched by a person, which is
 * the whole test reseed depends on.
 */
export const SEED_AUTHOR = 'system';

export interface SeedPageInput {
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly sections: readonly Section[];
  readonly navLabel?: string;
  readonly navOrder?: number;
  /** Bumped in the release whenever the shipped copy changes. */
  readonly revision: number;
}

/** What reseed did, for the boot log. */
export type SeedOutcome = 'created' | 'updated' | 'current' | 'kept-edited';

export class PageService {
  constructor(
    private readonly store: PageStore,
    private readonly clock: Clock = systemClock,
  ) {}

  async create(input: CreatePageInput): Promise<Page> {
    const slug = normaliseSlug(input.slug);
    const problem = slugProblem(slug);
    if (problem) throw new AwaError({ kind: 'SCHEMA_INVALID', message: problem });
    if (!input.title.trim()) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'Give the page a title.' });
    }
    if (!input.description.trim()) {
      // The meta description is what a buyer reads in a search result before
      // they ever see the page. Optional means absent means a worse result.
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message: 'Write a description. It is what appears under the title in search results.',
      });
    }
    if (await this.store.findBySlug(slug)) {
      throw new AwaError({ kind: 'CONFLICT', message: `There is already a page at /${slug}.` });
    }

    const now = this.clock.iso();
    const page: Page = {
      pageId: `pg_${randomBytes(8).toString('base64url')}`,
      slug,
      title: input.title.trim(),
      description: input.description.trim(),
      state: 'draft',
      sections: [newSection('hero', 'ink')],
      navLabel: input.navLabel?.trim() || undefined,
      navOrder: input.navOrder,
      createdAt: now, createdBy: input.createdBy,
      updatedAt: now, updatedBy: input.createdBy,
    };
    await this.store.put(page);
    return page;
  }

  /**
   * Brings a seeded page up to the copy in this release.
   *
   * The rule that makes this safe: **an edited page is never overwritten.** A
   * page still authored by the seed is replaced wholesale and republished; one
   * a person has touched in the console is left exactly as they left it, and
   * the caller is told so it can be said out loud at boot rather than
   * discovered by someone wondering where their words went.
   *
   * Replacing wholesale rather than merging is deliberate. A merge between
   * shipped copy and stored copy has no correct answer when a section has been
   * reordered or removed, and a marketing page that is half one release and
   * half another reads worse than either.
   */
  async reseed(input: SeedPageInput): Promise<SeedOutcome> {
    const slug = normaliseSlug(input.slug);
    const existing = await this.store.findBySlug(slug);

    if (!existing) {
      const created = await this.create({
        slug, title: input.title, description: input.description,
        navLabel: input.navLabel, navOrder: input.navOrder, createdBy: SEED_AUTHOR,
      });
      await this.writeSeed(created, input);
      return 'created';
    }

    // Somebody has edited this page. Their words win, always, and a release
    // that disagrees says so rather than acting on it.
    if (existing.updatedBy !== SEED_AUTHOR) return 'kept-edited';
    if ((existing.seedRevision ?? 0) >= input.revision) return 'current';

    await this.writeSeed(existing, input);
    return 'updated';
  }

  /** Writes the shipped copy over a page and publishes it, as the seed. */
  private async writeSeed(page: Page, input: SeedPageInput): Promise<void> {
    const now = this.clock.iso();
    await this.store.put({
      ...page,
      title: input.title.trim(),
      description: input.description.trim(),
      sections: input.sections,
      navLabel: input.navLabel?.trim() || undefined,
      navOrder: input.navOrder,
      seedRevision: input.revision,
      state: 'published',
      updatedAt: now, updatedBy: SEED_AUTHOR,
      publishedAt: now, publishedBy: SEED_AUTHOR,
      publishedSnapshot: undefined,
    });
  }

  async update(pageId: string, changes: Partial<Pick<Page,
    'title' | 'description' | 'navLabel' | 'navOrder' | 'sections'>>, by: string): Promise<Page> {
    const page = await this.require(pageId);
    const updated: Page = {
      ...page, ...changes,
      updatedAt: this.clock.iso(), updatedBy: by,
      // Editing a published page returns it to draft. The live version keeps
      // serving from its snapshot until somebody publishes again, so a
      // half-finished edit is never what a visitor sees.
      state: page.state === 'published' ? 'draft' : page.state,
      publishedSnapshot: page.state === 'published'
        ? (page.publishedSnapshot ?? stripSnapshot(page))
        : page.publishedSnapshot,
    };
    await this.store.put(updated);
    return updated;
  }

  async addSection(pageId: string, kind: SectionKind, by: string): Promise<Page> {
    const page = await this.require(pageId);
    // Alternate the tone with the section before it, so a page has rhythm
    // without an author having to think about it.
    const previous = page.sections[page.sections.length - 1];
    const tone: SectionTone = previous?.tone === 'tint' ? 'light' : 'tint';
    return this.update(pageId, { sections: [...page.sections, newSection(kind, tone)] }, by);
  }

  async updateSection(pageId: string, sectionId: string,
    changes: Partial<Section>, by: string): Promise<Page> {
    const page = await this.require(pageId);
    return this.update(pageId, {
      sections: page.sections.map((section) =>
        section.sectionId === sectionId ? { ...section, ...changes } : section),
    }, by);
  }

  async removeSection(pageId: string, sectionId: string, by: string): Promise<Page> {
    const page = await this.require(pageId);
    return this.update(pageId, {
      sections: page.sections.filter((section) => section.sectionId !== sectionId),
    }, by);
  }

  /** Moves a section up or down. Order is the layout. */
  async moveSection(pageId: string, sectionId: string,
    direction: 'up' | 'down', by: string): Promise<Page> {
    const page = await this.require(pageId);
    const index = page.sections.findIndex((section) => section.sectionId === sectionId);
    if (index < 0) return page;
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= page.sections.length) return page;
    const sections = [...page.sections];
    [sections[index], sections[target]] = [sections[target]!, sections[index]!];
    return this.update(pageId, { sections }, by);
  }

  async publish(pageId: string, by: string): Promise<Page> {
    const page = await this.require(pageId);
    if (page.sections.length === 0) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'A page with no sections is blank.' });
    }
    const now = this.clock.iso();
    const published: Page = {
      ...page, state: 'published', publishedAt: now, publishedBy: by,
      // The snapshot is cleared: the live page is now the page itself.
      publishedSnapshot: undefined,
    };
    await this.store.put(published);
    return published;
  }

  /** Takes a page off the site without deleting it. */
  async archive(pageId: string, by: string): Promise<Page> {
    const page = await this.require(pageId);
    const archived: Page = {
      ...page, state: 'archived', updatedAt: this.clock.iso(), updatedBy: by,
      publishedSnapshot: undefined,
    };
    await this.store.put(archived);
    return archived;
  }

  /** What a visitor gets: the published version, or nothing. */
  async live(slug: string): Promise<Page | undefined> {
    const page = await this.store.findBySlug(normaliseSlug(slug));
    if (!page) return undefined;
    if (page.state === 'published') return page;
    // A page being edited keeps serving its last published version.
    if (page.state === 'draft' && page.publishedSnapshot) {
      return { ...page.publishedSnapshot, state: 'published' } as Page;
    }
    return undefined;
  }

  /** The site's navigation, from pages that opted into it. */
  async navigation(): Promise<readonly { label: string; href: string }[]> {
    const pages = await this.store.list();
    return pages
      .filter((page) => page.navLabel && (page.state === 'published' || page.publishedSnapshot))
      .map((page) => ({ label: page.navLabel!, href: `/${page.slug}` }));
  }

  async get(pageId: string): Promise<Page | undefined> { return this.store.get(pageId); }

  /**
   * A page at an address, whatever its state.
   *
   * Distinct from `live`, which serves only what is published. Seeding needs
   * this one: asking `live` whether a page exists says no about a page that
   * exists as a draft, and seeding it again collides on the address.
   */
  async findBySlug(slug: string): Promise<Page | undefined> {
    return this.store.findBySlug(normaliseSlug(slug));
  }

  async list(): Promise<readonly Page[]> { return this.store.list(); }
  async remove(pageId: string): Promise<void> { await this.store.delete(pageId); }

  private async require(pageId: string): Promise<Page> {
    const page = await this.store.get(pageId);
    if (!page) throw new AwaError({ kind: 'NOT_FOUND', message: 'No such page.' });
    return page;
  }
}

function stripSnapshot(page: Page): Omit<Page, 'publishedSnapshot'> {
  const { publishedSnapshot, ...rest } = page;
  void publishedSnapshot;
  return rest;
}
