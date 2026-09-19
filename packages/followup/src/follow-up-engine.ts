import { type Clock, type TenantConfig, systemClock } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import { permittedLane, type LaneDecision, type Recipient, type SendingLane } from './jurisdiction.js';
import {
  FrequencyLedger, PLATFORM_MAX_FOLLOWUPS_PER_RECIPIENT_PER_30_DAYS,
  SuppressionList, effectiveCap,
} from './suppression.js';

/**
 * The consent-safe follow-up engine (section 42).
 *
 * Lane two — a single relevant follow-up under legitimate interest — is the
 * capability competitors have and v1.0 lacks. It is defensible only with the
 * machinery here, which is why it is a rules engine rather than a feature:
 * every send passes the jurisdiction engine, the LIA gate, the global
 * suppression list and two frequency caps before it exists.
 */
export interface FollowUpRequest {
  readonly config: TenantConfig;
  readonly conversationId: string;
  readonly correlationId: string;
  readonly recipient: Recipient;
  /** What the follow-up refers to. Lane two permits one relevant reference. */
  readonly conversationSummary: string;
  readonly subject: string;
  readonly body: string;
  /** Set for a transactional message, which is event-driven and always allowed. */
  readonly transactional?: boolean;
}

export interface FollowUpMessage {
  readonly tenantId: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly lane: SendingLane;
  readonly legalBasis: string;
  readonly jurisdiction: string;
  readonly optOutUrl?: string;
  readonly sentAt: string;
}

export type FollowUpVerdict =
  | { readonly sent: true; readonly message: FollowUpMessage; readonly decision: LaneDecision }
  | { readonly sent: false; readonly reason: string; readonly decision?: LaneDecision };

export interface MessageSender {
  send(message: FollowUpMessage): Promise<void>;
}

export class InMemoryMessageSender implements MessageSender {
  readonly sent: FollowUpMessage[] = [];
  async send(message: FollowUpMessage): Promise<void> { this.sent.push(message); }
}

const LEGAL_BASIS: Readonly<Record<SendingLane, string>> = {
  TRANSACTIONAL_ONLY: 'Necessary for the service the visitor requested',
  LEGITIMATE_INTEREST_FOLLOWUP: 'UK GDPR legitimate interest with a completed LIA',
  CONSENTED_NURTURE: 'Explicit consent event',
};

export class FollowUpEngine {
  constructor(
    private readonly sender: MessageSender,
    private readonly suppression: SuppressionList,
    private readonly frequency: FrequencyLedger,
    private readonly audit: AuditLog,
    private readonly optOutBaseUrl: string,
    private readonly clock: Clock = systemClock,
  ) {}

  async send(request: FollowUpRequest): Promise<FollowUpVerdict> {
    const { config, recipient } = request;

    // 1. Global suppression, first and unconditionally. An address that has
    //    opted out anywhere receives nothing from any tenant — including a
    //    transactional message, because a person who asked to be left alone
    //    did not mean "except for confirmations".
    if (await this.suppression.isSuppressed(recipient.email)) {
      return this.refuse(request, 'recipient is on the global suppression list');
    }

    // 2. Transactional is event-driven and needs no lane decision. It is still
    //    logged with its basis, so the scorecard can show the split.
    if (request.transactional) {
      return this.dispatch(request, {
        lane: 'TRANSACTIONAL_ONLY',
        jurisdictionApplied: config.homeJurisdiction,
        reason: 'transactional message for a service the visitor requested',
        failedClosed: false,
      });
    }

    // 3. Is the follow-up capability on at all?
    if (!config.followUp.enabled) {
      return this.refuse(request, 'follow-up is not enabled for this tenant');
    }

    // 4. The jurisdiction engine, failing closed.
    const decision = permittedLane(recipient, config);

    if (decision.lane === 'TRANSACTIONAL_ONLY') {
      // A non-transactional message with a transactional-only verdict is not
      // downgraded and sent anyway. It is refused: the content was written for
      // a lane the recipient is not eligible for.
      return this.refuse(request, `jurisdiction rules permit transactional only: ${decision.reason}`, decision);
    }

    // 5. The LIA gate (FR-056). Lane two is disabled until the tenant's DPO
    //    has completed the assessment that makes it lawful.
    if (decision.lane === 'LEGITIMATE_INTEREST_FOLLOWUP' && !config.followUp.liaComplete) {
      return this.refuse(request, 'the legitimate interests assessment is not marked complete', decision);
    }

    // 6. Frequency caps, platform-enforced and not raisable by a tenant.
    const cap = effectiveCap(config.followUp.maxFollowUpsPerConversation);
    if (this.frequency.countForConversation(request.conversationId, decision.lane) >= cap) {
      return this.refuse(request, `frequency cap of ${cap} per conversation reached`, decision);
    }
    if (this.frequency.countForRecipientInWindow(recipient.email, 30) >= PLATFORM_MAX_FOLLOWUPS_PER_RECIPIENT_PER_30_DAYS) {
      return this.refuse(
        request,
        `platform cap of ${PLATFORM_MAX_FOLLOWUPS_PER_RECIPIENT_PER_30_DAYS} messages per recipient per 30 days reached`,
        decision,
      );
    }

    // 7. Sender identity is mandatory in every jurisdiction that permits a
    //    non-transactional message at all (PECR Reg 23, CAN-SPAM).
    if (!config.followUp.senderName || !config.followUp.senderAddress || !config.followUp.physicalAddress) {
      return this.refuse(request, 'sender identity and physical address must be configured before any non-transactional message', decision);
    }

    return this.dispatch(request, decision);
  }

