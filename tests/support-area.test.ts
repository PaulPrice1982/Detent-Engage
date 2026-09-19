import { describe, expect, it } from 'vitest';
import {
  SUPPORT_ARTICLES, SupportAgent, SupportRequestService,
  articleBySlug, articleText,
} from '@detent/awa-support';

const agent = new SupportAgent();

describe('the support assistant answers from its articles', () => {
  it('ranks the right article first for a question in the customer\'s own words', () => {
    // None of these is the article's title. A support search that only works
    // when the customer already knows the heading is a table of contents.
    //
    // This asserts ranking, not confidence. Whether the assistant leads with
    // one article or offers a choice is a separate decision, tested below:
    // "csp is blocking the script" genuinely could be either the policy
    // article or the one about the assistant not appearing, and offering both
    // is the right answer rather than a failure to rank.
    const cases: readonly [string, string][] = [
      ['how do I change our logo', 'put-our-logo-on-the-widget'],
      ['the widget is not showing on our site', 'the-assistant-does-not-appear'],
      ['when do we get invoiced', 'when-are-we-billed'],
      ['it made something up', 'it-answers-wrongly'],
      ['csp is blocking the script', 'content-security-policy'],
      ['we are locked out and no reset email came', 'password-reset-email-not-arriving'],
      ['does it work with react', 'single-page-app'],
      ['how many conversations have we used', 'where-do-i-see-usage-credits'],
      ['can it make up a discount', 'can-it-quote-prices'],
      ['where is our data held', 'where-is-our-data-stored'],
    ];
    for (const [asked, expected] of cases) {
      expect(agent.search(asked)[0]?.article.slug, `asked: ${asked}`).toBe(expected);
    }
  });

  it('leads with one article when the question is unambiguous', () => {
    for (const [asked, expected] of [
      ['how do I change our logo', 'put-our-logo-on-the-widget'],
      ['the widget is not showing on our site', 'the-assistant-does-not-appear'],
      ['it made something up', 'it-answers-wrongly'],
    ] as const) {
      const answer = agent.ask(asked);
      expect(answer.outcome, `asked: ${asked}`).toBe('answered');
      expect(answer.article?.slug, `asked: ${asked}`).toBe(expected);
    }
  });

  it('offers the choice rather than guessing when two articles score alike', () => {
    // A near-tie means the question was ambiguous, not that the leader is
    // right. Picking one and hiding the other is a guess made on the
    // customer's behalf; showing both costs a click and no trust.
    const answer = agent.ask('csp is blocking the script');
    expect(answer.outcome).toBe('ambiguous');
    expect(answer.matches.length).toBeGreaterThan(1);
  });

  it('admits it has nothing rather than offering the nearest article', () => {
    // The failure this pins: "what" appears in half the corpus, so a question
    // sharing nothing but that word scored above the floor and was offered as
    // an answer. An assistant that always answers is wrong precisely on the
    // unusual questions, which are the ones worth asking.
    const nonsense = agent.ask('what is the airspeed velocity of an unladen swallow');
    expect(nonsense.outcome).toBe('unanswered');
    expect(nonsense.matches).toHaveLength(0);
    expect(nonsense.offerHuman).toBe(true);

    const outOfScope = agent.ask('can you integrate with sap hana and rebuild our warehouse');
    expect(outOfScope.outcome).toBe('unanswered');
  });

  it('requires more than one word of a long question to match', () => {
    // A single shared word between a long question and a long article is a
    // coincidence, not an understanding.
    expect(agent.search('logo').length).toBeGreaterThan(0); // one word, allowed
    expect(agent.ask('please tell me about elephants in the wild').outcome).toBe('unanswered');
  });

  it('offers the choice when two articles match alike', () => {
    const answer = agent.ask('logo');
    // 'logo' matches both the how-to and the shape guidance. Either could be
    // meant, so both are shown rather than one being picked on the customer's
    // behalf.
    expect(answer.matches.length).toBeGreaterThan(1);
  });

  it('always offers a person, even when it answered', () => {
    // An assistant that only offers help after it has failed leaves the
    // customer it answered badly with nowhere to go.
    expect(agent.ask('how do I change our logo').offerHuman).toBe(true);
  });

  it('never returns an empty answer for an empty question', () => {
    expect(agent.ask('   ').outcome).toBe('unanswered');
    expect(agent.ask('   ').offerHuman).toBe(false); // nothing was asked yet
  });
});

describe('the article set itself', () => {
  it('has unique slugs', () => {
    const slugs = SUPPORT_ARTICLES.map((article) => article.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('gives every article a question, an answer and a topic', () => {
    for (const article of SUPPORT_ARTICLES) {
      expect(article.question.trim().length, article.slug).toBeGreaterThan(0);
      expect(article.answer.trim().length, article.slug).toBeGreaterThan(0);
      expect(article.slug).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('gives every how-to actual steps', () => {
    // A how-to without steps is a FAQ that has been mislabelled, and it is
    // shown to the customer under a heading promising instructions.
    for (const article of SUPPORT_ARTICLES.filter((one) => one.kind === 'how-to')) {
      expect(article.steps?.length, article.slug).toBeGreaterThan(0);
    }
  });

  it('points every in-product link at a real customer path', () => {
    for (const article of SUPPORT_ARTICLES) {
      if (!article.link) continue;
      expect(article.link.href, article.slug).toMatch(/^\/app\//);
    }
  });

  it('indexes the alternative phrasings', () => {
    const article = articleBySlug('the-assistant-does-not-appear')!;
    expect(articleText(article)).toContain('widget not showing');
  });
});

describe('support requests', () => {
  it('refuses a request with no detail', async () => {
    const service = new SupportRequestService();
    await expect(service.raise({
      tenantId: 't_1', accountId: 'acct_1', raisedBy: 'a@b.c',
      subject: 'Broken', detail: '   ',
    })).rejects.toThrow();
  });

  it('shows an account only its own requests', async () => {
    // A support request carries what the customer was doing when something
    // went wrong, which is as sensitive as anything else in their account.
    const service = new SupportRequestService();
    await service.raise({
      tenantId: 't_1', accountId: 'acct_1', raisedBy: 'a@b.c',
      subject: 'Ours', detail: 'Our problem.',
    });
    const theirs = await service.raise({
      tenantId: 't_2', accountId: 'acct_2', raisedBy: 'x@y.z',
      subject: 'Theirs', detail: 'Their problem.',
    });

    const mine = await service.forAccount('acct_1');
    expect(mine).toHaveLength(1);
    expect(mine[0]?.subject).toBe('Ours');

    // Asking for another account's request by id is a not-found, not a denial:
    // distinguishing the two tells a caller which ids exist.
    await expect(service.get(theirs.requestId, 'acct_1')).rejects.toThrow(/No such request/);
  });

  it('records an answer against the request', async () => {
    const service = new SupportRequestService();
    const raised = await service.raise({
      tenantId: 't_1', accountId: 'acct_1', raisedBy: 'a@b.c',
      subject: 'Question', detail: 'Detail.',
    });
    expect(await service.open()).toHaveLength(1);
    const answered = await service.answer(raised.requestId, 'Here is the answer.');
    expect(answered.state).toBe('answered');
    expect(await service.open()).toHaveLength(0);
  });
});
