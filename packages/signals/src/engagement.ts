import type { TenantConfig } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import type { BehaviouralSignal, CompanyResolution, IdentityLevel } from './visitor-signal.js';

/**
 * The engagement rules engine (section 43.3, FR-061).
 *
 * Decides whether, when and how to proactively greet. Deterministic, per the
 * extended boundary table in section 48.2: the model composes the greeting, the
 * platform decides whether it may fire and at what identity level.
 *
 * The rule that matters most is the one about dismissal. A visitor who closed
 * the proactive greeting has answered, and re-opening it is the behaviour that
 * makes this whole category unpopular.
 */
export type EngagementDecision =
  | { readonly fire: false; readonly reason: string }
  | {
      readonly fire: true;
      readonly identityLevel: Exclude<IdentityLevel, 'NONE'>;
      readonly company?: CompanyResolution;
      readonly reason: string;
    };

export interface EngagementContext {
  readonly config: TenantConfig;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly identityLevel: IdentityLevel;
  readonly signals: readonly BehaviouralSignal[];
  readonly company?: CompanyResolution;
  /** True once the visitor has dismissed a proactive greeting this session. */
  readonly dismissedThisSession: boolean;
  /** True once the visitor has opened the assistant themselves. */
  readonly visitorAlreadyEngaged: boolean;
}

export class EngagementRulesEngine {
  private readonly fired = new Set<string>();

  constructor(private readonly audit: AuditLog) {}

  async evaluate(context: EngagementContext): Promise<EngagementDecision> {
    const decision = this.decide(context);

    await this.audit.write({
      tenantId: context.config.tenantId,
      type: decision.fire ? 'policy_allowed' : 'policy_denied',
      correlationId: context.correlationId,
      sessionId: context.sessionId,
      actor: 'policy',
      payload: {
        change: 'proactive_engagement',
        fire: decision.fire,
        reason: decision.reason,
        identityLevel: decision.fire ? decision.identityLevel : context.identityLevel,
      },
    });

    if (decision.fire) this.fired.add(`${context.config.tenantId}:${context.sessionId}`);
    return decision;
  }

  private decide(context: EngagementContext): EngagementDecision {
    const { config } = context;

    if (!config.engagement.enabled) {
      return { fire: false, reason: 'proactive engagement is not enabled for this tenant' };
    }

    // Never interrupt a visitor who has dismissed engagement in this session.
    if (config.engagement.respectInSessionDismissal && context.dismissedThisSession) {
      return { fire: false, reason: 'the visitor dismissed engagement in this session' };
    }

    if (context.visitorAlreadyEngaged) {
      return { fire: false, reason: 'the visitor has already opened the assistant' };
    }

    if (this.fired.has(`${config.tenantId}:${context.sessionId}`)) {
      return { fire: false, reason: 'proactive engagement has already fired in this session' };
    }

    if (context.identityLevel === 'NONE') {
      return { fire: false, reason: 'no lawful identity level available for this session' };
    }

    // Person-level proactive engagement requires consent, which is what
    // produced the PERSON level in the first place. A caller cannot pass PERSON
    // without it, because `permittedIdentityLevel` is the only thing that
    // returns it.
    if (context.identityLevel === 'COMPANY' && !config.engagement.companyLevelInNonConsentedSessions) {
      return { fire: false, reason: 'the tenant has disabled company-level engagement in non-consented sessions' };
    }

    const dwell = context.signals.reduce((total, signal) => total + signal.dwellSeconds, 0);
    const pages = new Set(context.signals.map((signal) => signal.pagePath)).size;

    // Thresholds exist so the greeting reads as relevant rather than as an
    // ambush on page load.
    if (dwell < config.engagement.minimumDwellSeconds) {
      return { fire: false, reason: `dwell ${dwell}s is below the ${config.engagement.minimumDwellSeconds}s threshold` };
    }
    if (pages < config.engagement.minimumPagesViewed) {
      return { fire: false, reason: `${pages} page(s) viewed is below the ${config.engagement.minimumPagesViewed} threshold` };
    }

    return {
      fire: true,
      identityLevel: context.identityLevel,
      company: context.company,
      reason: `dwell ${dwell}s across ${pages} pages at ${context.identityLevel} level`,
    };
  }

  /** Record a dismissal so it is honoured for the rest of the session. */
  noteDismissal(tenantId: string, sessionId: string): void {
    this.fired.add(`${tenantId}:${sessionId}`);
  }
}