  private async dispatch(request: FollowUpRequest, decision: LaneDecision): Promise<FollowUpVerdict> {
    const { config, recipient } = request;
    const needsOptOut = decision.lane !== 'TRANSACTIONAL_ONLY';

    const message: FollowUpMessage = {
      tenantId: config.tenantId,
      to: recipient.email,
      subject: request.subject,
      body: needsOptOut ? this.withFooter(request.body, config) : request.body,
      lane: decision.lane,
      legalBasis: LEGAL_BASIS[decision.lane],
      jurisdiction: decision.jurisdictionApplied,
      // Prominent, in every non-transactional message, honoured immediately
      // and permanently (FR-058).
      optOutUrl: needsOptOut ? `${this.optOutBaseUrl}/opt-out/${encodeURIComponent(recipient.email)}` : undefined,
      sentAt: this.clock.iso(),
    };

    await this.sender.send(message);
    this.frequency.record(config.tenantId, recipient.email, request.conversationId, decision.lane);

    // Every message in every lane is logged with its lane, legal basis and
    // jurisdiction determination (section 42.4). This is what the compliance
    // scorecard reports on.
    await this.audit.write({
      tenantId: config.tenantId,
      type: 'tool_call_executed',
      correlationId: request.correlationId,
      actor: 'system',
      payload: {
        change: 'follow_up_sent',
        lane: decision.lane,
        legalBasis: message.legalBasis,
        jurisdiction: decision.jurisdictionApplied,
        failedClosed: decision.failedClosed,
        optOutPresent: Boolean(message.optOutUrl),
      },
    });

    return { sent: true, message, decision };
  }

  private async refuse(request: FollowUpRequest, reason: string, decision?: LaneDecision): Promise<FollowUpVerdict> {
    await this.audit.write({
      tenantId: request.config.tenantId,
      type: 'policy_denied',
      correlationId: request.correlationId,
      actor: 'policy',
      payload: {
        change: 'follow_up_refused',
        reason,
        lane: decision?.lane,
        jurisdiction: decision?.jurisdictionApplied,
        failedClosed: decision?.failedClosed ?? false,
      },
    });
    return { sent: false, reason, decision };
  }

  /** Opt-out honoured immediately and permanently, across every tenant. */
  async optOut(email: string, originTenantId: string, correlationId: string): Promise<void> {
    await this.suppression.suppress(email, 'opt_out', originTenantId);
    await this.audit.write({
      tenantId: originTenantId,
      type: 'consent_withdrawn',
      correlationId,
      actor: 'visitor',
      payload: { change: 'global_opt_out', scope: 'all tenants' },
    });
  }

  private withFooter(body: string, config: TenantConfig): string {
    return [
      body,
      '',
      '—',
      `${config.followUp.senderName}, ${config.followUp.physicalAddress}`,
      'You can stop these messages at any time using the link in this email. We will action it immediately and permanently.',
    ].join('\n');
  }
}

/**
 * Generated legitimate interests assessment template (FR-059).
 *
 * Pre-populated from the tenant's configuration, for their DPO to review and
 * complete. The platform does not complete it and cannot: an LIA is the
 * controller's assessment of their own balancing test, and a vendor filling it
 * in would be the controller doing the one thing they cannot delegate.
 */
export function generateLiaTemplate(config: TenantConfig): string {
  return [
    `# Legitimate Interests Assessment — ${config.name}`,
    '',
    `Prepared for: ${config.name} (the controller)`,
    `Processing: a single follow-up email to a business contact who engaged with the website assistant and did not book.`,
    `Jurisdiction: ${config.homeJurisdiction}. Applied per recipient using the stricter of the recipient's and the controller's position.`,
    '',
    '## 1. Purpose test — is there a legitimate interest?',
    '',
    'Pre-populated: following up a business enquiry the individual initiated, referencing that conversation and nothing else.',
    'The controller must confirm this reflects the actual intended use.',
    '',
    '**Controller to complete:** _______________________________________________',
    '',
    '## 2. Necessity test — is the processing necessary?',
    '',
    'Pre-populated: the individual engaged and did not complete a booking. A single message is the least intrusive',
    'means of completing the enquiry they began. No campaign content is permitted in this lane.',
    '',
    '**Controller to complete:** _______________________________________________',
    '',
    '## 3. Balancing test — do the interests override the individual\'s rights?',
    '',
    'Factors the platform can evidence:',
    `- Frequency is hard-capped at ${effectiveCap(config.followUp.maxFollowUpsPerConversation)} message per conversation and cannot be raised by configuration.`,
    `- A maximum of ${PLATFORM_MAX_FOLLOWUPS_PER_RECIPIENT_PER_30_DAYS} messages per recipient in any 30 days, across all tenants on the platform.`,
    '- Opt-out is prominent in every message, honoured immediately, and applied globally.',
    '- Recipients in jurisdictions requiring consent are excluded automatically and cannot be included by configuration.',
    '- Every send is logged with its lane, legal basis and jurisdiction determination, and is exportable.',
    '',
    'Factors the controller must assess:',
    '- Would the individual reasonably expect this message, given how they engaged?',
    '- Is there any relationship of dependency or vulnerability in this audience?',
    '',
    '**Controller to complete:** _______________________________________________',
    '',
    '## 4. Outcome',
    '',
    '- [ ] Legitimate interest established. Lane two may be enabled.',
    '- [ ] Not established. Lane two remains disabled and only transactional and consented messages are sent.',
    '',
    'Signed (DPO or accountable person): ____________________  Date: ____________',
    '',
    '---',
    'This template is generated from platform configuration as an aid. It is not legal advice,',
    'and completing it is the controller\'s responsibility, not the processor\'s.',
  ].join('\n');
}
