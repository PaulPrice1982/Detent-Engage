import { describe, expect, it } from 'vitest';
import { newSection, renderSection, type Section } from '@detent/awa-cms';

/**
 * Comparison tables.
 *
 * A table on a marketing page is read by three audiences the author never
 * sees: somebody on a phone, somebody using a screen reader, and a search
 * engine. Each of these tests is one of them.
 */

const table = (over: Partial<Section> = {}): Section => ({
  ...newSection('table', 'light'),
  heading: 'What a reply replaces',
  columns: ['Industry', 'What they ask', 'A person', 'Detent'],
  rows: [
    ['Retail', 'Is this in a 12?', '£2 to £4', '50p'],
    ['Clinics', 'Do you take my insurance?', '£7 to £12', '50p'],
  ],
  highlightColumn: 3,
  ...over,
});

describe('a comparison table', () => {
  it('marks the header row and the row labels as headers', () => {
    // Without scope, a screen reader reads a wall of numbers with nothing
    // attached to them. With it, the row is "Retail, Detent, 50p".
    const html = renderSection(table());
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    expect(html.match(/scope="row"/g)).toHaveLength(2);
  });

  it('emphasises the column the section is arguing for', () => {
    expect(renderSection(table())).toMatch(/class="lead">Detent/);
  });

  it('scrolls inside its own box rather than widening the page', () => {
    // A table that widens the page makes every other section scroll sideways
    // too, on the device most people read on.
    expect(renderSection(table())).toContain('table-scroll');
  });

  it('escapes author text rather than trusting it', () => {
    const hostile = table({ rows: [['<script>alert(1)</script>', 'x', 'y', 'z']] });
    const html = renderSection(hostile);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('pads a short row rather than refusing it', () => {
    // A half-finished table should render, not 500. An author editing a table
    // in a textarea will save a short row, and finding out by way of a broken
    // page is a poor way to be told.
    const html = renderSection(table({ rows: [['Retail', 'Only two cells']] }));
    expect(html).toContain('Only two cells');
    // Four headings, so four cells in the row: two written, two empty.
    const cells = html.match(/<t[hd][^>]*>/g) ?? [];
    expect(cells.length).toBeGreaterThanOrEqual(8);
  });

  it('renders nothing but its heading when it has no rows yet', () => {
    const empty = renderSection(table({ columns: [], rows: [] }));
    expect(empty).toContain('What a reply replaces');
    expect(empty).not.toContain('<table');
  });
});
