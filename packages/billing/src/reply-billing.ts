import { money, type Money } from './money.js';
import type { Plan } from './plans.js';

/**
 * Deciding what a reply costs.
 *
 * On the per-reply plan every answer the assistant gives is billable, up to
 * the plan's cap for one conversation. The cap matters more than it looks: it
 * is what lets a customer be told the worst case for a single conversation
 * before they sign, and it is what stops the price rewarding a long exchange.
 *
 * Nothing here charges anything. It answers whether this reply is chargeable
 * and for how much; the ledger does the charging, so a pricing question and a
 * money movement stay separable and the first can be asked without risking
 * the second.
 */

export interface ReplyCharge {
  readonly chargeable: boolean;
  readonly amount: Money;
  /** Which reply in this conversation, counting from one. */
  readonly replyNumber: number;
  /** Said to the operator on the invoice line and in the console. */
  readonly reason: string;
}

export interface ReplyChargeInput {
  readonly plan: Plan;
  /**
   * Replies already charged in this conversation.
   *
   * Charged, not sent. A reply the cap made free must not push the next one
   * over it, or the cap would only ever apply to one reply.
   */
  readonly repliesAlreadyCharged: number;
  /**
   * Whether this reply actually answered from approved knowledge.
   *
   * A reply that said "I do not know, let me get someone" is not an answer,
   * and charging for it charges the customer for the assistant's inability to
   * help: the one charge that would make them cancel while feeling cheated.
   */
  readonly answeredFromKnowledge: boolean;
}

export function chargeForReply(input: ReplyChargeInput): ReplyCharge {
  const { plan } = input;
  const replyNumber = input.repliesAlreadyCharged + 1;
  const free = money(0, plan.currency);

  if (plan.outcomeBasis !== 'assistant_reply') {
    return {
      chargeable: false,
      amount: free,
      replyNumber,
      reason: `${plan.name} bills a confirmed outcome, not a reply.`,
    };
  }

  if (!input.answeredFromKnowledge) {
    return {
      chargeable: false,
      amount: free,
      replyNumber,
      reason: 'Not charged: the assistant had no answer and offered a person.',
    };
  }

  const cap = plan.billableRepliesPerConversation;
  if (cap !== undefined && input.repliesAlreadyCharged >= cap) {
    return {
      chargeable: false,
      amount: free,
      replyNumber,
      reason: `Not charged: past the ${cap} chargeable replies in one conversation.`,
    };
  }

  return {
    chargeable: true,
    amount: plan.outcomeFee,
    replyNumber,
    reason: `Reply ${replyNumber} of a conversation.`,
  };
}

/**
 * The worst a single conversation can cost.
 *
 * The number to put in front of a buyer who asks "and what if somebody talks
 * to it all afternoon". Without a cap the honest answer is that there isn't
 * one, and this says so rather than implying a bound that does not exist.
 */
export function worstCaseConversationCost(plan: Plan): Money | undefined {
  if (plan.outcomeBasis !== 'assistant_reply') return undefined;
  const cap = plan.billableRepliesPerConversation;
  if (cap === undefined) return undefined;
  return money(plan.outcomeFee.amount * cap, plan.currency);
}

/** How many replies a balance will pay for at this plan's price. */
export function repliesAffordable(plan: Plan, balance: Money): number {
  if (plan.outcomeFee.amount <= 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(balance.amount / plan.outcomeFee.amount));
}
