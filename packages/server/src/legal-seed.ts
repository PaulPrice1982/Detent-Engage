import { newSection, type PageService, type SeedOutcome } from '@detent/awa-cms';
import { MARKETING_COPY_REVISION } from './marketing-seed.js';

/**
 * The privacy statement, the terms of use and the cookie policy.
 *
 * Seeded like every other page, so they are editable in the console and carry
 * the same revision mechanism: a lawyer's redraft replaces them and is never
 * overwritten by a later release.
 *
 * **This is a first draft written from what the software actually does, not
 * legal advice.** Its value is that every factual claim in it was checked
 * against the code rather than copied from a template: the cookies named are
 * the cookies the platform sets, the sub-processors named are the services it
 * calls, and the retention periods are the ones the software enforces. A
 * solicitor reviewing it is correcting wording, not discovering the product.
 *
 * One finding shapes the whole cookie policy. The platform sets three cookies,
 * all of them session cookies for signed-in areas, and the widget stores
 * nothing at all on a visitor's device: no analytics, no beacons, no local
 * storage. Under PECR, strictly necessary cookies require clear information and
 * no consent, so there is no banner here. Adding one where none is required
 * teaches people to dismiss the ones that matter. If analytics are ever added,
 * that changes and a banner becomes necessary.
 */

/** Named once so a change of address does not have to be found in nine places. */
const CONTACT = 'privacy@detent.co.uk';
const COMPANY = 'Detent';

