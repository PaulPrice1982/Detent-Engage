import { checkLadder, type VerificationLevel } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import type { ClmFacts, ContractedItem } from '@detent/awa-context';

/**
 * The entitlement service (section 55).
 *
 * Reading the CLM turns the assistant from a lead tool into a revenue
 * instrument. It is also the most dangerous thing it touches, so the boundaries
 * in section 55.2 are severe and every one of them is enforced here rather than
 * requested in a prompt:
 *
 *  1. It **reads and cites**. It never interprets a term, never advises on its
 *     meaning, never predicts an outcome. Anything beyond reading is legal
 *     advice and is refused under section 13.3.
 *  2. It answers only from the **executed agreement with the verified party** —
 *     never a template, never another customer, never a draft.
 *  3. Excess use, arrears and renewal exposure are **never disclosed to the
 *     visitor.** They produce internal tasks only.
 *  4. Clause text requires verification level 3. A confirmed email match is
 *     insufficient.
 *  5. No pricing or discount is derived from contract data.
 */
export type EntitlementAnswerKind =
  | 'IN_SCOPE'
  | 'OUT_OF_SCOPE'
  | 'CLAUSE_CITED'
  | 'INSUFFICIENT_VERIFICATION'
  | 'NO_AGREEMENT'
  | 'REFUSED_INTERPRETATION';

export interface EntitlementAnswer {
  readonly kind: EntitlementAnswerKind;
  /** Wording the assistant may use. Never contains anything undisclosable. */
  readonly say: string;
  readonly escalate: boolean;
  /** Present only at level 3, and only from the party's own agreement. */
  readonly clauseRef?: string;
  readonly clauseText?: string;
  readonly requiredLevel?: VerificationLevel;
}

/**
 * Questions the assistant must refuse because answering is interpretation.
 * Detected on the question, not on the answer, so the refusal happens before
 * any contract data is read at all.
 */
const INTERPRETATION_PATTERNS: readonly RegExp[] = [
  // Deliberately excludes "cover". "Does our agreement cover X" is the
  // commonest legitimate question a customer asks, and it is answered by
  // *reading* the entitlement list rather than by construing a term. Treating
  // it as interpretation would refuse the question the whole feature exists to
  // answer.
  /\b(does|do|would|could|can)\s+(this|that|the|my|our)\s+(clause|term|contract|agreement|wording)\s+(mean|allow|permit|entitle|require|oblige)/i,
  /\bwhat does (this|that|clause|section|paragraph)\b.*\bmean\b/i,
  /\b(am|are)\s+(i|we)\s+(entitled|obliged|required|liable|allowed)\b/i,
  /\bcan (i|we) (terminate|exit|cancel|sue|claim|withhold|refuse)\b/i,
  /\bwho would win\b|\bwould we win\b|\bhow would a court\b/i,
  // Allows an intervening noun: "is that clause enforceable" as well as
  // "is that enforceable".
  /\bis (this|that|it)\s+(?:\w+\s+)?(enforceable|legal|lawful|binding|valid)\b/i,
  /\bwhat happens if (i|we) (breach|break|miss|fail)\b/i,
];

export function isInterpretationRequest(question: string): boolean {
  return INTERPRETATION_PATTERNS.some((pattern) => pattern.test(question));
}

export interface EntitlementQuery {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly question: string;
  /** The category the visitor is asking about, resolved from their words. */
  readonly category?: string;
  readonly verificationLevel: VerificationLevel;
  readonly contract?: ClmFacts;
  /** The address on the executed agreement, for the verified-party check. */
  readonly verifiedEmail?: string;
}

export interface ExcessUseFinding {
  readonly metric: string;
  readonly limit: number;
  readonly consumed: number;
  readonly clauseRef?: string;
  readonly agreementRef?: string;
}

export class EntitlementService {
  constructor(private readonly audit: AuditLog) {}

