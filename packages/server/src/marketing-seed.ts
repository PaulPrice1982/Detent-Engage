import { newSection, type PageService, type SeedOutcome } from '@detent/awa-cms';

/**
 * The revision of the shipped marketing copy. **Bump it whenever the copy in
 * this file changes**, or the change reaches nobody.
 *
 * The copy ships in the release and lives in the database, and before this
 * there was no way to reconcile the two: the seed ran only when the site had no
 * pages at all, so whatever wording the first deployment happened to create was
 * the wording for ever. A release rewrote the whole home page and the live site
 * carried on showing the copy it was born with. That is not a hypothetical, it
 * is what happened, and it was reported as "the text still says the old thing".
 *
 * A page edited in the console is never overwritten by this. See
 * PageService.reseed.
 *
 * 1: first published copy.
 * 2: per-reply pricing, the vertical table, out of hours and UK data protection.
 * 3: no dashes anywhere; a booked meeting demoted from the outcome to one
 *    outcome; the three-way comparison against a person and against nobody, and
 *    the arithmetic on doing nothing.
 * 4: titles and meta descriptions cut to what a search result actually shows.
 * 5: the privacy statement, terms of use and cookie policy, and every claim on
 *    the home page checked against what the build actually does. Residency is
 *    stated as a contract term rather than a slogan, the CRM list says how a
 *    connector is enabled, calendar booking is named as next rather than sold
 *    as present, voice is not sold at all until it is wired, and the upload
 *    list matches the extractors that exist.
 */
export const MARKETING_COPY_REVISION = 6;

/**
 * The home page as first written.
 *
 * Seeded so the site is never blank, and editable from the console the moment
 * somebody disagrees with it, which is the point of holding it in the CMS
 * rather than a template.
 *
 * The argument, in order: buyers arrive and leave unanswered; an assistant
 * fixes that only if it can be trusted to speak for you; setting it up is an
 * afternoon, not a project, because the AI reads your documentation for you;
 * it is safe by construction; and you pay 50p when it answers somebody,
 * capped per conversation, rather than a subscription sized for a year you
 * have not had yet.
 */