export async function seedPrivacyPage(pages: PageService): Promise<SeedOutcome> {
  const sections = [
    {
      ...newSection('hero', 'ink'),
      heading: 'Privacy statement',
      lede:
        'What we hold, why we are allowed to hold it, how long we keep it, and what you can '
        + 'make us do about it. Written to be read rather than to be survived.',
    },
    {
      ...newSection('prose', 'light'),
      heading: 'Who is responsible for your data',
      items: [{
        body:
          `${COMPANY} is the controller for the personal data of visitors to this website, of `
          + 'people who open an account with us, and of resellers in our partner programme. You '
          + `can reach us about any of it at ${CONTACT}.\n\n`
          + 'Where a customer uses Detent on their own website, the position is different and '
          + 'the distinction matters. The customer is the controller of the conversations that '
          + 'happen there, and we are their processor: we handle that data on their written '
          + 'instructions, under a data processing agreement, and for no purpose of our own. We '
          + 'do not use one customer’s conversations to improve another’s assistant, '
          + 'and we do not use them to train a model.',
      }],
    },
    {
      ...newSection('prose', 'tint'),
      heading: 'What we hold, and why we are allowed to',
      items: [{
        body:
          'Account data, meaning your name, work email address, company and the plan you are '
          + 'on. We hold it to provide the service you asked for, which is the performance of '
          + 'our contract with you.\n\n'
          + 'Billing data, meaning invoices, credits and payment references. Card numbers never '
          + 'reach us: our payment provider holds those and gives us a token, which is why we '
          + 'cannot show you your card and could not leak it if we tried. We hold billing '
          + 'records because tax law requires us to.\n\n'
          + 'Conversation data, meaning what a visitor typed, what the assistant answered, and '
          + 'anything they chose to give us such as an email address. On a customer’s site '
          + 'this belongs to the customer and we hold it as their processor. On our own site we '
          + 'are the controller and our basis is our legitimate interest in answering people who '
          + 'ask us questions, with identification of a visitor never assumed and always asked '
          + 'for.\n\n'
          + 'Technical data, meaning IP address, the pages requested and the time of the '
          + 'request. We hold it to keep the service secure and working, which is our legitimate '
          + 'interest, and we do not build a profile from it.',
      }],
    },
    {
      ...newSection('prose', 'light'),
      heading: 'Consent, and what we ask before we ask it',
      items: [{
        body:
          'The assistant says it is an AI before anybody types anything. That is not a setting '
          + 'and it cannot be turned off, including by us.\n\n'
          + 'Before it checks whether it already knows a visitor, it asks. The exact wording '
          + 'shown is stored with the answer, so what somebody agreed to is a matter of record '
          + 'rather than of recollection. A refusal is recorded as carefully as an agreement, '
          + 'and the conversation carries on without identification. Withdrawing consent is a '
          + 'new decision that supersedes the old one; the old one is not deleted, because the '
          + 'evidence that you once agreed is part of the evidence that we asked.',
      }],
    },
    {
      ...newSection('prose', 'tint'),
      heading: 'Who else touches it',
      items: [{
        body:
          'We use a small number of sub-processors, each for one job:\n\n'
          + 'Our hosting and database provider, which runs the service and stores its data. Our '
          + 'model provider, which turns approved knowledge into a sentence and receives the '
          + 'question and the approved material, never your account or billing data. Our payment '
          + 'provider, which takes payments and holds card details so that we do not. Our email '
          + 'provider, which delivers sign-in and notification email.\n\n'
          + 'We do not sell data, we do not share it with advertisers, and there is no '
          + 'advertising technology anywhere in this product. The current list of sub-processors '
          + `is available on request at ${CONTACT}, and customers are told before it changes.`,
      }],
    },
    {
      ...newSection('prose', 'light'),
      heading: 'Where it is held',
      items: [{
        body:
          'The service runs in the United Kingdom or the European Economic Area, and the '
          + 'specific region for your account is stated in your data processing agreement rather '
          + 'than assumed here, because it is a fact about your deployment and not a slogan.\n\n'
          + 'Where a sub-processor is outside the UK or the EEA, the transfer is covered by the '
          + 'UK International Data Transfer Addendum or the Standard Contractual Clauses, and we '
          + 'will tell you which applies to which supplier if you ask. If you require that no '
          + 'personal data leaves the United Kingdom at all, tell us before you sign: it is '
          + 'answerable, and it is answerable in the contract rather than in a paragraph on a '
          + 'website.',
      }],
    },
    {
      ...newSection('prose', 'tint'),
      heading: 'How long we keep it',
      items: [{
        body:
          'Conversations are kept for as long as the customer who owns them chooses. The '
          + 'retention period is theirs to set and the software enforces it rather than '
          + 'reminding somebody to.\n\n'
          + 'Account data is kept while you have an account and for twelve months afterwards, so '
          + 'that a closed account can be reopened without starting again. Billing records are '
          + 'kept for six years, which is what UK tax law requires and is not ours to shorten. '
          + 'Consent evidence and the audit trail are kept for as long as the data they describe, '
          + 'because evidence that outlives the thing it is evidence of is the only useful kind.',
      }],
    },
    {
      ...newSection('prose', 'light'),
      heading: 'What you can make us do',
      items: [{
        body:
          'Under the UK GDPR you can ask for a copy of what we hold about you, ask us to correct '
          + 'it, ask us to delete it, ask us to restrict what we do with it, ask for it in a '
          + 'portable form, and object to processing we are doing on the basis of legitimate '
          + 'interest. Where we rely on consent you can withdraw it at any time, and that does '
          + 'not make what we did beforehand unlawful.\n\n'
          + `Ask at ${CONTACT}. We answer within one month, which is the statutory deadline, and `
          + 'usually inside a week: everything held about one person is retrievable in one place '
          + 'and erasable in one action, so the thirty days are not the constraint. Finding it '
          + 'usually is, and we built the software so that it is not.\n\n'
          + 'If a customer is the controller (your conversation was on their website rather than '
          + 'ours), we will pass your request to them and help them answer it, because it is '
          + 'their decision to make and not ours.\n\n'
          + 'If you are not satisfied you can complain to the Information Commissioner’s '
          + 'Office at ico.org.uk. We would rather you told us first, but you are not required to.',
      }],
    },
    {
      ...newSection('prose', 'tint'),
      heading: 'Automated decisions',
      items: [{
        body:
          'The assistant answers questions and suggests next steps. It does not make a decision '
          + 'that produces a legal effect for you or something similarly significant, and it has '
          + 'no ability to refuse you a service, a price or a credit line on its own.\n\n'
          + 'It answers only from material a person at the company has approved, and it says so '
          + 'when it does not know rather than guessing. Where a question needs a person, it '
          + 'hands over and says it is doing so.',
      }],
    },
    {
      ...newSection('prose', 'light'),
      heading: 'Security, and telling you when it goes wrong',
      items: [{
        body:
          'Data is encrypted in transit and at rest. Access to production is limited to the '
          + 'people who need it and is logged. Every conversation is recorded in a tamper-evident '
          + 'audit trail, so an answer to "what did it say in March" is a lookup rather than an '
          + 'investigation.\n\n'
          + 'If a breach happens and it is likely to be a risk to people, we tell the ICO within '
          + '72 hours and we tell the people affected without undue delay. We would tell our '
          + 'customers first, because they have their own regulator to answer to and finding out '
          + 'from a news story is not a service.',
      }],
    },
    {
      ...newSection('prose', 'tint'),
      heading: 'Changes to this statement',
      items: [{
        body:
          'When this changes materially we tell account holders by email before it takes effect, '
          + 'rather than changing a date at the bottom of a page and calling it notice. The '
          + 'version you agreed to is the version we hold you to until you have been told '
          + 'otherwise.',
      }],
    },
    {
      ...newSection('cta', 'ink'),
      heading: 'Ask us anything about this.',
      lede: `A real person answers ${CONTACT}, usually the same day.`,
      primaryActionLabel: 'Read the terms of use',
      primaryActionHref: '/terms',
      secondaryActionLabel: 'Read the cookie policy',
      secondaryActionHref: '/cookies',
    },
  ];

  return pages.reseed({
    slug: 'privacy',
    title: 'Privacy statement',
    description:
      'What Detent holds, why, how long for, and what you can make us do about it. UK GDPR, '
      + 'in plain words.',
    sections,
    revision: MARKETING_COPY_REVISION,
  });
}

