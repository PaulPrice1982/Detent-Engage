import { describe, expect, it } from 'vitest';
import {
  NEW_WARMING_STATE, NO_INTENT, applyWarmingMove, classifyLeadType, classifySource,
  nextWarmingMove, routeLead, type IntentSignals, type KnowledgePoint,
} from '@detent/awa-agent';

const QUALIFIED = { score: 70, maxScore: 100, state: 'QUALIFIED' as const, missingRequired: [] };
const UNQUALIFIED = {
  score: 10, maxScore: 100, state: 'UNQUALIFIED' as const, missingRequired: ['need', 'timing'],
};
const DIRECT = classifySource({});
const intent = (over: Partial<IntentSignals> = {}): IntentSignals => ({ ...NO_INTENT, ...over });

describe('where a lead came from', () => {
  it('prefers the marketer\'s tag over the browser\'s referrer', () => {
    // A referrer is what the browser happened to send; a UTM is what somebody
    // deliberately tagged. When they disagree, the deliberate one wins.
    const source = classifySource({
      referrer: 'https://www.google.co.uk/', utmMedium: 'cpc',
      utmSource: 'linkedin', utmCampaign: 'q1-cro',
    });
    expect(source.channel).toBe('paid_social');
    expect(source.campaign).toBe('q1-cro');
  });

  it('recognises search and social by root domain, not exact host', () => {
    expect(classifySource({ referrer: 'https://www.google.co.uk/search?q=x' }).channel)
      .toBe('organic_search');
    expect(classifySource({ referrer: 'https://uk.linkedin.com/feed' }).channel)
      .toBe('organic_social');
    expect(classifySource({ referrer: 'https://someblog.example/post' }).channel)
      .toBe('referral');
  });

  it('reads a visit from our own site as direct, not as a referral', () => {
    const source = classifySource({
      referrer: 'https://www.detent.co.uk/pricing', ownHost: 'www.detent.co.uk',
    });
    expect(source.channel).toBe('direct');
    expect(source.referrerHost).toBeUndefined();
  });

  it('invents no campaign for an untagged visit', () => {
    const source = classifySource({ referrer: 'https://unknown.example/' });
    expect(source.channel).toBe('referral');
    expect(source.campaign).toBeUndefined();
  });
});

describe('the MQL and SQL line', () => {
  it('makes a lead an SQL on intent, whatever the score says', () => {
    // A visitor who asks for a call has told us more than any score can.
    // Holding them as an MQL because a box is unticked keeps a buyer waiting
    // behind a nurture sequence.
    const routing = routeLead({
      leadType: 'new_business', source: DIRECT,
      qualification: UNQUALIFIED, intent: intent({ askedForDemoOrCall: true }),
    });
    expect(routing.stage).toBe('SQL');
    expect(routing.notifyNow).toBe(true);
    expect(routing.reason).toMatch(/asked to see it/);
  });

  it('makes a fitting but uncommitted visitor an MQL, and does not chase them', () => {
    const routing = routeLead({
      leadType: 'new_business', source: DIRECT, qualification: QUALIFIED, intent: intent(),
    });
    expect(routing.stage).toBe('MQL');
    expect(routing.notifyNow).toBe(false);
    expect(routing.reason).toMatch(/[Nn]urture rather than chase/);
  });

  it('leaves an unqualified enquiry as an enquiry', () => {
    const routing = routeLead({
      leadType: 'new_business', source: DIRECT, qualification: UNQUALIFIED, intent: intent(),
    });
    expect(routing.stage).toBe('enquiry');
    expect(routing.reason).toMatch(/need, timing/);
  });

  it('does not tell sales to ring someone who already has a meeting', () => {
    const routing = routeLead({
      leadType: 'new_business', source: DIRECT, qualification: QUALIFIED,
      intent: intent({ meetingBooked: true }),
    });
    expect(routing.stage).toBe('SQL');
    expect(routing.notifyNow).toBe(false); // it is already in a diary
  });
});

describe('routing by what kind of enquiry it is', () => {
  it('routes an existing customer by type rather than scoring them as a lead', () => {
    // A customer with a problem is not a lead. Scoring them as one puts them
    // in a sales queue while their problem goes unanswered.
    const routing = routeLead({
      leadType: 'support', source: DIRECT, qualification: QUALIFIED,
      intent: intent({ askedAboutPrice: true }),
    });
    expect(routing.stage).toBe('enquiry');
    expect(routing.notifyNow).toBe(true);
  });

  it('recognises the kinds that must not reach a salesperson', () => {
    expect(classifyLeadType('I would like to apply for a job with you')).toBe('recruitment');
    expect(classifyLeadType('we offer seo and can help you rank')).toBe('vendor');
    expect(classifyLeadType('interested in becoming a reseller')).toBe('partner');
    expect(classifyLeadType('I cannot log in to our account')).toBe('support');
  });

  it('says unknown rather than guessing', () => {
    // An unrecognised conversation is worked as new business. Filing it
    // confidently as recruitment loses it for good, and the two mistakes do
    // not cost the same.
    expect(classifyLeadType('tell me more about what you do')).toBe('unknown');
    const routing = routeLead({
      leadType: 'unknown', source: DIRECT, qualification: QUALIFIED, intent: intent(),
    });
    expect(routing.stage).toBe('MQL'); // still worked
  });
});

