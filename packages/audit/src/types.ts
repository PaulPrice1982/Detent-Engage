/**
 * Audit event taxonomy (section 29). The log covers every consent event, tool
 * call, policy decision, disclosure decision and break-glass access, and is
 * replayable: any past conversation outcome can be reconstructed with the
 * prompt, model and policy versions that produced it.
 */
export type AuditEventType =
  // consent and disclosure
  | 'consent_recorded'
  | 'consent_withdrawn'
  | 'disclosure_shown'
  | 'resolution_blocked_no_consent'
  | 'enrolment_blocked_no_consent'
  | 'recording_blocked_no_consent'
  // policy
  | 'policy_allowed'
  | 'policy_denied'
  | 'policy_requires_approval'
  | 'kill_switch_engaged'
  | 'quota_exceeded'
  | 'spend_cap_reached'
  // tools
  | 'tool_call_requested'
  | 'tool_call_rejected_schema'
  | 'tool_call_executed'
  | 'tool_call_failed'
  // identity
  | 'resolution_started'
  | 'resolution_complete'
  | 'ambiguous_match'
  | 'duplicate_suspected'
  // crm
  | 'crm_write_attempted'
  | 'crm_write_confirmed'
  | 'crm_write_parked'
  | 'crm_write_reconciled'
  | 'connection_degraded'
  | 'connection_restored'
  // security and operations
  | 'injection_detected'
  | 'output_blocked'
  | 'cross_tenant_denied'
  | 'break_glass_access'
  | 'erasure_executed'
  | 'session_opened'
  | 'session_closed'
  | 'escalated_to_human'
  // knowledge lifecycle
  | 'knowledge_approved'
  | 'knowledge_rejected'
  // operator console: every privileged action is a four-eyes record
  | 'operator_action_requested'
  | 'operator_action_approved'
  | 'operator_action_rejected'
  | 'operator_action_executed'
  // money. Separate from tool calls because these are the entries a buyer's
  // auditor reads, and they must be findable without knowing the code path.
  | 'credit_granted'
  | 'payment_taken'
  | 'payment_failed'
  | 'payment_refunded'
  | 'payment_webhook_received'
  // voice
  | 'voice_session_opened'
  | 'voice_session_closed'
  | 'voice_provider_error';

export interface AuditEntryInput {
  readonly tenantId: string;
  readonly type: AuditEventType;
  readonly correlationId: string;
  readonly sessionId?: string;
  readonly actor: 'visitor' | 'assistant' | 'policy' | 'system' | 'tenant_admin' | 'platform_admin';
  readonly subjectRef?: string;
  readonly consentEventId?: string;
  /** Payload is redacted before it reaches this call, never after. */
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Version pins that make the entry replayable. */
  readonly versions?: {
    readonly prompt?: string;
    readonly policy?: string;
    readonly model?: string;
    readonly config?: number;
  };
}

export interface AuditEntry extends AuditEntryInput {
  readonly id: string;
  readonly sequence: number;
  readonly recordedAt: string;
  readonly previousHash: string;
  readonly hash: string;
}

export interface ChainVerification {
  readonly valid: boolean;
  readonly checked: number;
  readonly brokenAtSequence?: number;
  readonly reason?: string;
  /**
   * Sequence the verification resumed from, when a signed checkpoint covered
   * the earlier entries (audit PERF-2). Absent means the whole chain was
   * walked. Stated in the export so a DPO can see which it was.
   */
  readonly resumedFromSequence?: number;
}
