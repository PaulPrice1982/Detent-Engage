import {
  servesTraffic,
  type TenantConfig,
} from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import { ConsentService } from './consent-service.js';
import { MeteringService, type MeterVerdict } from './metering.js';
import { ruleFor, TOOLS_AVAILABLE_IN_BOOKING_LINK_MODE, type ToolName, type ToolRule } from './tool-matrix.js';

/**
 * The deterministic policy gate (pipeline step 5, section 13.1).
 *
 * The single design rule, from section 8.3: every decision this class makes is
 * one the language model is structurally prevented from making. Nothing here
 * reads model output as an input to its own verdict, the model's claim that
 * consent was given, that a price is approved, or that a field was confirmed is
 * never evidence. Evidence comes from the consent store, the tenant config and
 * the tool arguments themselves.
 */
export type PolicyEffect = 'ALLOW' | 'DENY' | 'REQUIRE_HUMAN_APPROVAL';

export interface PolicyObligation {
  /** Set when the caller must degrade the session rather than proceed normally. */
  readonly degradeTo?: 'TEXT_ONLY' | 'BOOKING_LINK_ONLY';
  readonly warnTenant?: boolean;
  readonly escalate?: boolean;
}

export interface PolicyDecision {
  readonly effect: PolicyEffect;
  readonly tool: string;
  readonly reasons: readonly string[];
  readonly obligations: PolicyObligation;
  /** Consent event that authorised the call, recorded on the audit entry. */
  readonly consentEventId?: string;
  readonly correlationId: string;
  readonly policyVersion: string;
}

export interface PolicyRequest {
  readonly tenantConfig: TenantConfig;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly correlationId: string;
  readonly sessionId: string;
  /** Stable pseudonymous reference for the visitor within this tenant. */
  readonly subjectRef: string;
  /** Live state of the tenant's CRM connection, from the connector framework. */
  readonly connectionState: 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED';
  /** True when the visitor has explicitly asked for a human this session. */
  readonly humanRequested?: boolean;
  /**
   * The conversational mode this session is in (v1.2 section 56). Supplied by
   * the mode selector, which derives it deterministically from CustomerContext.
   * Absent means acquisition, which is the v1.0 behaviour unchanged.
   */
  readonly mode?: string;
  /** Tools the mode forbids. Computed by the mode selector, not by the model. */
  readonly modeForbiddenTools?: readonly string[];
}

const deny = (request: PolicyRequest, reason: string, obligations: PolicyObligation = {}): PolicyDecision => ({
  effect: 'DENY',
  tool: request.tool,
  reasons: [reason],
  obligations,
  correlationId: request.correlationId,
  policyVersion: request.tenantConfig.policyVersion,
});

export class PolicyEngine {
  constructor(
    private readonly consent: ConsentService,
    private readonly metering: MeteringService,
    private readonly audit: AuditLog,
  ) {}

  async evaluate(request: PolicyRequest): Promise<PolicyDecision> {
    const decision = await this.decide(request);
    const rule = ruleFor(request.tool);

    if (rule?.audited || decision.effect !== 'ALLOW') {
      await this.audit.write({
        tenantId: request.tenantConfig.tenantId,
        type:
          decision.effect === 'ALLOW' ? 'policy_allowed'
          : decision.effect === 'REQUIRE_HUMAN_APPROVAL' ? 'policy_requires_approval'
          : 'policy_denied',
        correlationId: request.correlationId,
        sessionId: request.sessionId,
        actor: 'policy',
        subjectRef: request.subjectRef,
        consentEventId: decision.consentEventId,
        payload: { tool: request.tool, reasons: decision.reasons, obligations: decision.obligations },
        versions: {
          policy: request.tenantConfig.policyVersion,
          prompt: request.tenantConfig.promptVersion,
          model: request.tenantConfig.modelVersion,
          config: request.tenantConfig.version,
        },
      });
    }

    return decision;
  }

