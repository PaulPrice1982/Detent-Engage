import {
  AwaError, DEFAULT_BRANDING, DEFAULT_DISCLOSURE, DEFAULT_ENGAGEMENT, DEFAULT_FOLLOW_UP,
  DEFAULT_LOCALES, DEFAULT_OUTCOMES, canConnectCrm, canGoLive, checkFieldAuthority,
  type Clock, type TenantConfig, type TenantState, systemClock,
} from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import { DEFAULT_OBJECTIONS, DEFAULT_QUALIFICATION_MODEL } from '@detent/awa-agent';
import { DEFAULT_HIGH_RISK_TOPICS } from '@detent/awa-policy';

/**
 * Tenant management and provisioning (section 23.4).
 *
 * The two lifecycle gates are enforced here and cannot be configured away: no
 * CRM connection before a DPA record exists, and no live traffic before a
 * field-mapping dry run has been accepted by the tenant. Both are gates, not
 * suggestions, and both are the kind of control a DPO asks to see evidence of.
 */
const LIFECYCLE: Readonly<Record<TenantState, readonly TenantState[]>> = {
  REGISTERED: ['DPA_SIGNED'],
  DPA_SIGNED: ['CRM_CONNECTED'],
  CRM_CONNECTED: ['MAPPED'],
  MAPPED: ['TEST_MODE'],
  TEST_MODE: ['LIVE'],
  LIVE: ['DEGRADED', 'SUSPENDED'],
  DEGRADED: ['LIVE', 'SUSPENDED'],
  SUSPENDED: ['OFFBOARDING', 'LIVE'],
  OFFBOARDING: [],
};

export interface CreateTenantInput {
  readonly tenantId: string;
  readonly name: string;
  readonly connector: string;
  readonly residency?: TenantConfig['residency'];
  readonly homeJurisdiction?: TenantConfig['homeJurisdiction'];
  readonly serviceCatalogue?: readonly string[];
  readonly outboundAllowlist?: readonly string[];
  readonly origins?: readonly string[];
  readonly locales?: TenantConfig['locales'];
  readonly branding?: TenantConfig['branding'];
}

export class TenantStore {
  private readonly tenants = new Map<string, TenantConfig>();

  constructor(
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
  ) {}

  create(input: CreateTenantInput): TenantConfig {
    if (this.tenants.has(input.tenantId)) {
      throw new AwaError({ kind: 'CONFLICT', message: `tenant ${input.tenantId} already exists` });
    }
    const config: TenantConfig = {
      tenantId: input.tenantId,
      name: input.name,
      version: 1,
      state: 'REGISTERED',
      residency: input.residency ?? 'UK',
      homeJurisdiction: input.homeJurisdiction ?? 'UK',
      connector: input.connector,
      promptVersion: 'prompt-2026.09.1',
      policyVersion: 'policy-2026.09.1',
      modelVersion: 'model-pinned-2026.09',
      disclosure: DEFAULT_DISCLOSURE,
      priceList: [],
      serviceCatalogue: input.serviceCatalogue ?? [],
      qualification: DEFAULT_QUALIFICATION_MODEL,
      escalation: {
        confidenceFloor: 0.65,
        negativeSentimentTurns: 2,
        highRiskTopics: DEFAULT_HIGH_RISK_TOPICS,
      },
      objections: DEFAULT_OBJECTIONS,
      spendCaps: {
        monthlyPence: 50_000,
        warnAtFraction: 0.7,
        degradeToTextAtFraction: 0.9,
        maxConcurrentVoice: 5,
        maxConversationsPerMonth: 5_000,
      },
      retention: { transcriptDays: 90, voiceRecordingDays: 30, leadPersonalDataDays: 730, auditDays: 2_555 },
      recording: { enabled: false, transcriptionEnabled: false, attachTranscriptToCrm: false, attachAudioToCrm: false },
      killSwitch: 'OFF',
      outboundAllowlist: input.outboundAllowlist ?? [],
      requireApprovalForOpportunity: true,
      playbookVersion: 0,
      // Every new tenant starts in dry-run. Writes are real and diffable but
      // land in a staging ledger until the tenant accepts the diff (FR-036).
      dryRun: true,
      followUp: DEFAULT_FOLLOW_UP,
      engagement: DEFAULT_ENGAGEMENT,
      outcomes: DEFAULT_OUTCOMES,
      // Registered web origins. Empty until install verification runs, and an
      // empty list means the widget key is refused from every browser origin
      // (audit SEC-5): failing closed is the point.
      origins: input.origins ?? [],
      locales: input.locales ?? DEFAULT_LOCALES,
      branding: input.branding ?? DEFAULT_BRANDING,
    };
    this.tenants.set(config.tenantId, config);
    return config;
  }

  get(tenantId: string): TenantConfig {
    const config = this.tenants.get(tenantId);
    if (!config) throw new AwaError({ kind: 'TENANT_NOT_FOUND', message: `tenant ${tenantId} not found` });
    return config;
  }

  list(): TenantConfig[] { return [...this.tenants.values()]; }