  async answer(query: EntitlementQuery): Promise<EntitlementAnswer> {
    // 1. Interpretation is refused before anything is read. Reading a contract
    //    to answer "what does this mean" would be doing the prohibited thing
    //    and then declining to say so.
    if (isInterpretationRequest(query.question)) {
      await this.log(query, 'REFUSED_INTERPRETATION', { reason: 'question asks for interpretation of a term' });
      return {
        kind: 'REFUSED_INTERPRETATION',
        say: 'I can tell you what your agreement says, but I cannot tell you what it means or what would happen — that needs someone qualified. Let me put you through.',
        escalate: true,
      };
    }

    if (!query.contract?.hasExecutedAgreement) {
      await this.log(query, 'NO_AGREEMENT', {});
      return {
        kind: 'NO_AGREEMENT',
        say: 'I cannot find an executed agreement I can answer from. Let me get someone to check properly.',
        escalate: true,
      };
    }

    // 2. Category-level entitlement needs level 2.
    const categoryCheck = checkLadder(query.verificationLevel, 'entitlement_category');
    if (!categoryCheck.permitted) {
      await this.log(query, 'INSUFFICIENT_VERIFICATION', { required: categoryCheck.required, reached: categoryCheck.reached });
      return {
        kind: 'INSUFFICIENT_VERIFICATION',
        say: 'I can check that for you once I have confirmed it is you. I can send a short code to the address on your account.',
        escalate: false,
        requiredLevel: categoryCheck.required,
      };
    }

    const category = (query.category ?? '').toLowerCase();
    const inScope = query.contract.inScope.find((item) => matches(item, category));
    const outOfScope = query.contract.outOfScope.some((item) => item.toLowerCase().includes(category) && category.length > 0);

    // 3. Clause text needs level 3, and needs the verified party to match the
    //    agreement's counterparty domain.
    if (inScope?.clauseRef && query.contract.clauses?.[inScope.clauseRef]) {
      const clauseCheck = checkLadder(query.verificationLevel, 'clause_text');
      const partyMatches = this.partyMatches(query);
      if (clauseCheck.permitted && partyMatches) {
        await this.log(query, 'CLAUSE_CITED', { clauseRef: inScope.clauseRef });
        return {
          kind: 'CLAUSE_CITED',
          say: `Your agreement covers this. Clause ${inScope.clauseRef} reads: "${query.contract.clauses[inScope.clauseRef]}"`,
          escalate: false,
          clauseRef: inScope.clauseRef,
          clauseText: query.contract.clauses[inScope.clauseRef],
        };
      }
      // Level 2 with a clause available: confirm the category, withhold the text.
    }

    if (inScope) {
      await this.log(query, 'IN_SCOPE', { category });
      return {
        kind: 'IN_SCOPE',
        say: `Yes — ${inScope.label} is within what you have contracted. I can put you through to the team who can get you set up with it.`,
        escalate: false,
      };
    }

    if (outOfScope || category.length > 0) {
      await this.log(query, 'OUT_OF_SCOPE', { category });
      return {
        kind: 'OUT_OF_SCOPE',
        // No price, no discount, no derived figure. Section 13.4 stands.
        say: 'That is not within your current agreement. I can put you through to your account contact, who can talk you through the options.',
        escalate: false,
      };
    }

    await this.log(query, 'INSUFFICIENT_VERIFICATION', { reason: 'category could not be resolved' });
    return {
      kind: 'INSUFFICIENT_VERIFICATION',
      say: 'I am not certain which part of your agreement that relates to. Let me get someone to look at it with you.',
      escalate: true,
    };
  }

  /**
   * The verified-party check. Level 3 permits clause text from **their own**
   * executed agreement, so the verified address must belong to the agreement's
   * counterparty. Without this, level 3 would permit reading anyone's contract.
   */
  private partyMatches(query: EntitlementQuery): boolean {
    const counterparty = query.contract?.counterpartyEmailDomain?.toLowerCase();
    const verifiedDomain = query.verifiedEmail?.split('@')[1]?.toLowerCase();
    return Boolean(counterparty && verifiedDomain && counterparty === verifiedDomain);
  }

