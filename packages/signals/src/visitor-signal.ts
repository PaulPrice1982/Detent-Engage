import { AwaError, type Clock, systemClock } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import type { ConsentService } from '@detent/awa-policy';

/**
 * The visitor signal service (section 43.3).
 *
 * Section 43.2 is the section that changes the design, and it is worth stating
 * plainly because the commercial pressure runs the other way:
 *
 * > **The lawful version of proactive engagement is company-level, not
 * > person-level, in any non-consented session.**
 *
 * That is a materially narrower product than what Warmly and Qualified market.
 * The position taken here is to sell the narrower version honestly rather than
 * match a claim that may not survive scrutiny.
 *
 * Concretely: this service will resolve a company from an IP address, and it
 * will never fingerprint, never persist an identifier without consent, and
 * never infer an individual from company-level data. Those are not settings.
 */
export type IdentityLevel = 'NONE' | 'COMPANY' | 'PERSON';

export interface BehaviouralSignal {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly pagePath: string;
  readonly dwellSeconds: number;
  readonly at: string;
}

export interface CompanyResolution {
  readonly companyName: string;
  readonly domain: string;
  readonly confidence: number;
  readonly source: 'reverse_ip';
}

export interface CompanyResolver {
  /** Company-level information from an IP. Never returns a person. */
  resolve(ip: string): Promise<CompanyResolution | undefined>;
}

/**
 * Per-tenant, short-retention behavioural store. Never shared across tenants,
 * never retained beyond the configured window.
 */
export class SignalStore {
  private readonly signals = new Map<string, BehaviouralSignal[]>();

  constructor(
    private readonly retentionSeconds: number,
    private readonly clock: Clock = systemClock,
  ) {}

  record(signal: BehaviouralSignal): void {
    const key = `${signal.tenantId}:${signal.sessionId}`;
    const list = this.signals.get(key) ?? [];
    list.push(signal);
    this.signals.set(key, list);
  }

  forSession(tenantId: string, sessionId: string): BehaviouralSignal[] {
    this.expire();
    return this.signals.get(`${tenantId}:${sessionId}`) ?? [];
  }

  private expire(): void {
    const cutoff = new Date(this.clock.nowMs() - this.retentionSeconds * 1000).toISOString();
    for (const [key, list] of this.signals) {
      const kept = list.filter((signal) => signal.at >= cutoff);
      if (kept.length === 0) this.signals.delete(key);
      else this.signals.set(key, kept);
    }
  }

  /** Purge everything for one tenant, for erasure and offboarding. */
  purgeTenant(tenantId: string): void {
    for (const key of [...this.signals.keys()]) {
      if (key.startsWith(`${tenantId}:`)) this.signals.delete(key);
    }
  }
}

export interface SessionSignalContext {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly subjectRef: string;
  readonly correlationId: string;
  /** The visitor's IP. Personal data: used only to resolve a company, never stored. */
  readonly ip?: string;
}

export class VisitorSignalService {
  constructor(
    private readonly store: SignalStore,
    private readonly consent: ConsentService,
    private readonly audit: AuditLog,
    private readonly resolver?: CompanyResolver,
  ) {}

  /**
   * Record an on-site behavioural signal.
   *
   * Permitted within a consented session; refused outside one. Behavioural
   * signals tied to a session identifier are personal data, and collecting them
   * without consent is the same Regulation 6 event as identity resolution.
   */
  async recordSignal(context: SessionSignalContext, signal: Omit<BehaviouralSignal, 'tenantId' | 'sessionId'>): Promise<boolean> {
    const consented = await this.consent.isGranted(context.tenantId, context.subjectRef, 'IDENTITY_RESOLUTION');
    if (!consented) {
      // Not an error, and not silent: the session simply operates without a
      // behavioural profile, which is the non-resolving mode v1.0 already
      // specifies.
      return false;
    }
    this.store.record({ ...signal, tenantId: context.tenantId, sessionId: context.sessionId });
    return true;
  }

  /**
   * Determine what identity level this session may operate at (FR-062).
   *
   * The gate is in code, not in policy documentation (risk 16). There is no
   * configuration that produces PERSON without a stored consent event.
   */
  async permittedIdentityLevel(context: SessionSignalContext): Promise<IdentityLevel> {
    const consented = await this.consent.isGranted(context.tenantId, context.subjectRef, 'IDENTITY_RESOLUTION');
    if (consented) return 'PERSON';
    // Company-level from a reverse IP lookup is generally company information,
    // and is permitted with care. It is never used to infer an individual.
    return this.resolver ? 'COMPANY' : 'NONE';
  }

  /**
   * Resolve the visiting company. Company-level only, always.
   *
   * Returns no person, and callers cannot ask it for one: the return type has
   * no person-shaped field, which is a cheaper guarantee than a rule everyone
   * has to remember.
   */
  async resolveCompany(context: SessionSignalContext): Promise<CompanyResolution | undefined> {
    if (!this.resolver || !context.ip) return undefined;

    const resolution = await this.resolver.resolve(context.ip);
    await this.audit.write({
      tenantId: context.tenantId,
      type: resolution ? 'resolution_complete' : 'resolution_started',
      correlationId: context.correlationId,
      sessionId: context.sessionId,
      actor: 'system',
      payload: {
        change: 'company_resolution',
        identityLevel: 'COMPANY',
        resolved: Boolean(resolution),
        // The IP itself is never recorded. Redaction would catch it anyway, but
        // not putting it here is the better control.
        domain: resolution?.domain,
      },
    });
    return resolution;
  }

  /**
   * The refusal path for any attempt to identify a person without consent.
   * Called by anything tempted to reach further than company level.
   */
  async refusePersonLevel(context: SessionSignalContext, attemptedBy: string): Promise<never> {
    await this.audit.write({
      tenantId: context.tenantId,
      type: 'resolution_blocked_no_consent',
      correlationId: context.correlationId,
      sessionId: context.sessionId,
      actor: 'policy',
      subjectRef: context.subjectRef,
      payload: { change: 'person_level_identification_refused', attemptedBy },
    });
    throw new AwaError({
      kind: 'CONSENT_REQUIRED',
      message: 'person-level identification requires a stored consent event',
      tenantId: context.tenantId,
      correlationId: context.correlationId,
    });
  }
}
