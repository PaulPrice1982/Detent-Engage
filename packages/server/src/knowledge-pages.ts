import type {
  DraftKnowledge, KnowledgeSummary, UploadedDocument,
} from '@detent/awa-ingestion';
import { escape, page, pill, statCard } from './site-html.js';

/**
 * The knowledge area of the customer app.
 *
 * Three things on one screen, in the order a customer needs them:
 *
 *  1. **Anything quarantined**, first and unmissable. A document containing
 *     text aimed at an AI system is the thing they most need to see, and the
 *     least likely to be noticed at the bottom of a list.
 *  2. **The review queue**, what the agent proposed and nobody has approved.
 *     Until it is approved the assistant will not say it, which is stated on
 *     the page so nobody assumes an upload was enough.
 *  3. **Published knowledge**, and a form to write more by hand.
 */

const NAV = (current: string) => [
  { href: '/app', label: 'Overview', current: current === 'overview' },
  { href: '/app/knowledge', label: 'Knowledge', current: current === 'knowledge' },
  { href: '/app/install', label: 'Install' },
  { href: '/app/billing', label: 'Billing' },
];

const STATE_TONE: Readonly<Record<string, 'ok' | 'warn' | 'bad' | 'neutral'>> = {
  uploaded: 'neutral', extracting: 'neutral', extracted: 'neutral',
  processed: 'ok', failed: 'bad', removed: 'neutral',
};

export interface KnowledgePageInput {
  readonly userEmail: string;
  readonly csrf: string;
  readonly documents: readonly UploadedDocument[];
  readonly queue: readonly DraftKnowledge[];
  readonly published: readonly DraftKnowledge[];
  readonly summary: KnowledgeSummary;
  readonly notice?: string;
  readonly error?: string;
}

