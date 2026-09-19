import type { Page, Section } from './pages.js';

/**
 * Rendering a page from its sections.
 *
 * Every value an author typed is escaped. They are colleagues, not attackers,
 * but a marketing page is the most public surface the company has, and "we
 * trust the author" is how a pasted tracking snippet becomes a script tag on
 * the homepage. There is no path here that emits an author's text unescaped.
 */

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A link an author supplied.
 *
 * Only a same-site path or an https URL. A `javascript:` href typed into a
 * console field is stored cross-site scripting on the marketing site, and it
 * would be the one field nobody thought to check.
 */
export function safeHref(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) return trimmed;
  if (/^https:\/\/[^\s"'<>]+$/i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('#') && /^#[\w-]+$/.test(trimmed)) return trimmed;
  return undefined;
}

/** Author copy: escaped, with blank lines becoming paragraphs. */
function paragraphs(text: string | undefined): string {
  if (!text) return '';
  return text.split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function actions(section: Section): string {
  const primary = safeHref(section.primaryActionHref);
  const secondary = safeHref(section.secondaryActionHref);
  if (!primary && !secondary) return '';
  return `<div class="actions">
    ${primary && section.primaryActionLabel
      ? `<a class="btn primary" href="${escapeHtml(primary)}">${escapeHtml(section.primaryActionLabel)}</a>` : ''}
    ${secondary && section.secondaryActionLabel
      ? `<a class="btn ghost" href="${escapeHtml(secondary)}">${escapeHtml(section.secondaryActionLabel)}</a>` : ''}
  </div>`;
}

function head(section: Section): string {
  return `${section.kicker ? `<p class="kicker">${escapeHtml(section.kicker)}</p>` : ''}
${section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : ''}
${section.lede ? `<div class="lede">${paragraphs(section.lede)}</div>` : ''}`;
}

/** Extra content the server supplies, pricing comes from the live catalogue. */
export interface RenderContext {
  readonly pricingHtml?: string;
  /**
   * Whether this section's video may load before the visitor asks for it.
   *
   * True for the first recording on a page and false for the rest. Four
   * autoplaying videos fetching at once competes with the text for the
   * connection, on the phone most people read on, and largest contentful paint
   * is measured on that phone rather than on a desk.
   */
  readonly eagerMedia?: boolean;
}

export function renderSection(section: Section, context: RenderContext = {}): string {
  const toneClass = section.tone === 'ink' ? ' ink' : section.tone === 'tint' ? ' tint' : '';

  switch (section.kind) {
    case 'hero':
      return `<section class="hero${toneClass}"><div class="wrap">
        ${section.kicker ? `<p class="kicker">${escapeHtml(section.kicker)}</p>` : ''}
        ${section.heading ? `<h1>${escapeHtml(section.heading)}</h1>` : ''}
        ${section.lede ? `<div class="lede">${paragraphs(section.lede)}</div>` : ''}
        ${actions(section)}
      </div></section>`;

    case 'features':
      return `<section class="${toneClass.trim() || 'plain'}"><div class="wrap">
        ${head(section)}
        <div class="grid">${section.items.map((item) => `<div class="card">
          ${item.heading ? `<h3>${escapeHtml(item.heading)}</h3>` : ''}
          ${paragraphs(item.body)}
        </div>`).join('')}</div>
        ${actions(section)}
      </div></section>`;

    case 'steps':
      return `<section class="${toneClass.trim() || 'plain'}"><div class="wrap">
        ${head(section)}
        <ol class="steps">${section.items.map((item) => `<li>
          ${item.heading ? `<h3>${escapeHtml(item.heading)}</h3>` : ''}
          ${paragraphs(item.body)}
        </li>`).join('')}</ol>
        ${actions(section)}
      </div></section>`;

    case 'contrast': {
      const left = section.items.filter((item) => item.column !== 'right');
      const right = section.items.filter((item) => item.column === 'right');
      const column = (items: typeof left, cls: string, heading?: string) => `<div class="${cls}">
        ${heading ? `<h4>${escapeHtml(heading)}</h4>` : ''}
        <ul>${items.map((item) => `<li>${escapeHtml(item.body ?? '')}</li>`).join('')}</ul>
      </div>`;
      return `<section class="${toneClass.trim() || 'plain'}"><div class="wrap">
        ${head(section)}
        <div class="contrast">
          ${column(left, 'no', left[0]?.heading ?? 'What usually happens')}
          ${column(right, 'yes', right[0]?.heading ?? 'What we do instead')}
        </div>
      </div></section>`;
    }

    case 'statement':
      return `<section class="${toneClass.trim() || 'plain'}"><div class="wrap">
        ${section.kicker ? `<p class="kicker">${escapeHtml(section.kicker)}</p>` : ''}
        ${section.heading ? `<blockquote class="statement">${escapeHtml(section.heading)}</blockquote>` : ''}
        ${section.lede ? `<div class="lede" style="margin-top:26px">${paragraphs(section.lede)}</div>` : ''}
        ${actions(section)}
      </div></section>`;

    case 'faq':
      return `<section class="${toneClass.trim() || 'plain'}"><div class="wrap">
        ${head(section)}
        <div class="faq">${section.items.map((item) => `<details>
          <summary>${escapeHtml(item.heading ?? '')}</summary>
          ${paragraphs(item.body)}
        </details>`).join('')}</div>
      </div></section>`;

    case 'pricing':
      return `<section class="${toneClass.trim() || 'plain'}" id="pricing"><div class="wrap">
        ${head(section)}
        ${context.pricingHtml ?? '<p class="lede">No plans are available for self-service.</p>'}
      </div></section>`;

    case 'cta':
      return `<section class="${toneClass.trim() || 'plain'} centred"><div class="wrap">
        ${section.heading ? `<h2>${escapeHtml(section.heading)}</h2>` : ''}
        ${section.lede ? `<div class="lede centred-lede">${paragraphs(section.lede)}</div>` : ''}
        ${actions(section)}
      </div></section>`;

    case 'demo': {
      // An authored media URL is as untrusted as an authored link, so it goes
      // through the same check. A src that does not pass leaves the written
      // description standing on its own, which still says what the product does.
      const src = safeHref(section.mediaSrc);
      const poster = safeHref(section.mediaPoster);
      const described = section.mediaDescription
        ?? section.items.map((item) => item.body).filter(Boolean).join('\n\n');
      // The description sits in the figure's own caption rather than beside it.
      // Rendering it in both places printed it twice, and it belongs to the
      // video: a caption is what a screen reader reads in place of the frames.
      const caption = described
        ? `<figcaption>${paragraphs(described)}</figcaption>`
        : '';
      return `<section class="${toneClass.trim() || 'plain'}"><div class="wrap">
        ${head(section)}
        ${src
          ? `<figure class="demo">
        <video
          src="${escapeHtml(src)}"${poster ? ` poster="${escapeHtml(poster)}"` : ''}
          autoplay muted loop playsinline controls
          preload="${context.eagerMedia ? 'metadata' : 'none'}"
          aria-label="${escapeHtml(section.heading ?? 'Product demonstration')}"></video>
        ${caption}
      </figure>`
          : `<div class="prose demo-described">${paragraphs(described)}</div>`}
        ${actions(section)}
      </div></section>`;
    }

    case 'table': {
      const columns = section.columns ?? [];
      const rows = section.rows ?? [];
      if (columns.length === 0 && rows.length === 0) {
        return `<section class="${toneClass.trim() || 'plain'}"><div class="wrap">
          ${head(section)}</div></section>`;
      }
      const width = Math.max(columns.length, ...rows.map((row) => row.length), 1);
      const highlight = section.highlightColumn;
      const cell = (value: string, index: number, header: boolean): string => {
        const emphasis = highlight === index ? ' class="lead"' : '';
        return header
          ? `<th scope="col"${emphasis}>${escapeHtml(value)}</th>`
          // The first cell of a row names the row, so it is a header too. That
          // is what lets a screen reader say "Retail, Detent, three pounds"
          // instead of reading a wall of numbers with nothing attached.
          : index === 0
            ? `<th scope="row"${emphasis}>${escapeHtml(value)}</th>`
            : `<td${emphasis}>${escapeHtml(value)}</td>`;
      };
      const pad = (row: readonly string[]): string[] =>
        Array.from({ length: width }, (unused, index) => row[index] ?? '');

      return `<section class="${toneClass.trim() || 'plain'}"><div class="wrap">
        ${head(section)}
        <div class="table-scroll"><table class="compare">
          ${columns.length > 0
            ? `<thead><tr>${pad(columns).map((value, index) =>
                cell(value, index, true)).join('')}</tr></thead>` : ''}
          <tbody>${rows.map((row) =>
            `<tr>${pad(row).map((value, index) =>
              cell(value, index, false)).join('')}</tr>`).join('')}</tbody>
        </table></div>
        ${section.lede ? '' : ''}
        ${actions(section)}
      </div></section>`;
    }

    case 'prose':
    default:
      return `<section class="${toneClass.trim() || 'plain'}"><div class="wrap">
        ${head(section)}
        <div class="prose">${section.items.map((item) => paragraphs(item.body)).join('')}</div>
        ${actions(section)}
      </div></section>`;
  }
}

export function renderSections(page: Page, context: RenderContext = {}): string {
  // Only the first recording on a page is allowed to fetch before it is
  // wanted. A browser will not autoplay an offscreen video anyway, so the
  // later ones lose nothing by waiting, and the page stops spending its first
  // second of bandwidth on them.
  const firstDemo = page.sections.findIndex((section) => section.kind === 'demo');
  return page.sections
    .map((section, index) =>
      renderSection(section, { ...context, eagerMedia: index === firstDemo }))
    .join('\n');
}

/** A one-line summary of a section, for the console's page list. */
export function describeSection(section: Section): string {
  const labels: Record<Section['kind'], string> = {
    hero: 'Hero', features: 'Feature cards', contrast: 'Two-column contrast',
    statement: 'Statement', prose: 'Body copy', faq: 'Questions and answers',
    pricing: 'Pricing table', cta: 'Call to action', steps: 'Numbered steps',
    demo: 'Demonstration video', table: 'Comparison table',
  };
  const label = labels[section.kind];
  return section.heading ? `${label}, ${section.heading}` : label;
}
