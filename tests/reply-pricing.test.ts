import { describe, expect, it } from 'vitest';
import {
  CREDIT_BUNDLES, LIST_PENCE_PER_REPLY, PLAN_CATALOGUE, chargeForReply, checkBundles,
  creditValueOf, money, repliesAffordable, worstCaseConversationCost,
} from '@detent/awa-billing';

const answers = PLAN_CATALOGUE.answers;
const growth = PLAN_CATALOGUE.growth;

describe('the self-serve plan', () => {
  it('is £9.99 a month and 50p a reply', () => {
    expect(answers.platformFee.monthly.amount).toBe(999);
    expect(answers.outcomeFee.amount).toBe(50);
    expect(answers.outcomeBasis).toBe('assistant_reply');
  });

  it('includes enough credit for a quiet month to cost only the subscription', () => {
    // A customer should meet the per-reply rate on a small number, not on
    // their first real invoice.
    expect(repliesAffordable(answers, money(answers.includedCreditsPence))).toBe(10);
  });
});

describe('what a reply costs', () => {
  const charge = (already: number, answered = true) =>
    chargeForReply({ plan: answers, repliesAlreadyCharged: already, answeredFromKnowledge: answered });

  it('charges 50p for a reply that answered', () => {
    const first = charge(0);
    expect(first.chargeable).toBe(true);
    expect(first.amount.amount).toBe(50);
    expect(first.replyNumber).toBe(1);
  });

  it('does not charge for admitting it does not know', () => {
    // Charging here bills the customer for the assistant's inability to help,
    // which is the one charge that makes somebody cancel feeling cheated.
    const declined = charge(0, false);
    expect(declined.chargeable).toBe(false);
    expect(declined.amount.amount).toBe(0);
    expect(declined.reason).toMatch(/offered a person/);
  });

  it('stops charging past the cap for one conversation', () => {
    expect(charge(5).chargeable).toBe(true);   // the sixth
    expect(charge(6).chargeable).toBe(false);  // the seventh
    expect(charge(20).reason).toMatch(/past the 6 chargeable replies/);
  });

  it('gives a worst case a buyer can be told before they sign', () => {
    // Six replies at 50p. The number to have ready for "what if somebody
    // talks to it all afternoon".
    expect(worstCaseConversationCost(answers)?.amount).toBe(300);
  });

  it('has no worst case when the cap is removed, and says so', () => {
    const uncapped = { ...answers, billableRepliesPerConversation: undefined };
    expect(worstCaseConversationCost(uncapped)).toBeUndefined();
    // And it keeps charging, rather than quietly stopping at some default.
    expect(chargeForReply({
      plan: uncapped, repliesAlreadyCharged: 99, answeredFromKnowledge: true,
    }).chargeable).toBe(true);
  });

  it('charges nothing per reply on a confirmed-outcome plan', () => {
    // The enterprise plans bill a booked meeting, not a turn. Mixing the two
    // produces an invoice nobody can explain to the person receiving it.
    const onGrowth = chargeForReply({
      plan: growth, repliesAlreadyCharged: 0, answeredFromKnowledge: true,
    });
    expect(onGrowth.chargeable).toBe(false);
    expect(onGrowth.reason).toMatch(/confirmed outcome/);
    expect(worstCaseConversationCost(growth)).toBeUndefined();
  });

  it('counts replies charged, not replies sent', () => {
    // A reply the cap made free must not push the next one over it, or the cap
    // would only ever apply to a single reply.
    const capped = chargeForReply({
      plan: answers, repliesAlreadyCharged: 3, answeredFromKnowledge: false,
    });
    expect(capped.chargeable).toBe(false);
    // The caller records nothing, so the next chargeable reply is still the 4th.
    expect(chargeForReply({
      plan: answers, repliesAlreadyCharged: 3, answeredFromKnowledge: true,
    }).replyNumber).toBe(4);
  });
});

describe('credit bundles', () => {
  it('gets cheaper per reply as it gets bigger', () => {
    const rates = CREDIT_BUNDLES.map((bundle) => bundle.effectivePencePerReply);
    for (let index = 1; index < rates.length; index += 1) {
      expect(rates[index]!, `bundle ${CREDIT_BUNDLES[index]!.code}`)
        .toBeLessThan(rates[index - 1]!);
    }
  });

  it('never prices above paying as you go', () => {
    // A bundle costing more per reply than the list price is a trap, and a
    // customer who spots one stops believing the rest of the page.
    for (const bundle of CREDIT_BUNDLES) {
      expect(bundle.effectivePencePerReply, bundle.code)
        .toBeLessThanOrEqual(LIST_PENCE_PER_REPLY);
    }
    expect(checkBundles(CREDIT_BUNDLES)).toEqual([]);
  });

  it('grants the replies that were sold, not the ones the money would buy', () => {
    // 500 replies bought for £225 grant £250 of credit. That gap is the
    // discount; granting the amount paid would quietly remove it.
    const fiveHundred = CREDIT_BUNDLES.find((one) => one.replies === 500)!;
    expect(creditValueOf(fiveHundred).amount).toBe(500 * LIST_PENCE_PER_REPLY);
    expect(creditValueOf(fiveHundred).amount).toBeGreaterThan(fiveHundred.price.amount);
  });

  it('refuses a bundle that costs more than the list price', () => {
    const bad = {
      code: 'bad', name: 'Bad', replies: 10, price: money(1_000),
      effectivePencePerReply: 100, savingPercent: -100,
    };
    expect(checkBundles([bad])[0]).toMatch(/better off not buying it/);
  });

  it('refuses a larger bundle that is dearer per reply than a smaller one', () => {
    const problems = checkBundles([
      { code: 'small', name: 'S', replies: 100, price: money(4_000), effectivePencePerReply: 40, savingPercent: 20 },
      { code: 'large', name: 'L', replies: 500, price: money(22_500), effectivePencePerReply: 45, savingPercent: 10 },
    ]);
    expect(problems.some((one) => /cheaper as they get bigger/.test(one))).toBe(true);
  });
});