export async function seedTermsPage(pages: PageService): Promise<SeedOutcome> {
  const sections = [
    {
      ...newSection('hero', 'ink'),
      heading: 'Terms of use',
      lede:
        'The agreement between you and us. Short, because a long one is a long one nobody read.',
    },
    {
      ...newSection('prose', 'light'),
      heading: 'Who these are between',
      items: [{
        body:
          `These terms are between ${COMPANY} and the person or company using the service. Using `
          + 'it means accepting them. If you are accepting on behalf of a company, you are '
          + 'confirming you may bind it.\n\n'
          + 'Where we have signed a separate written agreement with you, that agreement wins '
          + 'wherever the two disagree.',
      }],
    },
    {
      ...newSection('prose', 'tint'),
      heading: 'What you are buying',
      items: [{
        body:
          'An assistant that answers your website visitors from knowledge you have approved, and '
          + 'writes what it learns to your systems.\n\n'
          + 'The subscription is £9.99 a month. On top of that you pay 50p each time the '
          + 'assistant answers somebody, capped at six charged replies in any one conversation, '
          + 'so no single visitor can cost you more than £3. You are not charged when the '
          + 'assistant has no answer and hands over to a person. Credits are bought in bundles '
          + 'and are used oldest first.\n\n'
          + 'You set a monthly ceiling. Above it the assistant stops rather than bills. That is '
          + 'a hard limit and it is on your side of the argument, not ours.',
      }],
    },
    {
      ...newSection('prose', 'light'),
      heading: 'Prices, and what a price change cannot do',
      items: [{
        body:
          'The price you were sold on is the price you keep. A subscription is pinned to the '
          + 'plan version it was bought under and to the fee agreed at the time, and a later '
          + 'change to our published prices does not reach it. If we change what you pay we tell '
          + 'you at least 30 days beforehand and you may cancel before it takes effect.\n\n'
          + 'Credits do not expire while your subscription is live. If you cancel, unused credits '
          + 'are available for 12 months in case you come back, and are not refundable in cash.\n\n'
          + 'Fees are exclusive of VAT. Invoices are due on issue and we may suspend the service '
          + 'if one is 14 days overdue, after telling you.',
      }],
    },
    {
      ...newSection('prose', 'tint'),
      heading: 'What the assistant says, and who is answerable for it',
      items: [{
        body:
          'The assistant answers only from knowledge that somebody at your company has approved. '
          + 'That is the design, and it is also the allocation of responsibility: you are '
          + 'answerable for the material you approve, exactly as you would be for a page on your '
          + 'own website or a sentence from your own salesperson.\n\n'
          + 'We are answerable for the assistant behaving as described: answering from approved '
          + 'material, refusing to invent a figure, saying it is an AI, and handing over when it '
          + 'does not know. If it does something other than that, it is our problem and we will '
          + 'fix it.\n\n'
          + 'Nothing the assistant says is advice, and it does not form a contract on your behalf '
          + 'unless you have configured it to and told us so in writing.',
      }],
    },
    {
      ...newSection('prose', 'light'),
      heading: 'What you must not do with it',
      items: [{
        body:
          'Do not use it to break the law, to send unsolicited marketing to people who have not '
          + 'agreed to it, or to handle special category data (health, biometrics, beliefs, and '
          + 'the rest of Article 9) without telling us first so we can agree how.\n\n'
          + 'Do not attempt to make it produce material you have not approved, do not use it to '
          + 'impersonate somebody, and do not resell it as your own product unless you are in '
          + 'our partner programme, which exists precisely so that you can.\n\n'
          + 'Do not attack it. Testing your own instance for security problems is welcome and we '
          + 'would like to hear what you find.',
      }],
    },
    {
      ...newSection('prose', 'tint'),
      heading: 'Your data, and what happens to it if you leave',
      items: [{
        body:
          'Your knowledge, your conversations and your CRM data remain yours. We hold them as '
          + 'your processor under the data processing agreement that accompanies these terms, and '
          + 'we do not use them for any purpose of our own. We do not train models on them.\n\n'
          + 'You can export everything at any time, while you are a customer and for 30 days '
          + 'after you stop being one. After that we delete it, other than what we are required '
          + 'to keep for tax or legal reasons, and we tell you what that is if you ask.',
      }],
    },
    {
      ...newSection('prose', 'light'),
      heading: 'Availability, and what we do when it is not available',
      items: [{
        body:
          'We aim for the service to be available at all times and we do not pretend that is the '
          + 'same as a guarantee. Planned maintenance is announced beforehand. Where we have '
          + 'agreed a service level with you in writing, that is what applies and this paragraph '
          + 'is not it.\n\n'
          + 'Support is by email, answered by a person. Resellers have a direct route to our desk '
          + 'as second line behind their own.',
      }],
    },
    {
      ...newSection('prose', 'tint'),
      heading: 'Ending it',
      items: [{
        body:
          'You may cancel at any time, effective at the end of the month you have paid for. We '
          + 'do not require notice periods and we do not make cancelling harder than starting.\n\n'
          + 'We may end the agreement if you do not pay after we have asked, if you use the '
          + 'service in a way these terms forbid, or if you become insolvent. Other than for '
          + 'non-payment or misuse, we will give you 30 days.',
      }],
    },
    {
      ...newSection('prose', 'light'),
      heading: 'Liability',
      items: [{
        body:
          'Neither of us excludes liability for death or personal injury caused by negligence, '
          + 'for fraud, or for anything else the law does not permit to be excluded. That is not '
          + 'a courtesy, it is the law, and a contract that pretends otherwise is unenforceable '
          + 'in the parts that matter.\n\n'
          + 'Beyond that, our total liability in any twelve month period is limited to the fees '
          + 'you paid us in that period. Neither of us is liable to the other for loss of profit, '
          + 'loss of business or indirect loss.\n\n'
          + 'Nothing here limits either party’s obligations under data protection law, and '
          + 'the cap above does not apply to your obligation to pay for what you have used.',
      }],
    },
    {
      ...newSection('prose', 'tint'),
      heading: 'Everything else',
      items: [{
        body:
          'We own the software; you own your content. Neither of us gets rights in the other’s '
          + 'material beyond what is needed to run the service.\n\n'
          + 'We will tell you at least 30 days before we change these terms materially, and you '
          + 'may cancel if you do not accept the change. A change we make without telling you '
          + 'does not bind you.\n\n'
          + 'These terms are governed by the law of England and Wales, and the courts of England '
          + 'and Wales have exclusive jurisdiction.',
      }],
    },
    {
      ...newSection('cta', 'ink'),
      heading: 'Questions about any of this?',
      lede: 'Ask before you sign rather than after. We would rather answer it now.',
      primaryActionLabel: 'Read the privacy statement',
      primaryActionHref: '/privacy',
      secondaryActionLabel: 'Read the cookie policy',
      secondaryActionHref: '/cookies',
    },
  ];

  return pages.reseed({
    slug: 'terms',
    title: 'Terms of use',
    description:
      'The agreement between you and Detent: what you are buying, what it costs, who is '
      + 'answerable for what, and how to leave.',
    sections,
    revision: MARKETING_COPY_REVISION,
  });
}