const TEACH: KnowledgePoint = {
  chunkId: 'kc_1', title: 'Approvals', topics: ['contract approval'],
  text: 'Every answer is approved before it is used.',
};
const UPSELL: KnowledgePoint = {
  chunkId: 'kc_2', title: 'Voice', topics: ['contract approval'],
  text: 'It can speak as well as type.', commercial: true,
};

describe('educating without selling', () => {
  it('teaches something relevant before it suggests anything', () => {
    const move = nextWarmingMove({
      saidSoFar: 'how does contract approval work',
      available: [UPSELL, TEACH], state: NEW_WARMING_STATE,
      visitorAskedQuestion: true, visitorAskedForHuman: false, meetingBooked: false,
    });
    expect(move.kind).toBe('teach');
    expect(move.kind === 'teach' && move.point.chunkId).toBe('kc_1');
  });

  it('will not suggest anything before the visitor has been given something', () => {
    // A suggestion made before any value has been delivered is a pitch.
    const move = nextWarmingMove({
      saidSoFar: 'how does contract approval work',
      available: [UPSELL], state: NEW_WARMING_STATE,
      visitorAskedQuestion: true, visitorAskedForHuman: false, meetingBooked: false,
    });
    expect(move.kind).toBe('hold');
    expect(move.reason).toMatch(/pitch/);
  });

  it('suggests once, and never twice', () => {
    // The first suggestion reads as helpful. The second reads as a pitch, and
    // makes the visitor stop believing the first.
    const warmed = { ...NEW_WARMING_STATE, valueDelivered: true };
    const first = nextWarmingMove({
      saidSoFar: 'contract approval', available: [UPSELL], state: warmed,
      visitorAskedQuestion: false, visitorAskedForHuman: false, meetingBooked: false,
    });
    expect(first.kind).toBe('suggest');

    const after = applyWarmingMove(warmed, first);
    expect(after.suggested).toBe(true);
    // A suggestion is not value delivered: it is us talking about ourselves.
    expect(after.valueDelivered).toBe(true); // was already true

    const second = nextWarmingMove({
      saidSoFar: 'contract approval', available: [{ ...UPSELL, chunkId: 'kc_3' }], state: after,
      visitorAskedQuestion: false, visitorAskedForHuman: false, meetingBooked: false,
    });
    expect(second.kind).toBe('hold');
    expect(second.reason).toMatch(/feel like selling/);
  });

  it('says nothing that does not answer something the visitor raised', () => {
    // A point matching nothing the visitor said is a brochure paragraph.
    const move = nextWarmingMove({
      saidSoFar: 'do you work with schools',
      available: [TEACH, UPSELL], state: { ...NEW_WARMING_STATE, valueDelivered: true },
      visitorAskedQuestion: true, visitorAskedForHuman: false, meetingBooked: false,
    });
    expect(move.kind).toBe('hold');
  });

  it('requires every word of a multi-word topic, not just one', () => {
    const move = nextWarmingMove({
      saidSoFar: 'we have a contract with someone else',
      available: [TEACH], state: NEW_WARMING_STATE,
      visitorAskedQuestion: true, visitorAskedForHuman: false, meetingBooked: false,
    });
    // 'contract' alone must not match the topic 'contract approval'.
    expect(move.kind).toBe('hold');
  });

  it('stops entirely once a person is asked for or a meeting is booked', () => {
    const asked = nextWarmingMove({
      saidSoFar: 'contract approval', available: [TEACH], state: NEW_WARMING_STATE,
      visitorAskedQuestion: false, visitorAskedForHuman: true, meetingBooked: false,
    });
    expect(asked.kind).toBe('hold');

    const booked = nextWarmingMove({
      saidSoFar: 'contract approval', available: [TEACH],
      state: { ...NEW_WARMING_STATE, valueDelivered: true },
      visitorAskedQuestion: false, visitorAskedForHuman: false, meetingBooked: true,
    });
    expect(booked.kind).toBe('hold');
    expect(booked.reason).toMatch(/can spoil it/);
  });

  it('never repeats a point it has already made', () => {
    const state = applyWarmingMove(NEW_WARMING_STATE, {
      kind: 'teach', point: TEACH, reason: 'x',
    });
    expect(state.valueDelivered).toBe(true);
    const move = nextWarmingMove({
      saidSoFar: 'contract approval', available: [TEACH], state,
      visitorAskedQuestion: true, visitorAskedForHuman: false, meetingBooked: false,
    });
    expect(move.kind).toBe('hold');
  });
});
