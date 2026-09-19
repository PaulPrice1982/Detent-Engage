import { describeSection, type Page, type Section, type SectionKind } from '@detent/awa-cms';
import { escape, page as shell, pill } from './site-html.js';

/**
 * Managing the marketing site from the back office.
 *
 * The editor is a list of sections with a form each, not a canvas. A canvas
 * invites an author to position things, and positioning is where a marketing
 * site stops matching its brand. Order and content are theirs; layout is not.
 */

const NAV = (current: string) => [
  { href: '/console', label: 'Accounts' },
  { href: '/console/new', label: 'New account' },
  { href: '/console/pricing', label: 'Pricing' },
  { href: '/console/website', label: 'Website', current: current === 'website' },
  { href: '/console/approvals', label: 'Approvals' },
];

const SECTION_KINDS: readonly { kind: SectionKind; label: string; use: string }[] = [
  { kind: 'hero', label: 'Hero', use: 'The opening claim. One per page, at the top.' },
  { kind: 'features', label: 'Feature cards', use: 'Two to four points, side by side.' },
  { kind: 'contrast', label: 'Two-column contrast', use: 'What usually happens, versus what we do.' },
  { kind: 'statement', label: 'Statement', use: 'One large claim, set apart.' },
  { kind: 'steps', label: 'Numbered steps', use: 'A process, in order.' },
  { kind: 'faq', label: 'Questions and answers', use: 'What buyers actually ask.' },
  { kind: 'prose', label: 'Body copy', use: 'Paragraphs. For longer explanations.' },
  { kind: 'pricing', label: 'Pricing table', use: 'Drawn live from the plan catalogue.' },
  { kind: 'cta', label: 'Call to action', use: 'A closing ask, centred.' },
  { kind: 'demo', label: 'Demonstration video', use: 'A recording of the product, with a written description.' },
  { kind: 'table', label: 'Comparison table', use: 'Rows and columns. One line per row.' },
];

const STATE_TONE: Readonly<Record<Page['state'], 'ok' | 'warn' | 'neutral'>> = {
  published: 'ok', draft: 'warn', archived: 'neutral',
};

export function websiteListPage(input: {
  readonly userEmail: string;
  readonly csrf: string;
  readonly pages: readonly Page[];
  readonly notice?: string;
  readonly error?: string;
}): string {
  return shell(
    { title: 'Website', site: 'console', nav: NAV('website'), user: input.userEmail },
    `<h1>Website</h1>
<p class="sub">The public marketing site. Pages are built from sections; you choose which
sections and in what order. Typography, spacing and colour are the brand and are not
editable, which is what stops a page added in a hurry from looking like it was.</p>

${input.error ? `<div class="banner bad">${escape(input.error)}</div>` : ''}
${input.notice ? `<div class="banner">${escape(input.notice)}</div>` : ''}

${input.pages.length === 0
  ? '<div class="empty">No pages yet.</div>'
  : `<table><thead><tr><th>Page</th><th>Address</th><th>State</th>
<th class="num">Sections</th><th>Updated</th><th></th></tr></thead>
<tbody>${input.pages.map((page) => `<tr>
  <td><a class="link" href="/console/website/${escape(page.pageId)}"><b>${escape(page.title)}</b></a>
    ${page.navLabel ? `<div class="meta">In the menu as "${escape(page.navLabel)}"</div>` : ''}</td>
  <td><code>/${escape(page.slug)}</code></td>
  <td>${pill(page.state, STATE_TONE[page.state])}${
    page.state === 'draft' && page.publishedSnapshot
      ? ` <span class="meta">live version still serving</span>` : ''}</td>
  <td class="num">${page.sections.length}</td>
  <td>${escape(page.updatedAt.slice(0, 10))}</td>
  <td><a class="btn" href="/console/website/${escape(page.pageId)}/preview">Preview</a></td>
</tr>`).join('')}</tbody></table>`}

<h2>Add a page</h2>
<form class="card" method="post" action="/console/website/new">
  <input type="hidden" name="csrf" value="${escape(input.csrf)}">
  <div class="grid">
    <div><label for="title">Title</label>
      <input class="field" id="title" name="title" required placeholder="How it works"></div>
    <div><label for="slug">Address</label>
      <input class="field" id="slug" name="slug" required placeholder="how-it-works">
      <p class="hint">Leave as <code>home</code> for the front page.</p></div>
    <div><label for="navLabel">Menu label (optional)</label>
      <input class="field" id="navLabel" name="navLabel" placeholder="How it works"></div>
    <div><label for="navOrder">Menu order</label>
      <input class="field" id="navOrder" name="navOrder" type="number" min="0" value="10"></div>
  </div>
  <label for="description">Search description</label>
  <input class="field" id="description" name="description" required
         placeholder="What a buyer reads under the title in a search result.">
  <div class="actions"><button class="btn primary" type="submit">Create as a draft</button></div>
</form>
${FIELD_STYLES}`,
  );
}

