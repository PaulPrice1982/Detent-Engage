import {
  SUPPORT_ARTICLES, TOPIC_LABELS, TOPIC_ORDER, articlesByTopic,
  type SupportAnswer, type SupportArticle, type SupportRequest,
} from '@detent/awa-support';
import { escape, page } from './site-html.js';
import type { AuthUser } from '@detent/awa-auth';

/**
 * The support area, inside the customer's account.
 *
 * Support is behind the sign-in rather than on the public site on purpose. A
 * customer asking why the assistant refused a question is telling us what is in
 * their knowledge; the question itself is theirs, and it belongs where the rest
 * of their account is.
 *
 * It is not gated on paying. A customer whose subscription has lapsed still
 * needs to read how to get it back, and putting the answer behind the thing
 * that is broken is a support policy that generates its own tickets.
 */

const NAV = (current: string) => [
  { href: '/app', label: 'Overview', current: current === 'overview' },
  { href: '/app/knowledge', label: 'Knowledge', current: current === 'knowledge' },
  { href: '/app/install', label: 'Install', current: current === 'install' },
  { href: '/app/api', label: 'API', current: current === 'api' },
  { href: '/app/status', label: 'Status', current: current === 'status' },
  { href: '/app/billing', label: 'Billing', current: current === 'billing' },
  { href: '/app/support', label: 'Support', current: current === 'support' },
];


/** Author copy: escaped, blank lines become paragraphs. */
function paragraphs(text: string): string {
  return text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
    .map((part) => `<p>${escape(part)}</p>`).join('');
}

function articleBody(article: SupportArticle): string {
  return `<div class="answer">
  ${paragraphs(article.answer)}
  ${article.steps && article.steps.length > 0
    ? `<ol class="steps">${article.steps.map((step) => `<li>${escape(step)}</li>`).join('')}</ol>`
    : ''}
  ${article.link
    ? `<div class="actions" style="margin-top:16px">
        <a class="btn primary" href="${escape(article.link.href)}">${escape(article.link.label)}</a>
       </div>`
    : ''}
</div>`;
}

export interface SupportHomeInput {
  readonly user: AuthUser;
  readonly asked?: string;
  readonly answer?: SupportAnswer;
  readonly requests: readonly SupportRequest[];
  readonly csrf: string;
  readonly notice?: string;
  /** The step-by-step setup recording, when one has been placed. */
  readonly setupVideo?: { readonly src: string; readonly poster?: string };
}

export function supportHomePage(input: SupportHomeInput): string {
  const answer = input.answer;

  const answerBlock = !answer ? '' : `<div class="card">
  <div class="said"><p>${escape(answer.message)}</p></div>
  ${answer.article ? `<h2 style="margin:0 0 10px">${escape(answer.article.question)}</h2>
    ${articleBody(answer.article)}` : ''}
  ${answer.outcome === 'ambiguous' ? `<div class="more">
    ${answer.matches.map((match) =>
      `<a href="/app/support/${escape(match.article.slug)}">${escape(match.article.question)}</a>`).join('')}
  </div>` : ''}
  ${answer.outcome === 'answered' && answer.matches.length > 1 ? `<div class="more"
    style="margin-top:18px;border-top:1px solid #EEF2F6;padding-top:14px">
    <span class="sub">Related:</span><br>
    ${answer.matches.slice(1).map((match) =>
      `<a href="/app/support/${escape(match.article.slug)}">${escape(match.article.question)}</a>`).join('')}
  </div>` : ''}
  ${answer.offerHuman ? `<p class="sub" style="margin:16px 0 0">
    Not what you needed? <a href="/app/support/request${input.asked
      ? `?about=${encodeURIComponent(input.asked)}` : ''}">Ask a person</a>.</p>` : ''}
</div>`;

  return page(
    {
      title: 'Support', site: 'app', nav: NAV('support'), user: input.user.email,
      banner: input.notice,
    },
    `<h1>Support</h1>
<p class="sub">Ask a question in your own words. Everything here is about running
Detent: it is not the assistant your visitors talk to.</p>

<div class="card">
  <form class="ask" method="get" action="/app/support">
    <input name="q" value="${escape(input.asked ?? '')}" autocomplete="off"
           placeholder="How do I put our logo on the assistant?" aria-label="Ask a question">
    <button class="btn primary" type="submit">Ask</button>
  </form>
  <p class="sub" style="margin:0">It answers from these articles only. Where there is
  no answer it says so rather than guessing, and offers you a person.</p>
</div>

${answerBlock}