export function knowledgePage(input: KnowledgePageInput): string {
  const quarantined = input.queue.filter((draft) => draft.state === 'quarantined');
  const proposed = input.queue.filter((draft) => draft.state === 'proposed');

  return page(
    { title: 'Knowledge', site: 'app', nav: NAV('knowledge'), user: input.userEmail },
    `<h1>Detent Knowledge</h1>
<p class="sub">Upload your product and service documentation. The knowledge agent reads it and
proposes articles and FAQs. <strong>Nothing the agent proposes is used until you approve it</strong> , 
the assistant states these to buyers as fact about your business, so the decision is yours.</p>

${input.error ? `<div class="banner bad">${escape(input.error)}</div>` : ''}
${input.notice ? `<div class="banner">${escape(input.notice)}</div>` : ''}

<div class="grid">
  ${statCard('Published', String(input.summary.published), 'The assistant can use these')}
  ${statCard('Awaiting your review', String(input.summary.awaitingReview), 'Not yet usable')}
  ${statCard('Quarantined', String(input.summary.quarantined),
    input.summary.quarantined > 0 ? 'Needs your attention' : 'None')}
  ${statCard('Documents', String(input.documents.filter((d) => d.state !== 'removed').length), 'Uploaded')}
</div>

${quarantined.length > 0 ? `<h2 style="color:#A32A2A">Quarantined, read these first</h2>
<div class="card" style="border-color:#F3C9C9;background:#FFF8F8">
  <p class="sub" style="margin:0 0 12px">These passages contain text shaped like an instruction to
  an AI system. The knowledge agent did not read them. This is usually harmless: a template, a
  prompt someone pasted into a draft, but it can also be deliberate, and it is your document, so
  you should see it.</p>
  ${quarantined.map((draft) => `<div class="item">
    <div class="meta">${escape(draft.citation.filename)} &middot; ${escape(draft.citation.locator)}</div>
    <pre class="excerpt">${escape(draft.body)}</pre>
    <form method="post" action="/app/knowledge/reject" style="display:inline">
      <input type="hidden" name="csrf" value="${escape(input.csrf)}">
      <input type="hidden" name="draftId" value="${escape(draft.draftId)}">
      <input type="hidden" name="reason" value="Quarantined passage discarded by the customer.">
      <button class="btn danger" type="submit">Discard</button>
    </form>
  </div>`).join('')}
</div>` : ''}

<h2>Upload documentation</h2>
<form class="card" method="post" action="/app/knowledge/upload" enctype="multipart/form-data">
  <input type="hidden" name="csrf" value="${escape(input.csrf)}">
  <label for="file">Document</label>
  <input class="field" id="file" name="file" type="file" required
         accept=".pdf,.docx,.doc,.html,.htm,.md,.markdown,.txt,.csv">
  <p class="hint">PDF, Word, HTML, Markdown, CSV or text. Up to 20MB.
  A scanned PDF needs OCR before it can be read.</p>
  <label for="description">What is this? (optional)</label>
  <input class="field" id="description" name="description"
         placeholder="e.g. 2026 product handbook, pricing appendix">
  <div class="actions"><button class="btn primary" type="submit">Upload and read</button></div>
</form>

${input.documents.filter((d) => d.state !== 'removed').length > 0 ? `<h2>Your documents</h2>
<table><thead><tr><th>File</th><th>State</th><th class="num">Proposed</th><th>Uploaded</th><th></th></tr></thead>
<tbody>${input.documents.filter((d) => d.state !== 'removed').map((document) => `<tr>
  <td><b>${escape(document.filename)}</b>
    ${document.description ? `<div class="meta">${escape(document.description)}</div>` : ''}
    ${document.failureReason ? `<div class="meta" style="color:#A32A2A">${escape(document.failureReason)}</div>` : ''}</td>
  <td>${pill(document.state, STATE_TONE[document.state] ?? 'neutral')}</td>
  <td class="num">${escape(String(document.proposedCount ?? 0))}</td>
  <td>${escape(document.uploadedAt.slice(0, 10))}</td>
  <td><form method="post" action="/app/knowledge/remove">
    <input type="hidden" name="csrf" value="${escape(input.csrf)}">
    <input type="hidden" name="documentId" value="${escape(document.documentId)}">
    <button class="btn" type="submit">Remove</button></form></td>
</tr>`).join('')}</tbody></table>` : ''}

<h2>Awaiting your review${proposed.length > 0 ? ` (${proposed.length})` : ''}</h2>
${proposed.length === 0
  ? '<div class="empty">Nothing waiting. Upload a document to have the agent read it.</div>'
  : proposed.map((draft) => reviewCard(draft, input.csrf)).join('')}

<h2>Add knowledge yourself</h2>
<form class="card" method="post" action="/app/knowledge/manual">
  <input type="hidden" name="csrf" value="${escape(input.csrf)}">
  <p class="sub" style="margin:0 0 12px">Written by you, so it is published straight away.
  You are the one asserting it.</p>
  <label for="kind">Type</label>
  <select class="field" id="kind" name="kind">
    <option value="faq">FAQ, a question buyers ask</option>
    <option value="article">Article, a statement about your product</option>
    <option value="definition">Definition, a term you use</option>
    <option value="caveat">Caveat, a limitation or exclusion</option>
  </select>
  <label for="question">Question (for an FAQ)</label>
  <input class="field" id="question" name="question" placeholder="Do you integrate with Salesforce?">
  <label for="title">Title</label>
  <input class="field" id="title" name="title" required placeholder="Salesforce integration">
  <label for="body">Answer or content</label>
  <textarea class="field" id="body" name="body" rows="5" required></textarea>
  <div class="actions"><button class="btn primary" type="submit">Publish</button></div>
</form>

${input.published.length > 0 ? `<h2>Published (${input.published.length})</h2>
<table><thead><tr><th>Type</th><th>Title</th><th>Source</th><th>Approved by</th></tr></thead>
<tbody>${input.published.map((draft) => `<tr>
  <td>${pill(draft.kind)}</td>
  <td>${escape(draft.question ?? draft.title)}</td>
  <td>${escape(draft.citation.filename)}${
    draft.citation.locator && draft.citation.documentId !== 'manual'
      ? ` <span class="meta">${escape(draft.citation.locator)}</span>` : ''}</td>
  <td>${escape(draft.reviewedBy ?? '')}</td>
</tr>`).join('')}</tbody></table>` : ''}

<style>
  .field { width:100%; padding:9px 11px; font-size:14px; border:1px solid #E3E8EF;
           border-radius:7px; font-family:inherit; color:#0F1B2A; background:#fff;
           margin-bottom:12px; }
  .field:focus { outline:2px solid #1B5FA8; outline-offset:1px; }
  textarea.field { resize:vertical; line-height:1.5; }
  label { display:block; font-size:11.5px; font-weight:600; color:#5B6B7F;
          margin:0 0 4px; text-transform:uppercase; letter-spacing:.05em; }
  .hint { color:#5B6B7F; font-size:12.5px; margin:-6px 0 14px; }
  .meta { color:#5B6B7F; font-size:12px; }
  .item { padding:14px 0; border-bottom:1px solid #E3E8EF; }
  .item:last-child { border-bottom:0; padding-bottom:0; }
  .excerpt { background:#F7F9FC; border:1px solid #E3E8EF; border-radius:7px;
             padding:11px 13px; font-size:12.5px; white-space:pre-wrap;
             font-family:ui-monospace,SFMono-Regular,Menlo,monospace; margin:9px 0;
             max-height:160px; overflow:auto; }
  .banner.bad { background:#FCEBEB; border-color:#F3C9C9; color:#A32A2A; }
  .figure { display:inline-flex; align-items:center; gap:6px; margin:0 10px 8px 0;
            font-size:13px; background:#FDF3E5; border:1px solid #F3DDBB;
            border-radius:6px; padding:5px 9px; }
</style>`,
  );
}

