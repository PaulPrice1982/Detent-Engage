/**
 * The nine-outcome taxonomy (section 40.2, FR-044 and FR-047).
 *
 * v1.0 routed to a meeting or a human: one outcome where competitors have five,
 * and no path at all for a product-led motion.
 *
 * Billability is a commercial design as much as a product one. Making
 * escalation, disqualification and abandonment explicitly non-billable aligns
 * the platform's revenue with the tenant's outcome and removes the incentive to
 * over-qualify, the most common criticism of per-conversation pricing.
 */
export type ConversationOutcome =
  | 'book_meeting'
  | 'start_trial'
  | 'route_self_serve'
  | 'route_partner'
  | 'request_quote'
  | 'escalate_human'
  | 'escalate_support'
  | 'disqualify'
  | 'abandoned'
  // --- v1.2, section 56.2: the existing-customer lane.
  | 'resolve_service_query'
  | 'detect_expansion'
  | 'flag_renewal'
  | 'flag_excess_use'
  | 'detect_adoption_gap'
  | 'escalate_at_risk'
  | 'route_partner_v2';

export interface OutcomeDefinition {
  readonly outcome: ConversationOutcome;
  readonly description: string;
  readonly billable: boolean;
  /**
   * Whether the outcome only becomes billable once the tenant's own system
   * confirms it happened downstream (section 40.3). A routing decision that
   * failed downstream is not a qualified lead.
   */
  readonly requiresDownstreamConfirmation: boolean;
  readonly requires: string;
}

export const OUTCOME_TAXONOMY: Readonly<Record<ConversationOutcome, OutcomeDefinition>> = {
  book_meeting: {
    outcome: 'book_meeting',
    description: 'Meeting booked with the correct owner or team.',
    billable: true,
    // The calendar provider is authoritative and already confirmed the slot, so
    // there is no second system to hear from.
    requiresDownstreamConfirmation: false,
    requires: 'calendar integration',
  },
  start_trial: {
    outcome: 'start_trial',
    description: "Prospect provisioned into the tenant's trial or free tier.",
    billable: true,
    requiresDownstreamConfirmation: true,
    requires: 'trial provisioning hook',
  },
  route_self_serve: {
    outcome: 'route_self_serve',
    description: 'Prospect routed to a self-serve purchase or onboarding path.',
    billable: true,
    requiresDownstreamConfirmation: true,
    requires: 'tenant-supplied destination and success signal',
  },
  route_partner: {
    outcome: 'route_partner',
    description: 'Prospect routed to a reseller, channel partner or another entity in the group.',
    billable: true,
    requiresDownstreamConfirmation: true,
    requires: 'partner registry, multi-entity aware',
  },
  request_quote: {
    outcome: 'request_quote',
    description: 'Requirements captured and a human quote task created.',
    billable: true,
    requiresDownstreamConfirmation: false,
    requires: 'CRM task write',
  },
  escalate_human: {
    outcome: 'escalate_human',
    description: 'Handed to a person mid-conversation.',
    billable: false,
    requiresDownstreamConfirmation: false,
    requires: 'handoff console',
  },
  escalate_support: {
    outcome: 'escalate_support',
    description: 'Recognised as a support query and routed.',
    billable: false,
    requiresDownstreamConfirmation: false,
    requires: 'tenant support destination',
  },
  disqualify: {
    outcome: 'disqualify',
    description: 'Determined not to match criteria and routed accordingly.',
    billable: false,
    requiresDownstreamConfirmation: false,
    requires: 'playbook criteria',
  },
  abandoned: {
    outcome: 'abandoned',
    description: 'Visitor left without an outcome.',
    billable: false,
    requiresDownstreamConfirmation: false,
    requires: 'inactivity timer',
  },

  // --- The existing-customer lane (section 56.2).
  //
  // Every competitor treats an existing customer as a mis-classified lead.
  // These outcomes treat them as the more valuable visitor, which for most
  // mid-market B2B businesses they are.
  resolve_service_query: {
    outcome: 'resolve_service_query',
    description: 'An existing customer question answered from entitlement and knowledge.',
    billable: true,
    requiresDownstreamConfirmation: false,
    requires: 'CustomerContext and entitlement resolution',
  },
  detect_expansion: {
    outcome: 'detect_expansion',
    description: 'An out-of-scope need identified and routed with contract context.',
    billable: true,
    requiresDownstreamConfirmation: false,
    requires: 'CLM entitlement resolution',
  },
  flag_renewal: {
    outcome: 'flag_renewal',
    description: 'A renewal or notice window surfaced to the owner.',
    billable: true,
    requiresDownstreamConfirmation: false,
    requires: 'CLM renewal and notice dates',
  },
  flag_excess_use: {
    outcome: 'flag_excess_use',
    description: 'Consumption beyond contracted volume detected and an internal task raised.',
    billable: true,
    // The tenant must confirm the recovery landed. This is the only outcome in
    // any variation paid from money the tenant would not otherwise have
    // collected, so billing it before the money exists would be indefensible.
    requiresDownstreamConfirmation: true,
    requires: 'CLM excess-use terms and usage signals',
  },
  detect_adoption_gap: {
    outcome: 'detect_adoption_gap',
    description: 'A customer asking for something they already have contracted.',
    billable: true,
    requiresDownstreamConfirmation: false,
    requires: 'entitlement resolution',
  },
  escalate_at_risk: {
    outcome: 'escalate_at_risk',
    description: 'Negative sentiment or a dispute routed to a human.',
    // Never billable, for the same reason escalation is not: billing it would
    // create an incentive to find unhappy customers.
    billable: false,
    requiresDownstreamConfirmation: false,
    requires: 'support system sentiment signals',
  },
  route_partner_v2: {
    outcome: 'route_partner_v2',
    description: 'A partner or reseller routed, with the visitor informed and consent recorded.',
    billable: true,
    requiresDownstreamConfirmation: true,
    requires: 'partner registry and a recorded third-party disclosure consent',
  },
};

/**
 * Whether an outcome is billable. Deterministic and not model-mediated: the
 * model recognises which outcome a conversation reached, the platform decides
 * whether that is chargeable (section 48.2).
 */
export function isBillable(outcome: ConversationOutcome): boolean {
  return OUTCOME_TAXONOMY[outcome].billable;
}

export function requiresConfirmation(outcome: ConversationOutcome): boolean {
  return OUTCOME_TAXONOMY[outcome].requiresDownstreamConfirmation;
}

export const BILLABLE_OUTCOMES: readonly ConversationOutcome[] =
  (Object.keys(OUTCOME_TAXONOMY) as ConversationOutcome[]).filter(isBillable);

export const NON_BILLABLE_OUTCOMES: readonly ConversationOutcome[] =
  (Object.keys(OUTCOME_TAXONOMY) as ConversationOutcome[]).filter((o) => !isBillable(o));
