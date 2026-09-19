import type { Page, PageStore } from '@detent/awa-cms';
import type { Database } from './database.js';

/**
 * The website, durable.
 *
 * Losing this loses the marketing site. It is seeded at boot, so a restart
 * would silently reinstate the shipped copy over whatever had been written
 * since, which is worse than losing it outright, because it looks like it
 * worked.
 */
export class PostgresPageStore implements PageStore {
  constructor(private readonly database: Database) {}

  async get(pageId: string): Promise<Page | undefined> {
    const rows = await this.database.query<{ document: Page }>(
      'SELECT document FROM cms_page WHERE page_id = $1', [pageId],
    );
    return rows[0]?.document;
  }

  async findBySlug(slug: string): Promise<Page | undefined> {
    const rows = await this.database.query<{ document: Page }>(
      'SELECT document FROM cms_page WHERE slug = $1', [slug],
    );
    return rows[0]?.document;
  }

  async put(page: Page): Promise<void> {
    await this.database.query(
      `INSERT INTO cms_page (page_id, slug, state, nav_order, document)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (page_id) DO UPDATE SET
         slug = EXCLUDED.slug, state = EXCLUDED.state,
         nav_order = EXCLUDED.nav_order, document = EXCLUDED.document, updated_at = now()`,
      [page.pageId, page.slug, page.state, page.navOrder ?? null, JSON.stringify(page)],
    );
  }

  async list(): Promise<readonly Page[]> {
    // Ordered as the navigation is: by explicit order, then by address. NULLS
    // LAST puts an unordered page after the ordered ones rather than first,
    // which is what the in-memory store's `?? 999` was doing.
    const rows = await this.database.query<{ document: Page }>(
      'SELECT document FROM cms_page ORDER BY nav_order ASC NULLS LAST, slug ASC',
    );
    return rows.map((row) => row.document);
  }

  async delete(pageId: string): Promise<void> {
    await this.database.query('DELETE FROM cms_page WHERE page_id = $1', [pageId]);
  }
}