/**
 * One proposed item, with its source alongside.
 *
 * The excerpt sits next to the proposal so a reviewer can judge the claim
 * without opening the original file. A review that requires opening a PDF is a
 * review that stops happening by the fourth item.
 */
function reviewCard(draft: DraftKnowledge, csrf: string): string {
  const id = escape(draft.draftId);
  return `<div class="card">
  <div style="display:flex;gap:10px;align-items:baseline;margin-bottom:8px">
    ${pill(draft.kind)}
    <span class="meta">${escape(draft.citation.filename)} &middot; ${escape(draft.citation.locator)}</span>
  </div>
  <form method="post" action="/app/knowledge/approve">
    <input type="hidden" name="csrf" value="${escape(csrf)}">
    <input type="hidden" name="draftId" value="${id}">
    ${draft.question !== undefined ? `
    <label for="q_${id}">Question</label>
    <input class="field" id="q_${id}" name="editedQuestion" value="${escape(draft.question)}">` : ''}
    <label for="t_${id}">Title</label>
    <input class="field" id="t_${id}" name="editedTitle" value="${escape(draft.title)}">
    <label for="b_${id}">Answer</label>
    <textarea class="field" id="b_${id}" name="editedBody" rows="4">${escape(draft.body)}</textarea>

    ${draft.figures.length > 0 ? `
    <label>Confirm each figure</label>
    <p class="hint">The assistant will state these to buyers as fact. Tick only what is correct
    and current; anything unticked blocks approval.</p>
    <div style="margin-bottom:12px">
      ${draft.figures.map((figure, index) => `<label class="figure">
        <input type="checkbox" name="figure_${index}" value="${escape(figure)}">
        <span>${escape(figure)}</span></label>`).join('')}
    </div>` : ''}

    <details style="margin-bottom:12px">
      <summary class="meta" style="cursor:pointer">Show the source passage</summary>
      <pre class="excerpt">${escape(draft.citation.excerpt)}</pre>
    </details>

    <div class="actions">
      <button class="btn primary" type="submit">Approve and publish</button>
    </div>
  </form>
  <form method="post" action="/app/knowledge/reject" style="margin-top:8px">
    <input type="hidden" name="csrf" value="${escape(csrf)}">
    <input type="hidden" name="draftId" value="${id}">
    <input class="field" name="reason" placeholder="Why is this wrong? (required)" style="margin-bottom:8px">
    <button class="btn danger" type="submit">Reject</button>
  </form>
</div>`;
}

export { NAV as knowledgeNav };
