/**
 * Detent's own support knowledge: the answers a customer needs about running
 * the assistant, rather than the answers their assistant gives their visitors.
 *
 * These are shipped with the product and are the same for every customer, so
 * they live in source rather than in a tenant's corpus. Keeping them separate
 * is deliberate: a customer's knowledge and Detent's support knowledge must
 * never be retrieved by the same query. A visitor asking a customer's assistant
 * about pricing must not receive an answer about Detent's billing, and a
 * customer asking about their invoice must not receive their own marketing copy.
 *
 * Every article answers one question. An article that answers three is found by
 * none of them, because the words that would have matched are diluted by the
 * two the reader did not ask.
 */

export type ArticleKind =
  /** A question a customer asks. Answered in prose. */
  | 'faq'
  /** A task a customer performs. Answered in ordered steps. */
  | 'how-to';

export type ArticleTopic =
  | 'getting-started'
  | 'knowledge'
  | 'branding'
  | 'behaviour'
  | 'account'
  | 'technical'
  | 'troubleshooting';

export interface SupportArticle {
  readonly slug: string;
  readonly topic: ArticleTopic;
  readonly kind: ArticleKind;
  /** Phrased as the customer would ask it, because that is what is matched. */
  readonly question: string;
  /** Prose answer. Blank lines separate paragraphs. */
  readonly answer: string;
  /** Ordered steps, for a how-to. Rendered as a numbered list. */
  readonly steps?: readonly string[];
  /**
   * Other ways the same question gets asked.
   *
   * Retrieval matches words, and a customer who types "widget not showing" and
   * an article titled "The assistant does not appear on my site" share none.
   * These are indexed with the article and shown to no one.
   */
  readonly alsoAsked?: readonly string[];
  /** Where in the product the answer is carried out. */
  readonly link?: { readonly label: string; readonly href: string };
}

export const TOPIC_LABELS: Readonly<Record<ArticleTopic, string>> = {
  'getting-started': 'Getting started',
  knowledge: 'Detent Knowledge',
  branding: 'Your branding',
  behaviour: 'How the assistant behaves',
  account: 'Account, plan and billing',
  technical: 'Technical',
  troubleshooting: 'When something is wrong',
};

export const TOPIC_ORDER: readonly ArticleTopic[] = [
  'getting-started', 'knowledge', 'branding', 'behaviour',
  'account', 'technical', 'troubleshooting',
];