export function pageEditorPage(input: {
  readonly userEmail: string;
  readonly csrf: string;
  readonly page: Page;
  readonly notice?: string;
  readonly error?: string;
}): string {
  const { page } = input;
  const id = escape(page.pageId);

  return shell(
    { title: page.title, site: 'console', nav: NAV('website'), user: input.userEmail },
    `<h1>${escape(page.title)}</h1>
<p class="sub"><code>/${escape(page.slug)}</code> &middot; ${pill(page.state, STATE_TONE[page.state])}
${page.state === 'draft' && page.publishedSnapshot
  ? ' &middot; visitors still see the last published version'
  : page.state === 'draft' ? ' &middot; not visible to anyone yet' : ''}</p>

${input.error ? `<div class="banner bad">${escape(input.error)}</div>` : ''}
${input.notice ? `<div class="banner">${escape(input.notice)}</div>` : ''}

<div class="actions" style="margin-bottom:22px">
  <a class="btn" href="/console/website/${id}/preview" target="_blank" rel="noopener">Preview</a>
  <form method="post" action="/console/website/${id}/publish" style="display:inline">
    <input type="hidden" name="csrf" value="${escape(input.csrf)}">
    <button class="btn primary" type="submit">Publish</button></form>
  ${page.state !== 'archived' ? `<form method="post" action="/console/website/${id}/archive" style="display:inline">
    <input type="hidden" name="csrf" value="${escape(input.csrf)}">
    <button class="btn" type="submit">Take off the site</button></form>` : ''}
  <a class="btn" href="/console/website">All pages</a>
</div>

<h2>Page details</h2>
<form class="card" method="post" action="/console/website/${id}/details">
  <input type="hidden" name="csrf" value="${escape(input.csrf)}">
  <div class="grid">
    <div><label for="title">Title</label>
      <input class="field" id="title" name="title" value="${escape(page.title)}"></div>
    <div><label for="navLabel">Menu label</label>
      <input class="field" id="navLabel" name="navLabel" value="${escape(page.navLabel ?? '')}"></div>
  </div>
  <label for="description">Search description</label>
  <input class="field" id="description" name="description" value="${escape(page.description)}">
  <div class="actions"><button class="btn" type="submit">Save details</button></div>
</form>

<h2>Sections (${page.sections.length})</h2>
${page.sections.length === 0
  ? '<div class="empty">This page is blank. Add a section below.</div>'
  : page.sections.map((section, index) =>
      sectionEditor(section, index, page.sections.length, page.pageId, input.csrf)).join('')}

<h2>Add a section</h2>
<div class="card">
  <p class="sub" style="margin:0 0 12px">Each one renders in the brand automatically.</p>
  <div class="kinds">
    ${SECTION_KINDS.map((option) => `<form method="post" action="/console/website/${id}/section">
      <input type="hidden" name="csrf" value="${escape(input.csrf)}">
      <input type="hidden" name="kind" value="${escape(option.kind)}">
      <button class="kind" type="submit">
        <b>${escape(option.label)}</b><span>${escape(option.use)}</span></button>
    </form>`).join('')}
  </div>
</div>
${FIELD_STYLES}
<style>
  .kinds{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(230px,1fr))}
  .kind{width:100%;text-align:left;padding:13px 15px;border:1px solid #E3E8EF;border-radius:9px;
        background:#fff;cursor:pointer;font-family:inherit;color:#0F1B2A}
  .kind:hover{border-color:#EFA13C;background:#FFFDF9}
  .kind b{display:block;font-size:14.5px;margin-bottom:3px}
  .kind span{color:#5B6B7F;font-size:12.5px;line-height:1.45}
  .section-head{display:flex;align-items:baseline;gap:10px;margin-bottom:12px}
  .section-head .order{display:flex;gap:5px;margin-left:auto}
  .section-head .order button{border:1px solid #E3E8EF;background:#fff;border-radius:6px;
        width:30px;height:28px;cursor:pointer;color:#5B6B7F}
  .section-head .order button:hover{border-color:#5B6B7F;color:#0F1B2A}
  .items{border-left:2px solid #E3E8EF;padding-left:15px;margin:14px 0}
</style>`,
  );
}