${input.setupVideo ? `<div class="card">
  <h2 style="margin:0 0 4px">Setting up, step by step</h2>
  <p class="sub" style="margin:0 0 14px">The whole thing, start to finish, recorded in
  the product. Roughly the length of a coffee.</p>
  <video class="demo-video" src="${escape(input.setupVideo.src)}"${
    input.setupVideo.poster ? ` poster="${escape(input.setupVideo.poster)}"` : ''}
    controls preload="metadata" aria-label="Setting up Detent, step by step"></video>
  <p class="sub" style="margin:12px 0 0">Prefer to read it?
  <a href="/app/support/add-the-assistant-to-my-website">The same steps in writing</a>.</p>
</div>` : ''}

${TOPIC_ORDER.map((topic) => {
    const articles = articlesByTopic(topic);
    if (articles.length === 0) return '';
    return `<div class="topic">
  <h3>${escape(TOPIC_LABELS[topic])}</h3>
  <div class="qa">
    ${articles.map((article) => `<a href="/app/support/${escape(article.slug)}">
      ${escape(article.question)}
      <span class="tag">${article.kind === 'how-to' ? 'How to' : 'FAQ'}</span></a>`).join('')}
  </div>
</div>`;
  }).join('')}

<div class="card">
  <h2 style="margin:0 0 4px">Your requests</h2>
  ${input.requests.length === 0
    ? `<p class="sub" style="margin:0 0 14px">You have not raised any.</p>`
    : input.requests.map((request) => `<div class="req">
        <b>${escape(request.subject)}</b>
        <span class="tag">${escape(request.state)}</span>
        <div class="when">Raised ${escape(request.createdAt.slice(0, 10))}</div>
        ${request.answer ? `<p style="margin:10px 0 0">${escape(request.answer)}</p>` : ''}
      </div>`).join('')}
  <div class="actions"><a class="btn" href="/app/support/request">Raise a request</a></div>
</div>`,
  );
}

export function supportArticlePage(input: {
  readonly user: AuthUser;
  readonly article: SupportArticle;
  readonly related: readonly SupportArticle[];
}): string {
  return page(
    { title: input.article.question, site: 'app', nav: NAV('support'), user: input.user.email },
    `<p class="sub"><a href="/app/support">Support</a> , 
${escape(TOPIC_LABELS[input.article.topic])}</p>
<h1>${escape(input.article.question)}</h1>
<div class="card">${articleBody(input.article)}</div>
${input.related.length > 0 ? `<div class="topic">
  <h3>Related</h3>
  <div class="qa">${input.related.map((article) =>
    `<a href="/app/support/${escape(article.slug)}">${escape(article.question)}</a>`).join('')}</div>
</div>` : ''}
<p class="sub">Still stuck? <a href="/app/support/request?about=${
  encodeURIComponent(input.article.question)}">Ask a person</a>.</p>`,
  );
}

export function supportRequestPage(input: {
  readonly user: AuthUser;
  readonly csrf: string;
  readonly about?: string;
  readonly error?: string;
}): string {
  return page(
    { title: 'Raise a request', site: 'app', nav: NAV('support'), user: input.user.email },
    `<p class="sub"><a href="/app/support">Support</a></p>
<h1>Raise a request</h1>
<div class="card">
  ${input.error ? `<div class="said" style="border-left-color:#C2413B">
    <p>${escape(input.error)}</p></div>` : ''}
  <form method="post" action="/app/support/request">
    <input type="hidden" name="csrf" value="${escape(input.csrf)}">
    ${input.about ? `<input type="hidden" name="askedFirst" value="${escape(input.about)}">` : ''}
    <label for="subject">What is it about?</label>
    <input class="field" id="subject" name="subject" required
           value="${escape(input.about ?? '')}">
    <label for="detail">What happened?</label>
    <textarea class="field" id="detail" name="detail" rows="7" required
      placeholder="What you were doing, what you expected, and what happened instead."></textarea>
    <p class="sub">Include the page address if it is about your website. Do not paste
    passwords or API keys, we never need them, and we cannot un-see them.</p>
    <div class="actions"><button class="btn primary" type="submit">Send it</button>
      <a class="btn" href="/app/support">Cancel</a></div>
  </form>
</div>`,
  );
}

/** Articles sharing a topic, excluding the one being read. */
export function relatedArticles(article: SupportArticle, limit = 4): readonly SupportArticle[] {
  return SUPPORT_ARTICLES
    .filter((other) => other.topic === article.topic && other.slug !== article.slug)
    .slice(0, limit);
}