  /**
   * Excess use produces an internal task and nothing else (FR-092).
   *
   * Telling a visitor they are over their limit is a commercial conversation
   * for a human with authority. The finding never enters model context, so the
   * assistant is structurally unable to raise it.
   */
  async recordExcessUse(input: {
    tenantId: string; correlationId: string; ownerRef?: string; finding: ExcessUseFinding;
  }): Promise<{ subject: string; body: string; ownerRef?: string }> {
    await this.audit.write({
      tenantId: input.tenantId,
      type: 'tool_call_executed',
      correlationId: input.correlationId,
      actor: 'policy',
      payload: {
        change: 'excess_use_detected',
        metric: input.finding.metric,
        clauseRef: input.finding.clauseRef,
        // Recorded for the tenant's commercial team, never surfaced to the visitor.
        disclosedToVisitor: false,
      },
    });

    return {
      subject: 'Commercial review: consumption beyond contracted volume',
      body: [
        `The website assistant detected consumption beyond the contracted volume during a conversation.`,
        ``,
        `Metric: ${input.finding.metric}`,
        `Contracted limit: ${input.finding.limit}`,
        `Consumed: ${input.finding.consumed}`,
        input.finding.clauseRef ? `Clause reference: ${input.finding.clauseRef}` : '',
        input.finding.agreementRef ? `Agreement: ${input.finding.agreementRef}` : '',
        ``,
        `The visitor was not told. This is for commercial review by someone with authority.`,
      ].filter(Boolean).join('\n'),
      ownerRef: input.ownerRef,
    };
  }

  /** Renewal exposure, likewise: flagged to the owner, never pressure on the visitor. */
  async recordRenewalWindow(input: {
    tenantId: string; correlationId: string; ownerRef?: string;
    expiresAt?: string; noticeByDate?: string; autoRenew?: boolean; agreementRef?: string;
  }): Promise<{ subject: string; body: string; ownerRef?: string }> {
    await this.audit.write({
      tenantId: input.tenantId, type: 'tool_call_executed', correlationId: input.correlationId, actor: 'policy',
      payload: { change: 'renewal_window_flagged', disclosedToVisitor: false, autoRenew: input.autoRenew ?? false },
    });
    return {
      subject: 'Renewal window open',
      body: [
        'The website assistant spoke to this customer while a renewal or notice window was open.',
        input.expiresAt ? `Expires: ${input.expiresAt}` : '',
        input.noticeByDate ? `Notice by: ${input.noticeByDate}` : '',
        `Auto-renew: ${input.autoRenew ? 'yes' : 'no or unknown'}`,
        input.agreementRef ? `Agreement: ${input.agreementRef}` : '',
        '',
        'The visitor was not told and was not pressured.',
      ].filter(Boolean).join('\n'),
      ownerRef: input.ownerRef,
    };
  }

  private async log(query: EntitlementQuery, kind: EntitlementAnswerKind, extra: Record<string, unknown>): Promise<void> {
    await this.audit.write({
      tenantId: query.tenantId,
      type: kind === 'REFUSED_INTERPRETATION' || kind === 'INSUFFICIENT_VERIFICATION' ? 'policy_denied' : 'policy_allowed',
      correlationId: query.correlationId,
      sessionId: query.sessionId,
      actor: 'policy',
      payload: { change: 'entitlement_answer', kind, verificationLevel: query.verificationLevel, ...extra },
    });
  }
}

function matches(item: ContractedItem, category: string): boolean {
  if (category.length === 0) return false;
  return item.category.toLowerCase().includes(category) || item.label.toLowerCase().includes(category);
}

/** Detect excess use from contract terms and usage. Deterministic, not inferred. */
export function detectExcessUse(
  contract: ClmFacts | undefined,
  consumed: { readonly metric: string; readonly consumed: number } | undefined,
): ExcessUseFinding | undefined {
  const terms = contract?.excessUseTerms;
  if (!terms || !consumed) return undefined;
  if (terms.metric !== consumed.metric) return undefined;
  if (consumed.consumed <= terms.limit) return undefined;
  return {
    metric: terms.metric,
    limit: terms.limit,
    consumed: consumed.consumed,
    clauseRef: contract?.inScope.find((item) => item.unit === terms.metric)?.clauseRef,
    agreementRef: contract?.agreementRef,
  };
}
