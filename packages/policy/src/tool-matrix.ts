import type { ConsentPurpose } from '@detent/awa-core';

/**
 * Tool catalogue with authorisation and confirmation requirements (section 13.2,
 * table 15). This table is the enforcement surface, not documentation of one:
 * the policy engine reads it, and a tool absent from it cannot execute.
 */
export type ToolName =
  | 'classify_intent'
  | 'knowledge_lookup'
  | 'resolve_identity'
  | 'capture_contact'
  | 'upsert_person'
  | 'upsert_organisation'
  | 'create_opportunity'
  | 'create_note'
  | 'create_task'
  | 'check_availability'
  | 'book_meeting'
  | 'notify_owner'
  | 'send_transactional_email'
  | 'enrol_sequence'
  | 'start_recording'
  | 'escalate_to_human'
  | 'quote_price'
  | 'record_outcome';

export type Scope =
  | 'none'
  | 'knowledge.read'
  | 'crm.read'
  | 'crm.write'
  | 'calendar.read'
  | 'calendar.write'
  | 'email.send'
  | 'internal';

export interface ToolRule {
  readonly tool: ToolName;
  readonly scope: Scope;
  /** Consent purpose that must be GRANTED before the tool may execute at all. */
  readonly requiresConsent?: ConsentPurpose;
  /** The visitor must have explicitly confirmed the values being acted on. */
  readonly requiresVisitorConfirmation: boolean;
  /** A human must approve before execution. `configurable` defers to the tenant. */
  readonly requiresHumanApproval: boolean | 'configurable' | 'off_list_only';
  readonly audited: boolean;
  /** Executes against a tenant system, so it needs a live, non-degraded connection. */
  readonly touchesCrm: boolean;
  /** Blocked while the tenant kill switch is anything other than OFF. */
  readonly blockedInDegradedModes: boolean;
}

export const TOOL_RULES: Readonly<Record<ToolName, ToolRule>> = {
  classify_intent: {
    tool: 'classify_intent', scope: 'none',
    requiresVisitorConfirmation: false, requiresHumanApproval: false,
    audited: false, touchesCrm: false, blockedInDegradedModes: false,
  },
  knowledge_lookup: {
    tool: 'knowledge_lookup', scope: 'knowledge.read',
    requiresVisitorConfirmation: false, requiresHumanApproval: false,
    audited: false, touchesCrm: false, blockedInDegradedModes: false,
  },
  resolve_identity: {
    tool: 'resolve_identity', scope: 'crm.read',
    requiresConsent: 'IDENTITY_RESOLUTION',
    requiresVisitorConfirmation: false, requiresHumanApproval: false,
    audited: true, touchesCrm: true, blockedInDegradedModes: true,
  },
  capture_contact: {
    tool: 'capture_contact', scope: 'none',
    requiresVisitorConfirmation: true, requiresHumanApproval: false,
    audited: true, touchesCrm: false, blockedInDegradedModes: false,
  },
  upsert_person: {
    tool: 'upsert_person', scope: 'crm.write',
    requiresVisitorConfirmation: false, requiresHumanApproval: false,
    audited: true, touchesCrm: true, blockedInDegradedModes: true,
  },
  upsert_organisation: {
    tool: 'upsert_organisation', scope: 'crm.write',
    requiresVisitorConfirmation: false, requiresHumanApproval: false,
    audited: true, touchesCrm: true, blockedInDegradedModes: true,
  },
  create_opportunity: {
    tool: 'create_opportunity', scope: 'crm.write',
    requiresVisitorConfirmation: false, requiresHumanApproval: 'configurable',
    audited: true, touchesCrm: true, blockedInDegradedModes: true,
  },
  create_note: {
    tool: 'create_note', scope: 'crm.write',
    requiresVisitorConfirmation: false, requiresHumanApproval: false,
    audited: true, touchesCrm: true, blockedInDegradedModes: true,
  },
  create_task: {
    tool: 'create_task', scope: 'crm.write',
    requiresVisitorConfirmation: false, requiresHumanApproval: false,
    audited: true, touchesCrm: true, blockedInDegradedModes: true,
  },
  check_availability: {
    tool: 'check_availability', scope: 'calendar.read',
    requiresVisitorConfirmation: false, requiresHumanApproval: false,
    audited: true, touchesCrm: false, blockedInDegradedModes: true,
  },
  book_meeting: {
    tool: 'book_meeting', scope: 'calendar.write',
    requiresVisitorConfirmation: true, requiresHumanApproval: false,
    audited: true, touchesCrm: false, blockedInDegradedModes: true,
  },
  notify_owner: {
    tool: 'notify_owner', scope: 'internal',
    requiresVisitorConfirmation: false, requiresHumanApproval: false,
    audited: true, touchesCrm: false, blockedInDegradedModes: false,
  },
  send_transactional_email: {
    tool: 'send_transactional_email', scope: 'email.send',
    requiresVisitorConfirmation: true, requiresHumanApproval: false,
    audited: true, touchesCrm: false, blockedInDegradedModes: true,
  },
  enrol_sequence: {
    tool: 'enrol_sequence', scope: 'email.send',
    requiresConsent: 'MARKETING',
    requiresVisitorConfirmation: true, requiresHumanApproval: true,
    audited: true, touchesCrm: false, blockedInDegradedModes: true,
  },
  start_recording: {
    tool: 'start_recording', scope: 'none',
    requiresConsent: 'RECORDING',
    requiresVisitorConfirmation: true, requiresHumanApproval: false,
    audited: true, touchesCrm: false, blockedInDegradedModes: true,
  },
  escalate_to_human: {
    tool: 'escalate_to_human', scope: 'internal',
    requiresVisitorConfirmation: false, requiresHumanApproval: false,
    audited: true, touchesCrm: false, blockedInDegradedModes: false,
  },
  record_outcome: {
    // The model recognises which outcome the conversation reached. Whether
    // that outcome is enabled, and whether it is billable, is decided by the
    // platform (section 48.2).
    tool: 'record_outcome', scope: 'internal',
    requiresVisitorConfirmation: false, requiresHumanApproval: false,
    audited: true, touchesCrm: false, blockedInDegradedModes: false,
  },
  quote_price: {
    tool: 'quote_price', scope: 'knowledge.read',
    requiresVisitorConfirmation: false, requiresHumanApproval: 'off_list_only',
    audited: true, touchesCrm: false, blockedInDegradedModes: false,
  },
};

export function ruleFor(tool: string): ToolRule | undefined {
  return TOOL_RULES[tool as ToolName];
}

/** Tools that remain available once the tenant has degraded to text-only. */
export const TOOLS_AVAILABLE_IN_BOOKING_LINK_MODE: readonly ToolName[] = [
  'classify_intent',
  'escalate_to_human',
];
