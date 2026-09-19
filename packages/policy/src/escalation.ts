import type { EscalationThresholds } from '@detent/awa-core';

/**
 * Human handoff and escalation triggers (section 27, table 38).
 *
 * The model recognises the signal; this function decides what happens next.
 * That split is the point: sentiment and topic detection are language work,
 * whether to hand a person to a human is not.
 */
export type EscalationTrigger =
  | 'low_confidence'
  | 'negative_sentiment'
  | 'high_risk_topic'
  | 'commercial_authority'
  | 'existing_customer'
  | 'ambiguous_identity'
  | 'explicit_request'
  | 'injection_or_abuse';

export interface EscalationSignals {
  readonly modelConfidence?: number;
  readonly consecutiveNegativeTurns?: number;
  readonly detectedTopics?: readonly string[];
  readonly commercialAuthorityRequested?: boolean;
  readonly classification?: string;
  readonly visitorAskedForHuman?: boolean;
  readonly securityClassifierFired?: boolean;
  /** Set when the turn asked a factual question, so a confidence floor applies. */
  readonly factualQuestion?: boolean;
}

export interface EscalationOutcome {
  readonly escalate: boolean;
  readonly triggers: readonly EscalationTrigger[];
  /** True when the assistant must stop qualifying immediately. */
  readonly stopQualifying: boolean;
  /** True when the assistant must not attempt an answer at all. */
  readonly answerSuppressed: boolean;
}

export function evaluateEscalation(
  thresholds: EscalationThresholds,
  signals: EscalationSignals,
): EscalationOutcome {
  const triggers: EscalationTrigger[] = [];

  if (signals.visitorAskedForHuman) triggers.push('explicit_request');

  if (
    signals.factualQuestion &&
    signals.modelConfidence !== undefined &&
    signals.modelConfidence < thresholds.confidenceFloor
  ) {
    // Escalate with full context rather than hedge. Hedging is how an assistant
    // gets to a wrong answer with a disclaimer attached.
    triggers.push('low_confidence');
  }

  if ((signals.consecutiveNegativeTurns ?? 0) >= thresholds.negativeSentimentTurns) {
    triggers.push('negative_sentiment');
  }

  const risky = (signals.detectedTopics ?? []).filter((topic) =>
    thresholds.highRiskTopics.some((configured) => topic.toLowerCase().includes(configured.toLowerCase())),
  );
  if (risky.length > 0) triggers.push('high_risk_topic');

  if (signals.commercialAuthorityRequested) triggers.push('commercial_authority');
  if (signals.classification === 'EXISTING_CUSTOMER') triggers.push('existing_customer');
  if (signals.classification === 'AMBIGUOUS') triggers.push('ambiguous_identity');
  if (signals.securityClassifierFired) triggers.push('injection_or_abuse');

  return {
    escalate: triggers.length > 0,
    triggers,
    stopQualifying: triggers.some((t) =>
      t === 'explicit_request' || t === 'existing_customer' || t === 'high_risk_topic' || t === 'negative_sentiment',
    ),
    answerSuppressed: triggers.includes('high_risk_topic') || triggers.includes('low_confidence'),
  };
}

export const DEFAULT_HIGH_RISK_TOPICS: readonly string[] = [
  'legal advice', 'litigation', 'tribunal', 'audit', 'complaint', 'regulator',
  'tax advice', 'medical', 'safeguarding', 'redundancy', 'data breach', 'insolvency',
];
