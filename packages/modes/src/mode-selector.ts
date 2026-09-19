import type { AuditLog } from '@detent/awa-audit';
import type { CustomerContext } from '@detent/awa-context';

/**
 * The existing-customer lane (section 56).
 *
 * The category treats an existing customer as a mis-classified lead. This
 * treats them as the more valuable visitor, which for most mid-market B2B
 * businesses they are.
 *
 * The row that matters most is SERVICE_ONLY: **disabling selling entirely when
 * a customer is unhappy is the behaviour every human account manager knows and
 * no AI sales agent implements**, because none of them can see the support
 * system.
 */
export type ConversationMode =
  | 'ACQUISITION'
  | 'SERVICE_AND_EXPANSION'
  | 'SERVICE_ONLY'
  | 'ESCALATE_ONLY'
  | 'SERVICE_AND_RENEWAL'
  | 'WIN_BACK'
  | 'PARTNER';

export interface ModeDefinition {
  readonly mode: ConversationMode;
  readonly objective: string;
  /** Whether any sales behaviour is permitted at all. */
  readonly sellingPermitted: boolean;
  /** Whether the assistant may commit to anything on the tenant's behalf. */
  readonly serviceCommitmentPermitted: boolean;
  readonly mustEscalate: boolean;
}

export const MODES: Readonly<Record<ConversationMode, ModeDefinition>> = {
  ACQUISITION: {
    mode: 'ACQUISITION',
    objective: 'Qualify and route, per v1.0.',
    sellingPermitted: true, serviceCommitmentPermitted: false, mustEscalate: false,
  },
  SERVICE_AND_EXPANSION: {
    mode: 'SERVICE_AND_EXPANSION',
    objective: 'Answer, deflect, detect expansion signals, route to the account team.',
    sellingPermitted: true, serviceCommitmentPermitted: false, mustEscalate: false,
  },
  SERVICE_ONLY: {
    mode: 'SERVICE_ONLY',
    objective: 'Help or escalate. Selling is disabled entirely.',
    sellingPermitted: false, serviceCommitmentPermitted: false, mustEscalate: false,
  },
  ESCALATE_ONLY: {
    mode: 'ESCALATE_ONLY',
    objective: 'Route to the account team without comment. No selling, no service commitments.',
    sellingPermitted: false, serviceCommitmentPermitted: false, mustEscalate: true,
  },
  SERVICE_AND_RENEWAL: {
    mode: 'SERVICE_AND_RENEWAL',
    objective: 'Answer, flag internally, never pressure.',
    sellingPermitted: true, serviceCommitmentPermitted: false, mustEscalate: false,
  },
  WIN_BACK: {
    mode: 'WIN_BACK',
    objective: 'Acknowledge and route to a human. No automated win-back sequence.',
    sellingPermitted: false, serviceCommitmentPermitted: false, mustEscalate: true,
  },
  PARTNER: {
    mode: 'PARTNER',
    objective: 'Route per the partner registry.',
    sellingPermitted: false, serviceCommitmentPermitted: false, mustEscalate: false,
  },
};

/**
 * Mode selection is deterministic (FR-094) and evaluated in strict order, most
 * protective first. A customer who is both in arrears and unhappy gets
 * ESCALATE_ONLY, not SERVICE_ONLY: the ordering encodes which condition wins.
 */
export function selectMode(context: CustomerContext): ConversationMode {
  if (context.relationship === 'PARTNER') return 'PARTNER';
  if (context.relationship === 'CHURNED') return 'WIN_BACK';
  if (context.relationship !== 'CUSTOMER') return 'ACQUISITION';

  if (context.standing === 'IN_ARREARS' || context.standing === 'IN_DISPUTE') return 'ESCALATE_ONLY';
  if (context.sentiment === 'NEGATIVE' || context.openItems.severityBand === 'severe') return 'SERVICE_ONLY';
  if (context.commercial.renewalWindow) return 'SERVICE_AND_RENEWAL';
  return 'SERVICE_AND_EXPANSION';
}

/**
 * Tools that constitute selling. In SERVICE_ONLY and ESCALATE_ONLY these are
 * refused by the policy layer, not merely discouraged in a prompt (FR-095).
 */
export const SELLING_TOOLS: readonly string[] = [
  'quote_price',
  'create_opportunity',
  'enrol_sequence',
  'capture_contact',
];

/** Tools that constitute a commitment the assistant has no authority to make. */
export const COMMITMENT_TOOLS: readonly string[] = [
  'book_meeting',
  'send_transactional_email',
];

export interface ModeGateVerdict {
  readonly allowed: boolean;
  readonly reason: string;
}

export function checkModeGate(mode: ConversationMode, tool: string): ModeGateVerdict {
  const definition = MODES[mode];

  if (!definition.sellingPermitted && SELLING_TOOLS.includes(tool)) {
    return {
      allowed: false,
      reason: `${mode}: selling is disabled in this conversation`,
    };
  }
  if (!definition.serviceCommitmentPermitted && definition.mustEscalate && COMMITMENT_TOOLS.includes(tool)) {
    return {
      allowed: false,
      reason: `${mode}: no commitment may be made in this conversation`,
    };
  }
  return { allowed: true, reason: `${mode} permits ${tool}` };
}

export class ModeSelector {
  constructor(private readonly audit: AuditLog) {}

  async select(input: {
    tenantId: string; sessionId: string; correlationId: string; context: CustomerContext;
  }): Promise<ConversationMode> {
    const mode = selectMode(input.context);
    await this.audit.write({
      tenantId: input.tenantId,
      type: 'policy_allowed',
      correlationId: input.correlationId,
      sessionId: input.sessionId,
      actor: 'policy',
      payload: {
        change: 'conversation_mode_selected',
        mode,
        sellingPermitted: MODES[mode].sellingPermitted,
        // Bands, not facts. The audit records the decision, not the balance.
        relationship: input.context.relationship,
        standing: input.context.standing,
        sentiment: input.context.sentiment,
      },
    });
    return mode;
  }
}