export async function seedHomePage(
  pages: PageService, appBaseUrl: string,
): Promise<SeedOutcome> {
  const page = {
    slug: 'home',
    title: 'Detent: the AI that answers your website visitors, safely',
    // Under 160 characters on purpose. This is the line under the title in a
    // search result, and Google cuts it there: it was 322, so two thirds of it
    // was never read by anybody and the part that was read said nothing about
    // what happens next. The full argument is the page, not the snippet.
    description:
      'Your website is open all night and nobody is answering. Detent answers buyers in '
      + 'seconds from your own approved knowledge. UK and EEA hosting, \u00a39.99 a month.',
  };

  const sections = [
    {
      ...newSection('hero', 'ink'),
      heading: 'Your website is open all night. Nobody is answering.',
      lede:
        'Most of the people who visit your site are interested enough to look and not ready '
        + 'enough to fill in a form. They leave without asking the one question that was '
        + 'stopping them, and you never learn what it was.\n\n'
        + 'Detent answers them. It knows your products because it has read your documentation, '
        + 'it does whatever the answer leads to (a booking, a quote, a callback, a basket, an '
        + 'address for the delivery), and it writes what it learns to your CRM. It is live in '
        + 'an afternoon.',
      primaryActionLabel: 'Start free',
      primaryActionHref: `${appBaseUrl}/signup`,
      secondaryActionLabel: 'See how setup works',
      secondaryActionHref: '#setup',
    },
    {
      ...newSection('features', 'light'),
      kicker: 'Why you need one',
      heading: 'The gap between interested and in touch.',
      lede:
        'Nothing on your website closes that gap. A contact form asks a buyer to commit before '
        + 'they have their answer, and a phone number asks more.',
      items: [
        {
          heading: 'They ask at nine at night',
          body: 'Buyers research outside your hours, on their phone, between other things. '
            + 'An answer tomorrow is an answer they no longer need.',
        },
        {
          heading: 'The question is always specific',
          body: 'Does it integrate with what we already run. What is the lead time. Do you work '
            + 'with companies our size. Your site cannot answer all of them; an assistant that '
            + 'has read your documentation can.',
        },
        {
          heading: 'You learn nothing from a bounce',
          body: 'A visitor who leaves tells you nothing. A visitor who asks tells you what your '
            + 'market wants to know, which turns out to be worth more than the lead.',
        },
      ],
    },
    {
      ...newSection('steps', 'tint'),
      kicker: 'Setup',
      heading: 'The AI does the setup. You approve it.',
      lede:
        'The slow part of every assistant is teaching it your business. Detent turns that from '
        + 'weeks of writing answers into an afternoon of reading them.',
      items: [
        {
          heading: 'Upload what you already have',
          body: 'Your product handbook, price list, terms, service descriptions, whatever exists. '
            + 'PDF, Word, HTML, Markdown, CSV or a page from your site. Nobody writes anything '
            + 'new. A scanned PDF is pictures of words rather than words, and it says so instead '
            + 'of quietly reading nothing.',
        },
        {
          heading: 'The knowledge agent reads it',
          body: 'It proposes Detent Knowledge: clear articles and the FAQs your buyers actually '
            + 'ask, each one citing the page it came from so you can check the claim in a glance.',
        },
        {
          heading: 'You approve, and it goes live',
          body: 'Nothing is used until you approve it. Prices and figures are listed separately '
            + 'and confirmed one by one, because a number is the thing most worth being sure of.',
        },
        {
          heading: 'One line on your site',
          body: 'A single script tag before the closing body tag. It carries your logo and your '
            + 'colour, loads only when someone opens it, and cannot disturb your page.',
        },
      ],
      primaryActionLabel: 'Start free',
      primaryActionHref: `${appBaseUrl}/signup`,
    },
    {
      ...newSection('demo', 'light'),
      kicker: 'Setup, recorded',
      heading: 'This is the whole of it.',
      mediaSrc: '/media/demo-setup.webm',
      mediaPoster: '/media/demo-setup.png',
      mediaDescription:
        'Detent Knowledge, in a new account. You upload what you already have (product '
        + 'sheets, price lists, the FAQ nobody has updated since last year) and the '
        + 'knowledge agent reads it and drafts your answers. Nothing it drafts is live until '
        + 'you approve it, and the record shows who did.',
    },
    {
      ...newSection('features', 'light'),
      kicker: 'Safe by construction',
      heading: 'Safe enough to leave running while you sleep.',
      lede:
        'An assistant speaks to your buyers in your name. What it says is your word. So the '
        + 'safeguards are built into how it works, not offered as settings somebody can switch '
        + 'off on a busy afternoon.',
      items: [
        {
          heading: 'It cannot invent a price',
          body: 'Every figure it states has been approved by someone at your company. Asked '
            + 'something it has not been given, it says so and offers a person: it never guesses.',
        },
        {
          heading: 'It cannot damage your CRM',
          body: 'Owner, stage and pipeline are read-only. The assistant adds what it learns and '
            + 'is structurally unable to overwrite what your team already recorded.',
        },
        {
          heading: 'It cannot be talked into it',
          body: 'Visitors try. So do documents: text hidden in a supplier PDF aimed at an AI is '
            + 'quarantined and shown to you rather than obeyed.',
        },
        {
          heading: 'Every conversation is on the record',
          body: 'A tamper-evident log replays any conversation exactly as it happened. When '
            + 'someone asks what it said in March, answering is a lookup rather than an investigation.',
        },
        {
          heading: 'Your data stays yours',
          body: 'Consent is asked before anyone is identified, not assumed from a banner. Retention '
            + 'is yours to set, and an export answers a subject access request in one click.',
        },
        {
          heading: 'Always says it is AI',
          body: 'Disclosed on the launcher, before anybody types. It is a legal obligation and it '
            + 'cannot be turned off, including by us.',
        },
      ],
    },
    {
      ...newSection('statement', 'ink'),
      kicker: 'Pricing',
      heading:
        '\u00a39.99 a month. 50p each time it answers somebody.',
      lede:
        'You are not buying a seat, or a tier sized for a year you have not had yet. You pay a '
        + 'small monthly fee to have it there, and 50p when it actually answers a visitor.\n\n'
        + 'Three things that make that a price rather than a meter. It is not charged when it '
        + 'has no answer and hands over to a person. You do not pay us to fail. No more '
        + 'than six replies are charged in any one conversation, so the worst a single visitor '
        + 'can cost you is \u00a33, however long they stay. And you set a hard monthly ceiling, '
        + 'above which it stops rather than bills.',
      primaryActionLabel: 'See the plans',
      primaryActionHref: '#pricing',
    },
    {
      ...newSection('features', 'tint'),
      kicker: 'Effective',
      heading: 'What it actually does, once it is live.',
      items: [
        {
          heading: 'Answers, in your words',
          body: 'From the knowledge you approved, in the tone you set. Not a search box that '
            + 'returns links to the page they were already reading.',
        },
        {
          heading: 'Carries the answer through to whatever it leads to',
          body: 'A meeting where a meeting is the point, and where it is not: a quote, a '
            + 'callback, a stock check, a booking, a form filled in for them. It captures what '
            + 'was agreed and writes it to your CRM for your team to act on, and it does not '
            + 'push a meeting on somebody who came to ask about a size. Direct booking into '
            + 'Google and Microsoft calendars is next, and is not claimed here until it is '
            + 'yours to use.',
        },
        {
          heading: 'Qualifies as it goes',
          body: 'Size, timing, what they already use, what is stopping them. Your team opens a '
            + 'conversation that is already understood.',
        },
        {
          heading: 'Hands over cleanly',
          body: 'When a question needs a person, it says so and passes the whole conversation '
            + 'across. Nobody starts again from the beginning.',
        },
        {
          heading: 'Writes it to your CRM',
          body: 'Adapters for Salesforce, HubSpot, Dynamics, Pipedrive and Zoho, mapped to your '
            + 'fields and deduplicated against what is already there. Each one is enabled for '
            + 'your account when we connect it with you, rather than by a switch you find '
            + 'yourself: it writes to your live system, so a person is on both ends of the '
            + 'first one.',
        },
        {
          heading: 'Answers on the record',
          body: 'Every conversation is replayable exactly as it happened, so what the assistant '
            + 'said to somebody in March is a lookup rather than an investigation.',
        },
      ],
    },
    {
      ...newSection('demo', 'tint'),
      kicker: 'The assistant, answering',
      heading: 'Ours is running on this page. Here it is being asked something real.',
      mediaSrc: '/media/demo-assistant.webm',
      mediaPoster: '/media/demo-assistant.png',
      mediaDescription:
        'A visitor asks whether Detent works with Salesforce, and it answers from approved '
        + 'knowledge, naming the CRMs and what it writes to them. It says it is an AI '
        + 'before anything else, and asks permission before checking whether it already knows '
        + 'the visitor.\n\nAsk it something awkward yourself. It is the same assistant, set up '
        + 'the same way yours would be, and it will tell you when it does not know.',
      primaryActionLabel: 'Start free',
      primaryActionHref: `${appBaseUrl}/signup`,
    },
    {
      ...newSection('table', 'light'),
      kicker: 'Every industry, not just B2B',
      heading: 'A booked meeting is a B2B answer. Most businesses want a question answered.',
      lede:
        'Which is why you are not charged for meetings. A retailer does not want a meeting, a '
        + 'clinic does not want a meeting, a restaurant certainly does not. They want the '
        + 'question answered while the person is still there to hear it.',
      columns: ['Industry', 'What the visitor asks at 9pm', 'What a person would cost', 'Detent'],
      highlightColumn: 3,
      rows: [
        ['Retail', 'Is this in stock in a 12, and when would it arrive?',
          '\u00a31.50 to \u00a34 a chat outsourced', '50p a reply, \u00a33 a conversation'],
        ['Trades and home improvement', 'Do you cover my postcode, and roughly what does it cost?',
          '\u00a37 to \u00a312 in-house', '50p a reply, \u00a33 a conversation'],
        ['Clinics and dental', 'Do you take my insurance, and how long is the wait?',
          '\u00a37 to \u00a312 in-house', '50p a reply, \u00a33 a conversation'],
        ['Hospitality and travel', 'Do you have a table on Friday, and is it accessible?',
          '\u00a31.50 to \u00a34 a chat outsourced', '50p a reply, \u00a33 a conversation'],
        ['Professional services', 'Do you handle this kind of matter, and what are your fees?',
          '\u00a37 to \u00a312 in-house', '50p a reply, \u00a33 a conversation'],
        ['B2B software and services', 'Does it integrate with what we already run?',
          '\u00a37 to \u00a312 in-house', '50p a reply, \u00a33 a conversation'],
      ],
    },
    {
      ...newSection('statement', 'ink'),
      kicker: 'The comparison that matters',
      heading:
        'The question is not what a person costs. It is what the enquiry you never saw was '
        + 'worth.',
      lede:
        'A person is \u00a37 to \u00a312 a conversation in-house, or \u00a31.50 to \u00a34 '
        + 'outsourced. Round-the-clock cover takes four and a bit people for one seat, which is '
        + 'north of \u00a3170,000 a year before anybody has answered anything.\n\n'
        + 'None of that is the real number. The real number is the visitor who arrived at nine '
        + 'in the evening, did not fill in the form, and left. They never appear in a '
        + 'report, which is exactly why nobody has ever fixed it.',
    },
    {
      ...newSection('table', 'light'),
      kicker: 'Three ways to handle a nine o\u2019clock question',
      heading: 'A person, Detent, or nobody. Most businesses have quietly chosen nobody.',
      lede:
        'Nobody is the default, and it is the only one of the three that never appears on a '
        + 'budget line. That is what makes it expensive: a cost you are already paying and have '
        + 'never once been invoiced for.',
      columns: ['One evening enquiry', 'A person', 'Detent', 'Nobody, which is today'],
      highlightColumn: 2,
      rows: [
        ['What the conversation costs',
          '\u00a37 to \u00a312 in-house, \u00a31.50 to \u00a34 outsourced',
          '50p a reply, \u00a33 at the very most',
          'Nothing to run, and the enquiry'],
        ['When the question gets answered',
          'Tomorrow, if somebody is rostered on',
          'In seconds, at any hour',
          'Never'],
        ['Covering the 128 hours a week you are shut',
          'Four and a bit people for one seat, north of \u00a3170,000 a year',
          'Included. There are no hours it is not there',
          'Not covered'],
        ['What you know in the morning',
          'Whatever got written up',
          'Every question asked, written to your CRM',
          'Nothing. A visitor who leaves leaves no trace'],
        ['When the buyer was not ready to buy',
          'You paid the salary either way',
          'Nothing. It is not charged when it hands over',
          'You lose the next one too, because you never learned why'],
        ['What it costs to double the volume',
          'Another person, hired and trained',
          'Another 50p a reply',
          'Nothing, and nothing is what you get'],
      ],
    },
    {
      ...newSection('table', 'tint'),
      kicker: 'The arithmetic on doing nothing',
      heading: 'One extra enquiry a night, answered, against the cost of answering it.',
      lede:
        'Use your own numbers rather than ours. This assumes one buyer a night who would have '
        + 'asked and did not, thirty of them in a month, and a conservative one in ten going on '
        + 'to buy. Detent costs \u00a39.99 a month plus 50p a reply, capped at \u00a33 a '
        + 'conversation, so thirty conversations is about \u00a3100 at the absolute ceiling '
        + 'and rather less in practice.',
      columns: [
        'If your average sale is',
        'Thirty answered enquiries produce',
        'Worth, in a month',
        'What it cost you',
        'What doing nothing cost you',
      ],
      highlightColumn: 4,
      rows: [
        ['\u00a3200', 'about 3 sales', '\u00a3600', 'about \u00a3100', '\u00a3600'],
        ['\u00a31,000', 'about 3 sales', '\u00a33,000', 'about \u00a3100', '\u00a33,000'],
        ['\u00a35,000', 'about 3 sales', '\u00a315,000', 'about \u00a3100', '\u00a315,000'],
        ['\u00a325,000', 'about 3 sales', '\u00a375,000', 'about \u00a3100', '\u00a375,000'],
      ],
    },
    {
      ...newSection('prose', 'light'),
      heading: 'Why the last column is the one to argue with.',
      lede:
        'Every other number on this page is checkable. That one is not, and it is deliberately '
        + 'the largest, because it is the number your current setup is built to keep invisible. '
        + 'A form that nobody filled in reports nothing. A visitor who left at 21:40 without '
        + 'typing anything is indistinguishable, in every analytics tool you own, from one who '
        + 'was never interested.\n\n'
        + 'So argue with it. Halve it. Halve it again. At an average sale of \u00a31,000 you '
        + 'are still comparing about \u00a3100 with \u00a3750, and you are still paying the '
        + 'larger number today without seeing it on anything.',
    },
    {
      ...newSection('features', 'light'),
      kicker: 'While you sleep',
      heading: 'Your busiest hour is one you are not open for.',
      items: [
        {
          heading: 'Most enquiries arrive after you have gone home',
          body: 'People research in the evening, after work, on a phone, in the gap between '
            + 'putting the children to bed and going to bed themselves. That is when your site '
            + 'is busiest and least attended.',
        },
        {
          heading: 'Other regions are awake when you are not',
          body: 'If you sell into Europe, the Gulf, the US or Asia, a good part of your market '
            + 'is working while Britain sleeps. An enquiry from Dubai at six in the morning or '
            + 'from California at eleven at night is answered in seconds rather than waiting '
            + 'overnight for a reply that arrives after they have found somebody else.',
        },
        {
          heading: 'No shift premium, no rota, no attrition',
          body: 'Covering evenings and weekends with people means unsocial-hours pay, a rota, '
            + 'and re-recruiting whoever leaves. The assistant works the hours your website is '
            + 'open, which is all of them.',
        },
        {
          heading: 'It answers in seconds, not by morning',
          body: 'The business that replies first usually wins, and at eleven at night first '
            + 'means now. Overnight is not a reply time, it is a queue.',
        },
        {
          heading: 'Everything is waiting for you in the morning',
          body: 'Who asked, what they wanted, what was established and what was agreed, '
            + 'written to your CRM overnight, so the first thing you do is follow up rather '
            + 'than read transcripts.',
        },
        {
          heading: 'The same care at 3am as at 3pm',
          body: 'It answers only from what you approved, whatever the hour. There is no tired '
            + 'night shift improvising an answer about your prices.',
        },
      ],
    },
    {
      ...newSection('features', 'tint'),
      kicker: 'Data protection',
      heading: 'UK data, UK law, and a record you can hand to a regulator.',
      items: [
        {
          heading: 'UK or EEA, and named in your contract',
          body: 'Conversations, knowledge and personal data are held in the United Kingdom or '
            + 'the European Economic Area, and the region your account runs in is written into '
            + 'your data processing agreement rather than asserted on a web page. If you need '
            + 'UK only, say so before you sign: it is answerable, and it is answerable in the '
            + 'contract, which is the only place an answer to that question is worth anything.',
        },
        {
          heading: 'Lawful basis, recorded per conversation',
          body: 'The visitor is told it is an AI before anything else, and asked before it '
            + 'checks whether it already knows them. The consent decision travels with the '
            + 'conversation and is recorded against it, rather than assumed from a banner they '
            + 'clicked on another page.',
        },
        {
          heading: 'A subject access request takes minutes',
          body: 'Everything held about one person is retrievable in one place, and erasable in '
            + 'one action. The thirty days the UK GDPR allows you is not the constraint. '
            + 'Finding it usually is.',
        },
        {
          heading: 'Retention you set, and it honours',
          body: 'Transcripts, recordings and lead data each have their own retention period, '
            + 'set by you and enforced by the system rather than by somebody remembering to '
            + 'run a deletion.',
        },
        {
          heading: 'An audit trail that cannot be quietly edited',
          body: 'Every conversation and every decision is written to a chained record, so an '
            + 'entry cannot be altered afterwards without breaking every entry after it. That '
            + 'is what makes it evidence rather than a log.',
        },
        {
          heading: 'We never hold a card number',
          body: 'Payment details go straight to the payment provider and we keep only a '
            + 'reference. There is no card data here to lose.',
        },
      ],
    },
    {
      ...newSection('pricing', 'light'),
      kicker: 'Plans',
      heading: 'Ten answers are included. After that, 50p each.',
      lede:
        'The monthly fee includes \u00a35 of answers. Buy more in bundles when you need them, '
        + 'and they get cheaper the more you buy, down to 35p an answer.\n\n'
        + 'Every plan carries the same safeguards. There is no tier where the assistant is '
        + 'allowed to be less careful.',
    },
    {
      ...newSection('demo', 'light'),
      kicker: 'When you need us',
      heading: 'Support that answers, rather than acknowledging receipt.',
      mediaSrc: '/media/demo-support.webm',
      mediaPoster: '/media/demo-support.png',
      mediaDescription:
        'The support area inside your account. Ask in your own words and it answers from '
        + 'Detent\u2019s own documentation: how to brand it, how to install it, what '
        + 'happens when you run out of credits. Where it has no answer it says so and puts you '
        + 'through to a person rather than guessing.',
    },
    {
      ...newSection('faq', 'tint'),
      heading: 'The questions we are asked first.',
      items: [
        {
          heading: 'How long does it take to set up?',
          body: 'An afternoon. Upload your documentation, approve what the knowledge agent '
            + 'proposes, paste one line into your site. Most of that time is the approving.',
        },
        {
          heading: 'What if it says something wrong?',
          body: 'It is built so the common ways of being wrong cannot happen: it cannot state an '
            + 'unapproved figure, cannot claim something you have not shipped, and offers a person '
            + 'rather than guessing. Everything it says is logged and replayable.',
        },
        {
          heading: 'Do we need a developer?',
          body: 'To install it, no: it is one script tag, and your CRM connects by signing in. '
            + 'A developer helps if you want it on a heavily customised site.',
        },
        {
          heading: 'Will it look like our brand?',
          body: 'Yes. Your logo and colour, whatever shape your logo is. Visitors see you, not us.',
        },
        {
          heading: 'If you charge per reply, is it not encouraged to waffle?',
          body: 'It is the first thing a commercial buyer asks, and the answer is in the '
            + 'pricing rather than in a promise. Only six replies are chargeable in any one '
            + 'conversation, so a longer exchange earns us nothing. A reply that says it does '
            + 'not know is free. And the assistant hands over to a person the moment it has no '
            + 'approved answer, which ends the conversation rather than extending it.',
        },
        {
          heading: 'What does it cost in a quiet month?',
          body: '\u00a39.99. The first ten answers are included, and if nobody asks it anything '
            + 'you pay nothing beyond the subscription. A reply where it had no answer and put '
            + 'the visitor through to a person is never charged.',
        },
      ],
    },
    {
      ...newSection('cta', 'ink'),
      heading: 'Ask it yourself.',
      lede:
        'The assistant on this page is the product, set up the same way yours would be. Ask it '
        + 'something awkward.',
      primaryActionLabel: 'Start free',
      primaryActionHref: `${appBaseUrl}/signup`,
    },
  ];

  return pages.reseed({ ...page, sections, revision: MARKETING_COPY_REVISION });
}