function sectionEditor(
  section: Section, index: number, total: number, pageId: string, csrf: string,
): string {
  const id = escape(section.sectionId);
  const action = `/console/website/${escape(pageId)}/section/${id}`;
  const usesItems = ['features', 'contrast', 'faq', 'steps', 'prose'].includes(section.kind);
  const usesActions = ['hero', 'cta', 'statement', 'features', 'steps', 'prose', 'demo']
    .includes(section.kind);
  const usesMedia = section.kind === 'demo';
  const usesTable = section.kind === 'table';

  return `<form class="card" method="post" action="${action}">
  <input type="hidden" name="csrf" value="${escape(csrf)}">
  <div class="section-head">
    ${pill(describeSection(section))}
    <span class="meta">${index + 1} of ${total}</span>
    <span class="order">
      ${index > 0 ? `<button type="submit" name="move" value="up" title="Move up">&uarr;</button>` : ''}
      ${index < total - 1 ? `<button type="submit" name="move" value="down" title="Move down">&darr;</button>` : ''}
      <button type="submit" name="remove" value="yes" title="Remove this section">&times;</button>
    </span>
  </div>

  <div class="grid">
    <div><label for="k_${id}">Kicker</label>
      <input class="field" id="k_${id}" name="kicker" value="${escape(section.kicker ?? '')}"
             placeholder="Small label above the heading"></div>
    <div><label for="tone_${id}">Background</label>
      <select class="field" id="tone_${id}" name="tone">
        <option value="light"${section.tone === 'light' ? ' selected' : ''}>White</option>
        <option value="tint"${section.tone === 'tint' ? ' selected' : ''}>Pale grey</option>
        <option value="ink"${section.tone === 'ink' ? ' selected' : ''}>Detent ink (dark)</option>
      </select></div>
  </div>
  <label for="h_${id}">${section.kind === 'statement' ? 'The statement' : 'Heading'}</label>
  <input class="field" id="h_${id}" name="heading" value="${escape(section.heading ?? '')}">
  <label for="l_${id}">Standfirst</label>
  <textarea class="field" id="l_${id}" name="lede" rows="2">${escape(section.lede ?? '')}</textarea>

  ${usesItems ? `<div class="items">
    ${section.items.map((item, itemIndex) => `
      <label for="ih_${id}_${itemIndex}">${section.kind === 'faq' ? 'Question' : 'Item heading'} ${itemIndex + 1}</label>
      <input class="field" id="ih_${id}_${itemIndex}" name="itemHeading_${itemIndex}"
             value="${escape(item.heading ?? '')}">
      <label for="ib_${id}_${itemIndex}">${section.kind === 'faq' ? 'Answer' : 'Item text'}</label>
      <textarea class="field" id="ib_${id}_${itemIndex}" name="itemBody_${itemIndex}"
                rows="2">${escape(item.body ?? '')}</textarea>
      ${section.kind === 'contrast' ? `<label for="ic_${id}_${itemIndex}">Column</label>
      <select class="field" id="ic_${id}_${itemIndex}" name="itemColumn_${itemIndex}">
        <option value="left"${item.column !== 'right' ? ' selected' : ''}>Left, what usually happens</option>
        <option value="right"${item.column === 'right' ? ' selected' : ''}>Right, what we do</option>
      </select>` : ''}`).join('<hr style="border:0;border-top:1px solid #E3E8EF;margin:14px 0">')}
    <div class="actions" style="margin-top:10px">
      <button class="btn" type="submit" name="addItem" value="yes">Add another item</button>
      ${section.items.length > 1
        ? '<button class="btn" type="submit" name="removeItem" value="yes">Remove the last item</button>' : ''}
    </div>
  </div>` : ''}

  ${usesTable ? `<label for="cols_${id}">Column headings</label>
  <input class="field" id="cols_${id}" name="columns"
         value="${escape((section.columns ?? []).join(' | '))}"
         placeholder="Industry | What they ask | A person costs | Detent costs">
  <label for="rows_${id}">Rows</label>
  <textarea class="field" id="rows_${id}" name="rows" rows="10"
    placeholder="Retail | Is this in stock in a 12? | £2 to £4 a chat | 50p a reply">${
      escape((section.rows ?? []).map((row) => row.join(' | ')).join('\n'))}</textarea>
  <p class="hint">One line per row. Separate the cells with a vertical bar. A row with fewer
  cells than there are headings is padded rather than refused, so a half-finished table still
  renders.</p>
  <label for="hl_${id}">Column to emphasise</label>
  <input class="field" id="hl_${id}" name="highlightColumn" type="number" min="0"
         value="${section.highlightColumn ?? ''}" placeholder="blank = none; 0 is the first">
  <p class="hint">The column the section is arguing for. Usually the one with your price in
  it.</p>` : ''}

  ${usesMedia ? `<div class="grid">
    <div><label for="mv_${id}">Video file</label>
      <input class="field" id="mv_${id}" name="mediaSrc"
             value="${escape(section.mediaSrc ?? '')}" placeholder="/media/demo-name.webm"></div>
    <div><label for="mp_${id}">Still image shown before it plays</label>
      <input class="field" id="mp_${id}" name="mediaPoster"
             value="${escape(section.mediaPoster ?? '')}" placeholder="/media/demo-name.jpg"></div>
  </div>
  <label for="md_${id}">What the recording shows</label>
  <textarea class="field" id="md_${id}" name="mediaDescription" rows="3"
            placeholder="Describe it in words.">${escape(section.mediaDescription ?? '')}</textarea>
  <p class="hint">This description is shown beside the video and read instead of it by a
     screen reader, a search engine, and anyone whose connection will not carry the file.
     A video with nothing written beside it is invisible to all three.</p>` : ''}

  ${usesActions ? `<div class="grid">
    <div><label for="pa_${id}">Button text</label>
      <input class="field" id="pa_${id}" name="primaryActionLabel"
             value="${escape(section.primaryActionLabel ?? '')}"></div>
    <div><label for="ph_${id}">Button link</label>
      <input class="field" id="ph_${id}" name="primaryActionHref"
             value="${escape(section.primaryActionHref ?? '')}" placeholder="/pricing or https://…"></div>
    <div><label for="sa_${id}">Second button text</label>
      <input class="field" id="sa_${id}" name="secondaryActionLabel"
             value="${escape(section.secondaryActionLabel ?? '')}"></div>
    <div><label for="sh_${id}">Second button link</label>
      <input class="field" id="sh_${id}" name="secondaryActionHref"
             value="${escape(section.secondaryActionHref ?? '')}"></div>
  </div>` : ''}

  <div class="actions"><button class="btn primary" type="submit">Save this section</button></div>
</form>`;
}

const FIELD_STYLES = `<style>
  .field{width:100%;padding:9px 11px;font-size:14px;border:1px solid #E3E8EF;border-radius:7px;
         font-family:inherit;color:#0F1B2A;background:#fff;margin-bottom:12px}
  .field:focus{outline:2px solid #1B5FA8;outline-offset:1px}
  textarea.field{resize:vertical;line-height:1.5}
  label{display:block;font-size:11.5px;font-weight:600;color:#5B6B7F;margin:0 0 4px;
        text-transform:uppercase;letter-spacing:.05em}
  .hint{color:#5B6B7F;font-size:12.5px;margin:-8px 0 12px}
  .meta{color:#5B6B7F;font-size:12px}
  .banner.bad{background:#FCEBEB;border-color:#F3C9C9;color:#A32A2A}
  code{background:#F7F9FC;border:1px solid #E3E8EF;border-radius:4px;padding:1px 5px}
</style>`;

export { SECTION_KINDS, NAV as websiteNav };