  private async decide(request: PolicyRequest): Promise<PolicyDecision> {
    const { tenantConfig: config } = request;

    // 1. The tool must exist in the catalogue. An unknown tool is a defect or
    //    an attack, and in either case is never executed.
    const rule = ruleFor(request.tool);
    if (!rule) return deny(request, `unknown tool: ${request.tool}`);

    // 2. Tenant must be in a traffic-serving state at all.
    if (!servesTraffic(config.state)) {
      return deny(request, `tenant state ${config.state} does not serve traffic`);
    }

    // 3. Kill switches. Platform-wide is applied by the caller before we are
    //    reached; the per-tenant switch is applied here without a redeploy.
    if (config.killSwitch === 'BOOKING_LINK_ONLY' && !TOOLS_AVAILABLE_IN_BOOKING_LINK_MODE.includes(rule.tool)) {
      return deny(request, 'tenant kill switch set to booking link only', { degradeTo: 'BOOKING_LINK_ONLY' });
    }
    if (config.killSwitch === 'TEXT_ONLY' && rule.blockedInDegradedModes && rule.tool === 'start_recording') {
      return deny(request, 'tenant kill switch set to text only', { degradeTo: 'TEXT_ONLY' });
    }

    // 4. The visitor asking for a human stops qualification immediately
    //    (section 14.2). Sales tools are refused; safety tools are not.
    if (request.humanRequested && QUALIFYING_TOOLS.has(rule.tool)) {
      return deny(request, 'visitor has asked for a human; qualification stops', { escalate: true });
    }

    // 4b. The conversational mode gate (v1.2, FR-095 and FR-096).
    //
    // Disabling selling entirely when a customer is unhappy is the behaviour
    // every human account manager knows and no AI sales agent implements. It is
    // enforced here rather than requested in a prompt, because a prompt that
    // says "do not sell" is followed most of the time.
    if (request.modeForbiddenTools?.includes(rule.tool)) {
      return deny(request, `conversation mode ${request.mode ?? 'unknown'} forbids ${rule.tool}`, { escalate: true });
    }

    // 5. Connection state. Fail closed on the credential, fail open on the
    //    conversation (flow 19): CRM tools are parked, the assistant keeps
    //    talking and keeps capturing.
    if (rule.touchesCrm && request.connectionState !== 'CONNECTED') {
      return deny(request, `crm connection is ${request.connectionState}; write parked for reconciliation`);
    }

    // 6. Metering. Checked before the spend, not after.
    const meter = await this.metering.check(config.tenantId, config.spendCaps, {
      voice: rule.tool === 'start_recording',
    });
    const meterOutcome = this.applyMeter(request, rule, meter);
    if (meterOutcome) return meterOutcome;

    // 7. The consent gate. This is the step that must be impossible to skip:
    //    absence of a stored, affirmative event is refusal, not a default.
    if (rule.requiresConsent) {
      const event = await this.consent.get(config.tenantId, request.subjectRef, rule.requiresConsent);
      if (event?.choice !== 'GRANTED') {
        await this.audit.write({
          tenantId: config.tenantId,
          type:
            rule.requiresConsent === 'IDENTITY_RESOLUTION' ? 'resolution_blocked_no_consent'
            : rule.requiresConsent === 'MARKETING' ? 'enrolment_blocked_no_consent'
            : 'recording_blocked_no_consent',
          correlationId: request.correlationId,
          sessionId: request.sessionId,
          actor: 'policy',
          subjectRef: request.subjectRef,
          payload: { tool: request.tool, purpose: rule.requiresConsent, storedChoice: event?.choice ?? 'none' },
        });
        return deny(request, `consent ${rule.requiresConsent} not granted`);
      }

      // 8. Visitor confirmation, where the tool requires it, is proven by the
      //    arguments rather than asserted by the model. `capture_contact`
      //    carries confirmed_fields; consent-gated tools carry the event id.
      const claimed = request.args['consent_event_id'];
      if (typeof claimed === 'string' && claimed !== event.id) {
        return deny(request, 'consent_event_id in tool arguments does not match the stored event');
      }

      return this.allow(request, rule, event.id);
    }

    // 9. Field-level confirmation. A field not read back to the visitor was not
    //    confirmed, and is rejected rather than written (section 22.1).
    if (rule.requiresVisitorConfirmation) {
      const unconfirmed = unconfirmedFields(request.args);
      if (unconfirmed.length > 0) {
        return deny(request, `unconfirmed fields: ${unconfirmed.join(', ')}`);
      }
    }

    // 10. Human approval, per tenant configuration and per tool.
    if (rule.requiresHumanApproval === true) {
      return this.requireApproval(request, 'tool always requires human approval');
    }
    if (rule.requiresHumanApproval === 'configurable' && config.requireApprovalForOpportunity) {
      return this.requireApproval(request, 'tenant requires approval for this tool');
    }
    if (rule.requiresHumanApproval === 'off_list_only' && request.args['off_list'] === true) {
      return this.requireApproval(request, 'off-list price requires human approval');
    }

    return this.allow(request, rule);
  }

  private applyMeter(request: PolicyRequest, rule: ToolRule, meter: MeterVerdict): PolicyDecision | undefined {
    if (meter.state === 'BLOCKED') {
      return deny(request, `metering blocked: ${meter.reason}`, { degradeTo: 'BOOKING_LINK_ONLY', warnTenant: true });
    }
    if (meter.state === 'DEGRADE_TO_TEXT' && rule.tool === 'start_recording') {
      return deny(request, 'spend approaching cap; voice disabled', { degradeTo: 'TEXT_ONLY', warnTenant: true });
    }
    return undefined;
  }

  private allow(request: PolicyRequest, _rule: ToolRule, consentEventId?: string): PolicyDecision {
    return {
      effect: 'ALLOW',
      tool: request.tool,
      reasons: ['all gates passed'],
      obligations: {},
      consentEventId,
      correlationId: request.correlationId,
      policyVersion: request.tenantConfig.policyVersion,
    };
  }

  private requireApproval(request: PolicyRequest, reason: string): PolicyDecision {
    return {
      effect: 'REQUIRE_HUMAN_APPROVAL',
      tool: request.tool,
      reasons: [reason],
      obligations: { escalate: true },
      correlationId: request.correlationId,
      policyVersion: request.tenantConfig.policyVersion,
    };
  }
}

/** Tools that constitute continued qualification, stopped on a human request. */
const QUALIFYING_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'capture_contact',
  'quote_price',
  'enrol_sequence',
  'create_opportunity',
]);

/**
 * Fields that must appear in `confirmed_fields` to be written. The control is
 * the array, not the model's assurance: a field not listed there was not read
 * back to the visitor, so the value is unverified transcription.
 */
const CONFIRMABLE_FIELDS = ['work_email', 'full_name', 'phone_e164', 'organisation', 'job_title'] as const;

function unconfirmedFields(args: Readonly<Record<string, unknown>>): string[] {
  const confirmed = new Set(Array.isArray(args['confirmed_fields']) ? (args['confirmed_fields'] as unknown[]).filter((v): v is string => typeof v === 'string') : []);
  return CONFIRMABLE_FIELDS.filter((field) => args[field] !== undefined && !confirmed.has(field));
}