/**
 * The partner programme page.
 *
 * Written for a different reader from the home page: not a business that wants
 * an assistant, but one that wants a product to sell. What they care about, in
 * the order they care about it, is whether the territory is really theirs,
 * what they earn, whether leads come with it, and what they are on the hook
 * for when a customer has a problem at four o'clock on a Friday.
 *
 * The support obligation is stated plainly rather than buried. A reseller who
 * discovers first-line support after signing is a reseller who stops selling.
 */
export async function seedResellerPage(
  pages: PageService,
  appBaseUrl: string,
): Promise<SeedOutcome> {
  const page = {
    slug: 'become-a-reseller',
    title: 'Become a Detent reseller: your own territory, up to 50%',
    description:
      'Sell Detent in a postcode area that is yours alone. Commission of 20% to 50% by volume, '
      + 'paid monthly, with leads in your area passed to you.',
    navLabel: 'Partners',
    navOrder: 40,
  };

  const sections = [
    {
      ...newSection('hero', 'ink'),
      heading: 'One postcode area. Yours, and nobody else\u2019s.',
      lede:
        'Every business with a website is losing enquiries overnight, and almost none of them '
        + 'know it. Sell them the thing that answers, in a territory we will not sell into '
        + 'behind you.',
      primaryActionLabel: 'Apply for a territory',
      primaryActionHref: '#apply',
      secondaryActionLabel: 'See what it does',
      secondaryActionHref: '/home',
    },
    {
      ...newSection('features', 'light'),
      kicker: 'The offer',
      heading: 'What you get.',
      items: [
        {
          heading: 'An exclusive postcode area',
          body: 'Your area is granted to you and to nobody else. We do not appoint a second '
            + 'reseller in it, and we do not sell into it around you. An area already held '
            + 'cannot be granted twice. The system refuses it rather than leaving two '
            + 'people to find out the hard way.',
        },
        {
          heading: 'Leads in your area, passed to you',
          body: 'An enquiry that reaches us from a postcode in your territory is yours. It is '
            + 'routed on the postcode, not on who asked for it first.',
        },
        {
          heading: 'Commission from 20% to 50%',
          body: 'You start at 20%. The rate rises with what you have sold, to 30%, 40% and 50%. '
            + 'It is decided on your whole book rather than on one quiet month, and once you '
            + 'reach a band it applies to everything in the period.',
        },
        {
          heading: 'Paid monthly',
          body: 'Commission is paid every month on what your customers have actually paid. You '
            + 'see what is collected and what is still outstanding, so nothing is a surprise '
            + 'and nothing is clawed back later.',
        },
        {
          heading: 'Marketing support',
          body: 'Campaign material, the product\u2019s own site to point at, and copy you can put '
            + 'your name on. You are not left to invent how to explain it.',
        },
        {
          heading: 'A human at Detent, not a queue',
          body: 'You get direct access to our support desk, staffed by people. You are a partner, '
            + 'not a ticket.',
        },
      ],
    },
    {
      ...newSection('steps', 'tint'),
      kicker: 'The rates',
      heading: 'How the commission bands work.',
      lede:
        'The band is decided on what your customers have actually paid you commission on, '
        + 'across your whole book. It never falls because a single customer had a quiet month.',
      items: [
        { heading: 'Registered, 20%', body: 'Where every reseller starts, from the first sale.' },
        { heading: 'Silver, 30%', body: 'Once your book passes \u00a32,500 collected.' },
        { heading: 'Gold, 40%', body: 'Once your book passes \u00a310,000 collected.' },
        { heading: 'Principal, 50%', body: 'Once your book passes \u00a325,000 collected.' },
      ],
    },
    {
      ...newSection('contrast', 'light'),
      kicker: 'Support',
      heading: 'Who answers when a customer has a problem.',
      lede:
        'Worth understanding before you sign rather than after. Most questions never reach a '
        + 'person at all.',
      items: [
        {
          column: 'left' as const,
          heading: 'The assistant answers first',
          body: 'The product answers the customer\u2019s own question from their own approved '
            + 'knowledge. Most queries end here, and neither of us hears about them.',
        },
        {
          column: 'left' as const,
          heading: 'You are first line',
          body: 'What the assistant cannot settle comes to you. You know the customer, you sold '
            + 'them the thing, and you are the reason they trusted it.',
        },
        {
          column: 'right' as const,
          heading: 'We are second line',
          body: 'Anything genuinely ours (the platform, a defect, something you have not seen '
            + 'before) comes straight to our desk, to a person, without a queue.',
        },
        {
          column: 'right' as const,
          heading: 'You are never left holding it',
          body: 'First line does not mean alone. It means the customer has one number to ring, '
            + 'and it is yours, which is most of why they buy from you rather than from us.',
        },
      ],
    },
    {
      ...newSection('demo', 'light'),
      kicker: 'What you are selling',
      heading: 'Everything is managed from one place.',
      mediaSrc: '/media/demo-console.webm',
      mediaPoster: '/media/demo-console.png',
      mediaDescription:
        'The back office, where pages, pricing, accounts and the channel are all managed. Your '
        + 'own portal shows your customers, what they have spent, which band you are in and '
        + 'what is still outstanding, worked out from the same figures we pay you '
        + 'against, so there is nothing to reconcile.',
    },
    {
      ...newSection('statement', 'ink'),
      heading:
        'Half of what your customers pay, in an area nobody else can sell into. '
        + 'That is the deal, and it is the same deal for everyone.',
    },
    {
      ...newSection('faq', 'light'),
      heading: 'What partners ask first.',
      items: [
        {
          heading: 'What happens if my area is already taken?',
          body: 'We will tell you straight away, and offer you what is next to it. We will not '
            + 'put you into an area somebody already holds.',
        },
        {
          heading: 'Do I need to be technical?',
          body: 'No. Installing is one line of HTML, and the AI does the setup by reading the '
            + 'customer\u2019s own documentation. If you can sell a website, you can sell this.',
        },
        {
          heading: 'What if a customer does not pay?',
          body: 'You are not paid commission on it, and it is not clawed back from you later '
            + 'either, because we never paid it in the first place. You can see what is '
            + 'outstanding in your portal and chase it yourself if you want to.',
        },
        {
          heading: 'Can I set my own prices?',
          body: 'You sell at our published price and take your commission from it. That keeps '
            + 'the product worth the same everywhere and stops two resellers competing on '
            + 'discount rather than on service.',
        },
        {
          heading: 'What happens to my customers if I stop?',
          body: 'They stay yours until the agreement ends, and commission you have already '
            + 'earned stays earned. Nothing is reassigned retrospectively.',
        },
      ],
    },
    {
      ...newSection('cta', 'tint'),
      heading: 'Which area do you want?',
      lede:
        'Tell us the postcode area and what you sell today. If it is free, it is yours; if it '
        + 'is not, we will say so rather than sell you a territory twice.',
      primaryActionLabel: 'Apply for a territory',
      primaryActionHref: `${appBaseUrl}/signup?interest=reseller`,
      secondaryActionLabel: 'Ask the assistant',
      secondaryActionHref: '#',
    },
  ];

  return pages.reseed({ ...page, sections, revision: MARKETING_COPY_REVISION });
}
