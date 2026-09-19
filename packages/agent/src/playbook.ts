import type { ObjectionPlay, QualificationModel, TenantConfig } from '@detent/awa-core';

/**
 * Sales qualification and objection handling (section 14).
 *
 * The qualification model is a configurable superset of BANT with intent and
 * urgency added. Nothing here is hard-coded to a methodology: a tenant may
 * rename, reweight, remove or add dimensions, and the engine only knows about
 * weights, thresholds and how a dimension is captured.
 */
export interface QualificationState {
  readonly captured: Readonly<Record<string, string | number | boolean>>;
  readonly askedThisSession: readonly string[];
}

export type LeadState = 'New' | 'Captured' | 'Qualified' | 'Disqualified' | 'Routed' | 'Nurtured';

export interface QualificationVerdict {
  readonly score: number;
  readonly maxScore: number;
  readonly state: 'UNQUALIFIED' | 'CAPTURED' | 'QUALIFIED' | 'DISQUALIFIED';
  readonly missingRequired: readonly string[];
}

export function scoreQualification(model: QualificationModel, state: QualificationState): QualificationVerdict {
  const maxScore = model.dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  const score = model.dimensions.reduce(
    (sum, dimension) => (state.captured[dimension.key] !== undefined ? sum + dimension.weight : sum),
    0,
  );
  const missingRequired = model.dimensions
    .filter((dimension) => dimension.required && state.captured[dimension.key] === undefined)
    .map((dimension) => dimension.key);

  const normalised = maxScore === 0 ? 0 : score / maxScore;

  if (normalised <= model.disqualifiedThreshold && Object.keys(state.captured).length > 0) {
    return { score, maxScore, state: 'DISQUALIFIED', missingRequired };
  }
  if (normalised >= model.qualifiedThreshold && missingRequired.length === 0) {
    return { score, maxScore, state: 'QUALIFIED', missingRequired };
  }
  if (Object.keys(state.captured).length > 0) {
    return { score, maxScore, state: 'CAPTURED', missingRequired };
  }
  return { score, maxScore, state: 'UNQUALIFIED', missingRequired };
}

/**
 * Progressive disclosure (section 14.2).
 *
 * The rules are enforced here rather than requested in the prompt, because
 * "never ask more than one qualifying question per turn" is exactly the kind of
 * instruction a model follows ninety per cent of the time.
 */
export interface NextQuestionInput {
  readonly config: TenantConfig;
  readonly state: QualificationState;
  /** True when the visitor's last turn ended in a direct question. */
  readonly visitorAskedQuestion: boolean;
  readonly visitorAskedForHuman: boolean;
  /** True once the visitor has been given something of value. */
  readonly valueDelivered: boolean;
}

export interface NextQuestionOutcome {
  readonly shouldAsk: boolean;
  readonly dimensionKey?: string;
  readonly reason: string;
}

export function nextQualifyingQuestion(input: NextQuestionInput): NextQuestionOutcome {
  if (input.visitorAskedForHuman) {
    return { shouldAsk: false, reason: 'visitor asked for a human; qualification stops immediately' };
  }
  if (input.visitorAskedQuestion) {
    return { shouldAsk: false, reason: 'visitor asked a direct question; answer it before asking anything' };
  }

  const remaining = input.config.qualification.dimensions
    .filter((dimension) => dimension.capture === 'asked')
    .filter((dimension) => input.state.captured[dimension.key] === undefined)
    .filter((dimension) => !input.state.askedThisSession.includes(dimension.key))
    .sort((a, b) => b.weight - a.weight);

  const next = remaining[0];
  if (!next) return { shouldAsk: false, reason: 'nothing left to ask that cannot be inferred' };

  // Contact details are only asked for once value has been delivered.
  if (!input.valueDelivered && CONTACT_DIMENSIONS.has(next.key)) {
    return { shouldAsk: false, reason: 'no value delivered yet; do not ask for contact details' };
  }

  return { shouldAsk: true, dimensionKey: next.key, reason: 'highest-weighted uncaptured dimension' };
}

const CONTACT_DIMENSIONS = new Set(['contact', 'email', 'phone', 'contact_details']);

/** Objection handling (section 14.3, table 19). Boundaries are per tenant. */
export function findObjectionPlay(config: TenantConfig, objectionType: string): ObjectionPlay | undefined {
  return config.objections.find((play) => play.type.toLowerCase() === objectionType.toLowerCase());
}

/** The default model: BANT plus intent, urgency and service interest. */
export const DEFAULT_QUALIFICATION_MODEL: QualificationModel = {
  dimensions: [
    { key: 'need', label: 'Need', weight: 25, required: true, capture: 'inferred', prohibitedPhrasings: ['what is your pain point'] },
    { key: 'timing', label: 'Timing', weight: 20, required: true, capture: 'asked', prohibitedPhrasings: ['when do you want to buy'] },
    { key: 'authority', label: 'Authority', weight: 15, required: false, capture: 'inferred', prohibitedPhrasings: ['are you the decision maker'] },
    { key: 'budget', label: 'Budget', weight: 10, required: false, capture: 'asked', prohibitedPhrasings: ['what is your budget'] },
    { key: 'scale', label: 'Scale', weight: 15, required: false, capture: 'asked' },
    { key: 'intent', label: 'Intent and urgency', weight: 10, required: false, capture: 'signal' },
    { key: 'service_interest', label: 'Service interest', weight: 5, required: true, capture: 'inferred' },
  ],
  qualifiedThreshold: 0.6,
  disqualifiedThreshold: 0.05,
};

export const DEFAULT_OBJECTIONS: readonly ObjectionPlay[] = [
  {
    type: 'price',
    approvedApproach: 'Restate the value against the stated scope and offer a tailored quote.',
    boundaries: ['No discount', 'No negotiation', 'No comparison claim about a named competitor’s pricing'],
  },
  {
    type: 'timing',
    approvedApproach: 'Acknowledge, offer a lightweight asset or a diarised follow-up with consent.',
    boundaries: ['No manufactured urgency'],
  },
  {
    type: 'incumbent',
    approvedApproach: 'Ask what is and is not working, and offer a second opinion.',
    boundaries: ['No disparagement of a named competitor'],
  },
  {
    type: 'trust',
    approvedApproach: 'Offer approved proof: a named case study, a credential, or the reference process.',
    boundaries: ['No invented reference', 'No unverifiable claim'],
  },
  {
    type: 'ai_scepticism',
    approvedApproach: 'Confirm plainly that it is AI, explain what it can and cannot do, and offer a human.',
    boundaries: ['No deflection'],
  },
  {
    type: 'privacy',
    approvedApproach: 'Explain what is stored, for how long, and how to have it deleted.',
    boundaries: ['No overclaiming of certifications the tenant does not hold'],
  },
];

/** Lead state machine (section 23.2). Illegal transitions throw rather than pass. */
const LEAD_TRANSITIONS: Readonly<Record<LeadState, readonly LeadState[]>> = {
  New: ['Captured'],
  Captured: ['Qualified', 'Disqualified'],
  Qualified: ['Routed', 'Nurtured'],
  Disqualified: [],
  Routed: [],
  Nurtured: [],
};

export function transitionLead(from: LeadState, to: LeadState): LeadState {
  if (!LEAD_TRANSITIONS[from].includes(to)) {
    throw new Error(`illegal lead transition ${from} -> ${to}`);
  }
  return to;
}