export const SUPPORT_ARTICLES: readonly SupportArticle[] = [
  // ---------------------------------------------------------------- start
  {
    slug: 'add-the-assistant-to-my-website',
    topic: 'getting-started',
    kind: 'how-to',
    question: 'How do I add the assistant to my website?',
    answer:
      'One line of HTML, pasted once, before the closing body tag on every page '
      + 'you want the assistant on. Most sites have a single template or footer '
      + 'include where that line goes in once and appears everywhere.\n\n'
      + 'The line carries your public key. A public key is safe in a page: it can '
      + 'start a conversation and nothing else. It cannot read your knowledge, '
      + 'reach your CRM, or see your account.',
    steps: [
      'Open Installation in your account. The snippet there already has your key in it.',
      'Copy it exactly, including the data- attributes.',
      'Paste it immediately before </body> in your site template.',
      'Publish your site, then load any page. The launcher appears in the bottom corner.',
      'Ask it a question to confirm it answers.',
    ],
    alsoAsked: [
      'install the widget', 'embed code', 'add chat to my site',
      'where do I paste the script', 'installation snippet', 'set up on my website',
    ],
    link: { label: 'Installation', href: '/app/install' },
  },
  {
    slug: 'how-long-does-setup-take',
    topic: 'getting-started',
    kind: 'faq',
    question: 'How long does setup take?',
    answer:
      'An afternoon, and most of it is you reading what the knowledge agent '
      + 'produced rather than writing anything.\n\n'
      + 'Uploading your documents takes minutes. The agent reads them and drafts '
      + 'your Detent Knowledge. Reviewing that draft is the part worth spending '
      + 'time on, because what you approve is exactly what the assistant will say. '
      + 'Installing the snippet takes one paste.\n\n'
      + 'You do not need a developer unless pasting a line into your site template '
      + 'is something only a developer can do at your organisation.',
    alsoAsked: ['how quickly can we go live', 'time to launch', 'onboarding time'],
  },
  {
    slug: 'do-we-need-a-developer',
    topic: 'getting-started',
    kind: 'faq',
    question: 'Do we need a developer?',
    answer:
      'Not for the ordinary case. Installing is one line of HTML in your site '
      + 'template, and everything else (knowledge, branding, behaviour, plan) is '
      + 'done in your account with no code at all.\n\n'
      + 'You will want a developer for three things: pasting the line if your site '
      + 'is locked down, adding our domain to a Content Security Policy if you '
      + 'run one, and connecting a CRM that needs credentials only they hold.',
    alsoAsked: ['technical help needed', 'engineering effort', 'do I need IT'],
  },

  // ------------------------------------------------------------ knowledge
  {
    slug: 'upload-our-documentation',
    topic: 'knowledge',
    kind: 'how-to',
    question: 'How do I upload our documentation?',
    answer:
      'Upload what you already have. Product sheets, price lists, FAQs, policies, '
      + 'onboarding packs, whatever you would send a customer who asked. You do '
      + 'not need to write anything new for the assistant.',
    steps: [
      'Open Detent Knowledge in your account.',
      'Drag your files in, or choose them from your computer.',
      'Wait for the knowledge agent to finish reading. Longer documents take longer.',
      'Review what it drafted, then approve what is right.',
    ],
    alsoAsked: [
      'add documents', 'upload files', 'import our content', 'feed it our pdfs',
      'where do I put our product information',
    ],
    link: { label: 'Detent Knowledge', href: '/app/knowledge' },
  },
  {
    slug: 'what-the-knowledge-agent-does',
    topic: 'knowledge',
    kind: 'faq',
    question: 'What does the knowledge agent actually do with our documents?',
    answer:
      'It reads them and rewrites them as answers.\n\n'
      + 'A document is written to be read from the top. A question arrives in the '
      + 'middle. The agent breaks your documents into single, self-contained '
      + 'answers, gives each one the question it answers, and flags anything that '
      + 'contradicts something else you uploaded, which is usually an old price '
      + 'list nobody withdrew.\n\n'
      + 'It drafts. It does not publish. Nothing it produces reaches a visitor '
      + 'until a named person at your organisation approves it, and the record '
      + 'shows who that was.',
    alsoAsked: [
      'how does it read our content', 'what is detent knowledge',
      'does it use our documents', 'ai reads our files',
    ],
  },
  {
    slug: 'approve-knowledge-before-it-goes-live',
    topic: 'knowledge',
    kind: 'how-to',
    question: 'How do I approve knowledge before it goes live?',
    answer:
      'Everything the agent drafts starts as a draft and stays there. The '
      + 'assistant can only use what has been approved, so an unreviewed document '
      + 'cannot reach a visitor by accident.',
    steps: [
      'Open Detent Knowledge and look at the drafts.',
      'Read each answer as though a customer had just been sent it, because they will be.',
      'Edit anything that is close but not right.',
      'Approve the ones that are correct. Leave the rest as drafts.',
      'Approved answers are live immediately.',
    ],
    alsoAsked: ['publish knowledge', 'review answers', 'go live with content', 'approval'],
    link: { label: 'Detent Knowledge', href: '/app/knowledge' },
  },
  {
    slug: 'add-an-answer-manually',
    topic: 'knowledge',
    kind: 'how-to',
    question: 'How do I add an answer manually?',
    answer:
      'For anything that was never written down. The question everyone asks on '
      + 'the phone and nobody documented is usually the most valuable answer you '
      + 'will add.',
    steps: [
      'Open Detent Knowledge and choose to add an answer.',
      'Write the question the way a customer asks it, not the way you would title it.',
      'Write the answer as you would say it to them.',
      'Approve it. It is live immediately.',
    ],
    alsoAsked: ['write an answer', 'add faq myself', 'manual entry', 'type in knowledge'],
    link: { label: 'Detent Knowledge', href: '/app/knowledge' },
  },
  {
    slug: 'stop-it-answering-a-topic',
    topic: 'knowledge',
    kind: 'how-to',
    question: 'How do I stop it answering about something?',
    answer:
      'Remove the knowledge, and it stops. The assistant answers from what you '
      + 'approved and nothing else, so withdrawing an answer withdraws the '
      + 'behaviour: there is no second place it might still be remembered.',
    steps: [
      'Open Detent Knowledge and find the answers on that topic.',
      'Withdraw them. They stop being used immediately.',
      'If the subject should be handled by a person instead, add an answer that says so.',
    ],
    alsoAsked: [
      'remove a topic', 'block a subject', 'stop talking about', 'take down an answer',
    ],
  },

  // ------------------------------------------------------------- branding
  {
    slug: 'put-our-logo-on-the-widget',
    topic: 'branding',
    kind: 'how-to',
    question: 'How do I put our logo on the assistant?',
    answer:
      'The assistant carries your brand, not ours. Upload your logo and it '
      + 'replaces the Detent mark in the launcher and the panel header.',
    steps: [
      'Open Branding in your account.',
      'Upload your logo. Most formats work, including SVG.',
      'Set your accent colour and the label on the launcher.',
      'Check the preview beside it, then save.',
    ],
    alsoAsked: [
      'change the logo', 'white label', 'our branding', 'remove detent logo',
      'customise appearance', 'brand colours',
    ],
    link: { label: 'Branding', href: '/app/branding' },
  },
  {
    slug: 'what-logo-shapes-work',
    topic: 'branding',
    kind: 'faq',
    question: 'What shape does our logo need to be?',
    answer:
      'Any shape. A square mark, a tall badge and a long wordmark are all handled '
      + 'differently on purpose.\n\n'
      + 'A square or round mark is used as it is. A wide wordmark is fitted to the '
      + 'header rather than shrunk into the launcher, because a ten-to-one '
      + 'wordmark scaled to fit a small circle is a smear. Where a wordmark would '
      + 'be too small to read, the assistant shows a monogram of your initials '
      + 'instead, legible beats faithful at that size.\n\n'
      + 'Transparent backgrounds are respected on both light and dark panels.',
    alsoAsked: [
      'logo size', 'svg logo', 'wide logo', 'square logo', 'logo dimensions',
      'logo looks wrong', 'logo too small',
    ],
  },

  // ------------------------------------------------------------ behaviour
  {
    slug: 'why-did-it-refuse-to-answer',
    topic: 'behaviour',
    kind: 'faq',
    question: 'Why did the assistant say it could not help?',
    answer:
      'Because it had no approved answer, and saying so is the designed '
      + 'behaviour rather than a failure.\n\n'
      + 'The assistant answers from your approved knowledge. Where that knowledge '
      + 'does not cover the question, it says it does not know and offers the '
      + 'visitor a person. It does not reason its way to a plausible answer, '
      + 'because a plausible answer about your product that you never approved is '
      + 'the one thing that would cost you a customer.\n\n'
      + 'If it refuses something it should know, the fix is an approved answer, '
      + 'not a setting.',
    alsoAsked: [
      'it says it does not know', 'refused to answer', 'would not answer',
      'says it cannot help', 'not answering questions',
    ],
  },
  {
    slug: 'can-it-quote-prices',
    topic: 'behaviour',
    kind: 'faq',
    question: 'Can it quote prices?',
    answer:
      'It can quote a price you approved. It cannot produce one you did not.\n\n'
      + 'A price is a number a visitor will hold you to, so it is treated as a '
      + 'fact that must exist in your knowledge rather than something to be '
      + 'worked out. It will not calculate a discount, infer a rate from a '
      + 'similar product, or agree to a figure a visitor suggests. Asked for a '
      + 'price it does not hold, it says so and offers a person.',
    alsoAsked: [
      'discount', 'will it negotiate', 'quote a price', 'make up prices', 'pricing answers',
    ],
  },
  {
    slug: 'how-escalation-works',
    topic: 'behaviour',
    kind: 'faq',
    question: 'What happens when a visitor wants a person?',
    answer:
      'It hands over with the conversation attached, so the visitor does not '
      + 'start again.\n\n'
      + 'A handover happens when the visitor asks for one, when the question is '
      + 'outside approved knowledge, or when the conversation turns into a '
      + 'complaint. Your team receives what was asked, what was answered and what '
      + 'the assistant established, not a bare notification that somebody wanted '
      + 'to talk.',
    alsoAsked: [
      'talk to a human', 'handover', 'escalate to sales', 'transfer to a person',
    ],
  },
  {
    slug: 'does-it-say-it-is-ai',
    topic: 'behaviour',
    kind: 'faq',
    question: 'Does it tell visitors it is an AI?',
    answer:
      'Always, at the start of every conversation, and it cannot be switched off.\n\n'
      + 'This is not a setting because it is the ground a visitor is entitled to '
      + 'stand on, and because a business that lets an AI imply it is a person has '
      + 'a problem no configuration should be able to create.',
    alsoAsked: ['disclosure', 'does it pretend to be human', 'ai notice', 'transparency'],
  },

  // -------------------------------------------------------------- account
  {
    slug: 'where-do-i-see-usage-credits',
    topic: 'account',
    kind: 'how-to',
    question: 'Where do I see how many credits we have used?',
    answer:
      'In your account, against the current billing period. Credits are consumed '
      + 'by conversations, and the figure shown is what has been used since the '
      + 'period began, not since you signed up.',
    steps: [
      'Open Plan and usage in your account.',
      'Read the current period figure and the date it resets.',
      'The history below shows previous periods, so you can see the trend.',
    ],
    alsoAsked: [
      'usage', 'credits left', 'how many conversations', 'allowance', 'quota',
    ],
    link: { label: 'Plan and usage', href: '/app/plan' },
  },
  {
    slug: 'what-if-we-run-out-of-credits',
    topic: 'account',
    kind: 'faq',
    question: 'What happens if we run out of credits?',
    answer:
      'The assistant keeps talking to the visitor in front of it and stops '
      + 'starting new conversations. Cutting off mid-sentence would punish the '
      + 'visitor for your billing.\n\n'
      + 'You are warned before it happens. If your plan is unmetered on a '
      + 'measure, that measure has no limit at all: an unmetered allowance is '
      + 'not a very large number, it is the absence of one.',
    alsoAsked: [
      'run out', 'exceed allowance', 'over limit', 'credits exhausted', 'what if we go over',
    ],
  },
  {
    slug: 'when-are-we-billed',
    topic: 'account',
    kind: 'faq',
    question: 'When are we billed, and what is the difference between term and billing period?',
    answer:
      'They are two different things and confusing them is the commonest billing '
      + 'question we get.\n\n'
      + 'Your term is how long you have committed for, twelve months, say. Your '
      + 'billing period is how often you are invoiced within it, monthly, say. A '
      + 'twelve-month term billed monthly renews once a year and invoices twelve '
      + 'times.\n\n'
      + 'Both dates are shown in your account, separately, for exactly this reason.',
    alsoAsked: [
      'renewal date', 'invoice date', 'contract length', 'when do we pay', 'billing cycle',
    ],
    link: { label: 'Plan and usage', href: '/app/plan' },
  },
  {
    slug: 'change-or-cancel-our-plan',
    topic: 'account',
    kind: 'how-to',
    question: 'How do I change or cancel our plan?',
    answer:
      'Changes take effect from your next billing period, and the price you were '
      + 'sold is the price you keep. If our list price changes, yours does not: '
      + 'your subscription is pinned to the plan version you bought.',
    steps: [
      'Open Plan and usage in your account.',
      'Choose a different plan, or choose not to renew.',
      'Confirm. The change and its effective date are shown before you commit.',
      'Nothing changes mid-period, and nothing is lost: your knowledge stays as it is.',
    ],
    alsoAsked: ['upgrade', 'downgrade', 'cancel subscription', 'switch plan', 'stop paying'],
    link: { label: 'Plan and usage', href: '/app/plan' },
  },

  // ------------------------------------------------------------ technical
  {
    slug: 'content-security-policy',
    topic: 'technical',
    kind: 'faq',
    question: 'We run a Content Security Policy. What do we need to allow?',
    answer:
      'The assistant loads a script and talks to our API, so a policy that names '
      + 'sources has to name ours. Allow our domain in script-src and connect-src. '
      + 'If you use frame-src, allow it there too, since the panel is framed.\n\n'
      + 'The exact host is shown on your Installation page, so you can copy it '
      + 'rather than transcribe it. If the launcher does not appear and your '
      + 'browser console mentions a policy, this is why.',
    alsoAsked: [
      'csp', 'script-src', 'connect-src', 'blocked by policy', 'security policy',
      'whitelist domain', 'allowlist',
    ],
    link: { label: 'Installation', href: '/app/install' },
  },
  {
    slug: 'single-page-app',
    topic: 'technical',
    kind: 'faq',
    question: 'Does it work on a single-page app?',
    answer:
      'Yes, and it needs nothing extra. The snippet loads once and the assistant '
      + 'survives client-side navigation, so a visitor who moves between routes '
      + 'keeps the conversation they were having rather than starting again.',
    alsoAsked: ['react', 'vue', 'angular', 'spa', 'client side routing', 'next.js'],
  },
  {
    slug: 'rotate-our-api-key',
    topic: 'technical',
    kind: 'how-to',
    question: 'How do I rotate our API key?',
    answer:
      'Rotate whenever you suspect exposure, and on the schedule your own policy '
      + 'sets. We store only a digest of a key, never the key, which is why a lost '
      + 'key cannot be shown to you again and has to be replaced.',
    steps: [
      'Open API access in your account.',
      'Create a new key. It is shown once, copy it now.',
      'Update wherever the old key is used.',
      'Revoke the old key. It stops working immediately.',
    ],
    alsoAsked: [
      'new api key', 'secret key', 'revoke key', 'lost our key', 'key rotation',
    ],
    link: { label: 'API access', href: '/app/api' },
  },
  {
    slug: 'where-is-our-data-stored',
    topic: 'technical',
    kind: 'faq',
    question: 'Where is our data stored, and who can see it?',
    answer:
      'Your knowledge and your conversations are yours. They are held separately '
      + 'from every other customer, and the separation is enforced by the database '
      + 'rather than by our application code: a query that forgets to filter by '
      + 'customer returns nothing at all, rather than returning somebody else.\n\n'
      + 'Your content is not used to train a model. We never hold a card number: '
      + 'payment details go to the payment provider and we keep only a reference.\n\n'
      + 'Every conversation is recorded in an audit trail you can read, and the '
      + 'trail is chained, so an entry cannot be altered after the fact without '
      + 'breaking it.',
    alsoAsked: [
      'gdpr', 'data protection', 'privacy', 'training data', 'where is data held',
      'is our data safe', 'data residency', 'pci',
    ],
  },
  {
    slug: 'check-the-service-is-up',
    topic: 'technical',
    kind: 'how-to',
    question: 'How do I check the service is up?',
    answer:
      'There is a health endpoint you can point your own monitoring at, so you '
      + 'are not relying on us to tell you.',
    steps: [
      'Open Health and status in your account to see the endpoint for your workspace.',
      'Point your monitoring at it. It answers without authentication and reveals nothing about your data.',
      'A healthy response is 200 with a status of ok.',
    ],
    alsoAsked: ['status page', 'uptime', 'health check', 'monitoring', 'is it down'],
    link: { label: 'Health and status', href: '/app/status' },
  },

  // ------------------------------------------------------- troubleshooting
  {
    slug: 'the-assistant-does-not-appear',
    topic: 'troubleshooting',
    kind: 'how-to',
    question: 'The assistant does not appear on our site.',
    answer:
      'Almost always one of four things, in the order they are worth checking.',
    steps: [
      'Confirm the snippet is on the page you are looking at, view source and search for data-detent-assistant.',
      'Confirm it is before </body>, not inside a container that is hidden or removed.',
      'Open your browser console. A Content Security Policy blocking the script says so there.',
      'Confirm the key in the snippet matches the one on your Installation page: a copied snippet from a colleague may carry theirs.',
      'If all four are right, raise a request below and include the page address.',
    ],
    alsoAsked: [
      'widget not showing', 'nothing appears', 'chat not loading', 'launcher missing',
      'cannot see the assistant', 'not working on our site',
    ],
    link: { label: 'Installation', href: '/app/install' },
  },
  {
    slug: 'password-reset-email-not-arriving',
    topic: 'troubleshooting',
    kind: 'how-to',
    question: 'The password reset email has not arrived.',
    answer:
      'Reset links are valid for a short time and can only be used once, so an '
      + 'old link in your inbox will not work even if you find it.',
    steps: [
      'Check the spam folder, and search for the sender rather than the subject.',
      'Confirm you asked with the address you actually sign in with.',
      'Request a new link. The previous one stops working when you do.',
      'If nothing arrives, ask your IT team whether our sender is being filtered.',
    ],
    alsoAsked: [
      'no reset email', 'forgot password', 'cannot log in', 'reset link expired',
      'locked out',
    ],
  },
  {
    slug: 'it-answers-wrongly',
    topic: 'troubleshooting',
    kind: 'how-to',
    question: 'The assistant gave a wrong answer.',
    answer:
      'A wrong answer comes from wrong knowledge, because the assistant does not '
      + 'produce facts of its own. That makes it fixable in minutes, and the fix '
      + 'is permanent rather than a nudge.',
    steps: [
      'Find the conversation in your account and read what it actually said.',
      'The answer cites what it used. Open that piece of knowledge.',
      'Correct it, or withdraw it if it should never have been there.',
      'The correction applies to the next conversation. There is no cache to clear.',
    ],
    alsoAsked: [
      'wrong information', 'incorrect answer', 'said something wrong', 'hallucination',
      'made something up', 'out of date answer',
    ],
  },
];

/** Articles for one topic, in the order they are written. */
export function articlesByTopic(topic: ArticleTopic): readonly SupportArticle[] {
  return SUPPORT_ARTICLES.filter((article) => article.topic === topic);
}

export function articleBySlug(slug: string): SupportArticle | undefined {
  return SUPPORT_ARTICLES.find((article) => article.slug === slug);
}

/**
 * The full text of an article, for indexing.
 *
 * The alternative phrasings are included here and nowhere else: they exist to
 * be matched against, not to be read.
 */
export function articleText(article: SupportArticle): string {
  return [
    article.question,
    ...(article.alsoAsked ?? []),
    article.answer,
    ...(article.steps ?? []),
  ].join('\n');
}