  /**
   * Update configuration. The version increments on every change so that a
   * conversation can be replayed against the exact configuration that produced
   * it, and the AI disclosure cannot be turned off (section 25.4).
   */
  async update(tenantId: string, patch: Partial<TenantConfig>, actor: string): Promise<TenantConfig> {
    const current = this.get(tenantId);

    // Per-field authority, checked before anything is applied (audit SEC-6).
    // The actor used to be written to the audit line and used for nothing,
    // which meant a tenant admin could raise their own spend cap and widen the
    // outbound allowlist the output validator uses to block exfiltration.
    const authority = checkFieldAuthority(patch as Record<string, unknown>, actor);
    if (!authority.allowed) {
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message: authority.unknown.length
          ? `unknown configuration field(s): ${authority.unknown.join(', ')}`
          : `${actor} may not change: ${authority.refused.join(', ')}`,
        details: { refused: authority.refused, unknown: authority.unknown, actor },
      });
    }

    if (patch.disclosure !== undefined) {
      const text = patch.disclosure.text?.trim() ?? '';
      const voice = patch.disclosure.voiceText?.trim() ?? '';
      if (text.length < 20 || voice.length < 20) {
        // Editable for tone; not removable. An empty or token disclosure is a
        // disabled disclosure by another name.
        throw new AwaError({
          kind: 'POLICY_DENIED',
          message: 'the AI disclosure cannot be removed or reduced below a meaningful statement',
        });
      }
    }
    if ('state' in patch) {
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'tenant state changes go through transition(), not update()' });
    }

    // Appended before the change takes effect, and awaited. The three writes in
    // this file used to be `void this.audit.write(...)`: a failed append on a
    // config or lifecycle change was discarded silently, which contradicts the
    // append-before-act guarantee stated everywhere else (audit SEC-10).
    await this.audit.write({
      tenantId, type: 'policy_allowed', correlationId: `cfg_${this.clock.nowMs()}`,
      actor: actor === 'platform' ? 'platform_admin' : 'tenant_admin',
      payload: { change: 'config_updated', fields: Object.keys(patch), version: current.version + 1 },
    });

    const next: TenantConfig = { ...current, ...patch, state: current.state, version: current.version + 1 };
    this.tenants.set(tenantId, next);
    return next;
  }

  async transition(tenantId: string, to: TenantState, actor: string): Promise<TenantConfig> {
    const current = this.get(tenantId);
    if (!LIFECYCLE[current.state].includes(to)) {
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message: `illegal tenant transition ${current.state} -> ${to}`,
      });
    }
    if (to === 'CRM_CONNECTED' && !canConnectCrm(current)) {
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'no CRM connection before a signed DPA record exists' });
    }
    if (to === 'LIVE' && !canGoLive({ ...current, state: 'TEST_MODE' })) {
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'no live traffic before the field-mapping dry run is accepted' });
    }

    await this.audit.write({
      tenantId, type: 'policy_allowed', correlationId: `lifecycle_${this.clock.nowMs()}`,
      actor: actor === 'platform' ? 'platform_admin' : 'tenant_admin',
      payload: { change: 'state', from: current.state, to },
    });

    const next: TenantConfig = { ...current, state: to, version: current.version + 1 };
    this.tenants.set(tenantId, next);
    return next;
  }

  async recordDpa(tenantId: string, reference: string): Promise<TenantConfig> {
    const current = this.get(tenantId);
    await this.audit.write({
      tenantId, type: 'policy_allowed', correlationId: `dpa_${this.clock.nowMs()}`,
      actor: 'tenant_admin', payload: { change: 'dpa_recorded', reference },
    });
    const next: TenantConfig = {
      ...current,
      dpaSignedAt: this.clock.iso(),
      version: current.version + 1,
    };
    this.tenants.set(tenantId, next);
    return this.transition(tenantId, 'DPA_SIGNED', 'tenant');
  }

  /**
   * Operator-authority fields, applied without an authority check.
   *
   * The distinction the audit asked for is between *who is asking* and *what
   * the platform itself does*: provisioning, origin verification and plan
   * changes are platform operations, and they call this. Anything reachable
   * from an API route goes through `update()`.
   */
  async applyOperatorPatch(tenantId: string, patch: Partial<TenantConfig>, reason: string): Promise<TenantConfig> {
    const current = this.get(tenantId);
    if ('state' in patch || 'tenantId' in patch || 'version' in patch) {
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'state, tenantId and version are not patchable' });
    }
    await this.audit.write({
      tenantId, type: 'policy_allowed', correlationId: `cfg_${this.clock.nowMs()}`,
      actor: 'platform_admin',
      payload: { change: 'operator_config_updated', fields: Object.keys(patch), reason },
    });
    const next: TenantConfig = { ...current, ...patch, state: current.state, version: current.version + 1 };
    this.tenants.set(tenantId, next);
    return next;
  }

  acceptFieldMapping(tenantId: string): TenantConfig {
    const current = this.get(tenantId);
    const next: TenantConfig = { ...current, fieldMappingAcceptedAt: this.clock.iso(), version: current.version + 1 };
    this.tenants.set(tenantId, next);
    return next;
  }
}
