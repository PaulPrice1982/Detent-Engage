import type { KnowledgeCorpus } from '@detent/awa-knowledge';

/**
 * Detent's own knowledge, for the assistant on Detent's own website.
 *
 * The marketing site says Detent runs its own assistant, and a vendor who will
 * not is telling you something. That claim is only worth making if the thing
 * actually answers: an assistant on our own site that falls back to "what are
 * you trying to solve?" demonstrates the opposite of what the page argues.
 *
 * These are answers to what a *visitor* asks, whether it does what they need,
 * what it costs, whether it is safe. They are separate from the support
 * articles, which answer what a *customer* asks about running it. The two
 * audiences want different things from the same facts.
 *
 * Everything here is approved on the way in, because it is ours and we wrote
 * it. A customer's own knowledge is never approved on their behalf.
 */
interface Answer {
  readonly title: string;
  readonly text: string;
}

const ANSWERS: readonly Answer[] = [
  {
    title: 'Which CRMs does Detent write to?',
    text:
      'Detent writes to Salesforce, HubSpot, Microsoft Dynamics and Pipedrive, and connects to '
      + 'others through a standard interface. Against the record it writes what the conversation '
      + 'established: who the person is, what they asked about, how qualified they are and '
      + 'what was agreed, rather than dropping a transcript into a note field. If your CRM is '
      + 'not on the list, ask and we will tell you honestly whether it is supported.',
  },
  {
    title: 'How long does it take to set up?',
    text:
      'An afternoon. You upload the documentation you already have, an AI agent reads it and '
      + 'drafts your answers, you approve what is right, and you paste one line into your site. '
      + 'Most of the time is spent reading what the agent produced, which is the part worth '
      + 'spending time on, because what you approve is exactly what it will say.',
  },
  {
    title: 'Do we need a developer?',
    text:
      'Not usually. Installing is one line of HTML in your site template, and everything else '
      + '(knowledge, branding, behaviour, plan) is done in your account with no code. You would '
      + 'want a developer only if your site is locked down, if you run a content security policy '
      + 'that needs our domain adding, or to connect a CRM whose credentials only they hold.',
  },
  {
    title: 'What does Detent cost?',
    text:
      'There is a plan fee that includes a monthly allowance of conversation credits, and an '
      + 'outcome fee that applies only when an outcome is confirmed: a booked meeting, a '
      + 'qualified handover. If nobody books anything, you pay the plan fee and nothing else. '
      + 'The current plans and prices are on the pricing section of this page.',
  },
  {
    title: 'Can the assistant make something up about our products?',
    text:
      'No. It answers only from knowledge you have approved, and where your knowledge does not '
      + 'cover a question it says so and offers the visitor a person. It will not reason its way '
      + 'to a plausible answer about your product, because a plausible answer you never approved '
      + 'is the one thing that would cost you a customer.',
  },
  {
    title: 'Can it quote prices or agree a discount?',
    text:
      'It can quote a price you have approved. It cannot produce one you have not, calculate a '
      + 'discount, or agree to a figure a visitor suggests. A price is a number a visitor will '
      + 'hold you to, so it is treated as a fact that must exist in your knowledge rather than '
      + 'something to be worked out.',
  },
  {
    title: 'Does it tell visitors it is an AI?',
    text:
      'Always, at the start of every conversation, and it cannot be switched off. A business '
      + 'that lets an AI imply it is a person has a problem no configuration should be able to '
      + 'create.',
  },
  {
    title: 'What happens to our data, and is it used for training?',
    text:
      'Your knowledge and your conversations are yours and are not used to train a model. Every '
      + 'customer is held separately, and the separation is enforced by the database rather than '
      + 'by application code: a query that forgets to filter by customer returns nothing at all '
      + 'rather than returning somebody else. Every conversation is written to an audit trail you '
      + 'can read, and the trail is chained so an entry cannot be altered afterwards without '
      + 'breaking it. We never hold a card number.',
  },
  {
    title: 'Can it speak, or is it text only?',
    text:
      'Both. It can hold a spoken conversation as well as a typed one, and a visitor can switch '
      + 'between them mid-conversation without starting again. A text-only route is always '
      + 'available, because voice is not usable for everyone.',
  },
  {
    title: 'Will it look like our brand?',
    text:
      'Yes. You upload your logo and set your accent colour and the wording on the launcher, and '
      + 'the assistant carries your brand rather than ours. Square marks, tall badges and long '
      + 'wordmarks are each handled differently so none of them ends up as a smear in a small '
      + 'circle.',
  },
  {
    title: 'How does it hand over to a person?',
    text:
      'With the conversation attached, so the visitor does not start again. Your team receives '
      + 'what was asked, what was answered and what the assistant established, not a bare '
      + 'notification that somebody wanted to talk. It hands over when the visitor asks, when the '
      + 'question is outside approved knowledge, or when the conversation turns into a complaint.',
  },
  {
    title: 'Can it book a meeting in our calendar?',
    text:
      'Yes, straight into the calendar of the right person, against your real availability rather '
      + 'than a form that promises somebody will be in touch. It qualifies as it goes, so the '
      + 'meeting that lands in the diary is one worth having.',
  },
  {
    title: 'Do you have a reseller or partner programme?',
    text:
      'Yes. Resellers are given an exclusive postcode area, leads from that area, marketing '
      + 'support, and commission from 20% to 50% depending on volume, paid monthly. The reseller '
      + 'acts as first-line support with our own desk behind them. The Partners page has the '
      + 'detail.',
  },
  {
    title: 'What if the assistant gets something wrong?',
    text:
      'A wrong answer comes from wrong knowledge, because the assistant produces no facts of its '
      + 'own. Every answer cites what it used, so you can open that piece of knowledge, correct '
      + 'it or withdraw it, and the correction applies to the next conversation. There is no '
      + 'cache to clear and no model to retrain.',
  },
];

/**
 * Seeds and approves Detent's own answers for its own tenant.
 *
 * Idempotent by construction at boot: it runs once, on a corpus created in the
 * same process.
 */
export function seedDetentKnowledge(corpus: KnowledgeCorpus, tenantId: string): number {
  for (const answer of ANSWERS) {
    const chunk = corpus.ingest({
      tenantId,
      sourceKind: 'faq',
      sourceRef: 'detent-website',
      title: answer.title,
      text: answer.text,
      shipped: true,
    });
    // Approved as we ingest, because this is our own copy about our own
    // product. Nothing here approves anything on a customer's behalf.
    corpus.publish(tenantId, chunk.id, 'detent');
  }
  return ANSWERS.length;
}