export async function seedCookiePage(pages: PageService): Promise<SeedOutcome> {
  const sections = [
    {
      ...newSection('hero', 'ink'),
      heading: 'Cookies',
      lede:
        'There is no banner on this site. That is not an oversight, and this page explains '
        + 'exactly why there is nothing to consent to.',
    },
    {
      ...newSection('prose', 'light'),
      heading: 'Why you were not asked',
      items: [{
        body:
          'UK law (the Privacy and Electronic Communications Regulations) requires consent before '
          + 'a website stores anything on your device, with one exception: what is strictly '
          + 'necessary to provide the service you asked for. Session cookies that keep you signed '
          + 'in are the textbook example of the exception.\n\n'
          + 'Every cookie this site sets falls under it. There is no analytics, no advertising '
          + 'technology, no tracking pixel and no third-party script anywhere on this site. So '
          + 'there is nothing to ask you about, and a banner asking anyway would be theatre. '
          + 'Being asked to consent to things that need no consent is how people learn to click '
          + 'the button without reading it.\n\n'
          + 'If we ever add analytics, this changes, you will be asked properly, and nothing '
          + 'will be set until you have answered.',
      }],
    },
    {
      ...newSection('table', 'tint'),
      heading: 'Every cookie this site sets. All of them.',
      columns: ['Cookie', 'What it does', 'How long it lasts', 'Consent needed'],
      rows: [
        ['__Host-detent_app', 'Keeps you signed in to your Detent account.',
          '8 hours, or until you sign out', 'No, strictly necessary'],
        ['__Host-detent_console', 'Keeps a member of Detent staff signed in to the back office.',
          '8 hours, or until they sign out', 'No, strictly necessary'],
        ['__Host-detent_reseller', 'Keeps a partner signed in to their reseller portal.',
          '8 hours, or until they sign out', 'No, strictly necessary'],
      ],
    },
    {
      ...newSection('prose', 'light'),
      heading: 'What the assistant stores on a visitor’s device',
      items: [{
        body:
          'Nothing. The assistant that runs on this page, and on our customers’ pages, sets '
          + 'no cookie, writes nothing to local storage, and leaves no identifier behind. A '
          + 'conversation is held on our servers against a reference the page holds only while '
          + 'the tab is open.\n\n'
          + 'This matters most to our customers, who are the ones who would have to disclose it. '
          + 'Installing Detent does not add a cookie to your site, does not change your own '
          + 'cookie banner, and does not put you in a worse position with your regulator than '
          + 'you were in yesterday. Very few products in this category can say that, and it is '
          + 'worth checking against the ones that claim it.',
      }],
    },
    {
      ...newSection('prose', 'tint'),
      heading: 'Refusing them anyway',
      items: [{
        body:
          'Your browser can block cookies from any site, including this one. If you block ours, '
          + 'the public pages work exactly as they do now and the assistant answers exactly as it '
          + 'does now. You will not be able to sign in to an account, because staying signed in '
          + 'is what the cookie is for.',
      }],
    },
    {
      ...newSection('cta', 'ink'),
      heading: 'That is the whole of it.',
      lede: 'Three cookies, all necessary, no tracking. If that changes, this page changes first.',
      primaryActionLabel: 'Read the privacy statement',
      primaryActionHref: '/privacy',
      secondaryActionLabel: 'Read the terms of use',
      secondaryActionHref: '/terms',
    },
  ];

  return pages.reseed({
    slug: 'cookies',
    title: 'Cookie policy',
    description:
      'Three cookies, all of them strictly necessary, no analytics and no tracking. Which is '
      + 'why this site has no cookie banner.',
    sections,
    revision: MARKETING_COPY_REVISION,
  });
}
