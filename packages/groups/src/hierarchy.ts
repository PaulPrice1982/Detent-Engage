import { AwaError, createHash_, type Clock, systemClock } from './crypto-shim.js';
import type { AuditLog } from '@detent/awa-audit';

/**
 * Group, entity and site hierarchy (section 53).
 *
 * **The critical rule: the group is a billing and reporting construct, not a
 * data-sharing construct.** Two entities in the same group are still two
 * tenants under section 14 row-level security. Entities in a portfolio are
 * frequently competitors of one another and are always separate controllers.
 *
 * Group-level visibility into conversation content requires an explicit,
 * auditable grant from the entity. There is no configuration flag that turns it
 * on quietly, and the default is off.
 */
export interface Group {
  readonly groupId: string;
  readonly name: string;
  /** Contract, billing, group reporting, shared knowledge, brand, policy floor. */
  readonly policyFloor: PolicyFloor;
  readonly createdAt: string;
}

/**
 * A floor, not a ceiling. An entity may be stricter than the group; it can
 * never be more permissive. That asymmetry is what makes a group-level
 * commitment to a regulator or a procurement function meaningful.
 */
export interface PolicyFloor {
  readonly minimumConfidenceFloor: number;
  readonly recordingAllowed: boolean;
  readonly followUpLaneTwoAllowed: boolean;
  readonly requireApprovalForOpportunity: boolean;
}

export interface Entity {
  readonly entityId: string;
  readonly groupId: string;
  /** The tenant id. An entity *is* a tenant: isolation is unchanged. */
  readonly tenantId: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface Site {
  readonly siteId: string;
  readonly entityId: string;
  readonly domain: string;
}

export type ContentGrantScope = 'AGGREGATE_ONLY' | 'CONVERSATION_CONTENT';

export interface ContentGrant {
  readonly grantId: string;
  readonly groupId: string;
  readonly entityId: string;
  readonly scope: ContentGrantScope;
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
  /** The lawful basis the group asserted. Recorded, never assumed. */
  readonly basis: string;
}

export class HierarchyService {
  private readonly groups = new Map<string, Group>();
  private readonly entities = new Map<string, Entity>();
  private readonly sites = new Map<string, Site>();
  private readonly grants: ContentGrant[] = [];

  constructor(
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
  ) {}

  createGroup(input: { groupId: string; name: string; policyFloor: PolicyFloor }): Group {
    if (this.groups.has(input.groupId)) {
      throw new AwaError({ kind: 'CONFLICT', message: `group ${input.groupId} already exists` });
    }
    const group: Group = { ...input, createdAt: this.clock.iso() };
    this.groups.set(group.groupId, group);
    return group;
  }

  addEntity(input: { entityId: string; groupId: string; tenantId: string; name: string }): Entity {
    if (!this.groups.has(input.groupId)) {
      throw new AwaError({ kind: 'NOT_FOUND', message: `group ${input.groupId} not found` });
    }
    const entity: Entity = { ...input, createdAt: this.clock.iso() };
    this.entities.set(entity.entityId, entity);
    return entity;
  }

  addSite(input: { siteId: string; entityId: string; domain: string }): Site {
    if (!this.entities.has(input.entityId)) {
      throw new AwaError({ kind: 'NOT_FOUND', message: `entity ${input.entityId} not found` });
    }
    const site: Site = { ...input };
    this.sites.set(site.siteId, site);
    return site;
  }

  entitiesIn(groupId: string): Entity[] {
    return [...this.entities.values()].filter((entity) => entity.groupId === groupId);
  }

  entityForTenant(tenantId: string): Entity | undefined {
    return [...this.entities.values()].find((entity) => entity.tenantId === tenantId);
  }

  groupFor(tenantId: string): Group | undefined {
    const entity = this.entityForTenant(tenantId);
    return entity ? this.groups.get(entity.groupId) : undefined;
  }

  /**
   * Grant group-level access to an entity's conversation content.
   *
   * Explicit, auditable, revocable, and granted **by the entity**, because the
   * entity is the controller. A group administrator cannot grant themselves
   * access to a portfolio company's conversations.
   */
  async grantContentAccess(input: {
    groupId: string; entityId: string; grantedBy: string; basis: string;
    correlationId: string; expiresAt?: string;
  }): Promise<ContentGrant> {
    const entity = this.entities.get(input.entityId);
    if (!entity || entity.groupId !== input.groupId) {
      throw new AwaError({ kind: 'NOT_FOUND', message: `entity ${input.entityId} is not in group ${input.groupId}` });
    }
    const grant: ContentGrant = {
      grantId: `grant_${createHash_(`${input.entityId}:${this.clock.nowMs()}`)}`,
      groupId: input.groupId,
      entityId: input.entityId,
      scope: 'CONVERSATION_CONTENT',
      grantedBy: input.grantedBy,
      grantedAt: this.clock.iso(),
      expiresAt: input.expiresAt,
      basis: input.basis,
    };
    this.grants.push(grant);

    await this.audit.write({
      tenantId: entity.tenantId,
      type: 'break_glass_access',
      correlationId: input.correlationId,
      actor: 'tenant_admin',
      payload: {
        change: 'group_content_grant',
        groupId: input.groupId, grantId: grant.grantId,
        grantedBy: input.grantedBy, basis: input.basis, expiresAt: input.expiresAt,
      },
    });
    return grant;
  }

  async revokeContentAccess(grantId: string, correlationId: string): Promise<void> {
    const index = this.grants.findIndex((grant) => grant.grantId === grantId);
    if (index < 0) return;
    const grant = this.grants[index]!;
    this.grants[index] = { ...grant, revokedAt: this.clock.iso() };
    const entity = this.entities.get(grant.entityId);
    if (entity) {
      await this.audit.write({
        tenantId: entity.tenantId, type: 'break_glass_access', correlationId,
        actor: 'tenant_admin', payload: { change: 'group_content_grant_revoked', grantId },
      });
    }
  }

  /**
   * The check every group-reporting read must pass. Aggregate is always
   * permitted; content requires a live grant from that specific entity.
   */
  mayReadContent(groupId: string, entityId: string): boolean {
    const now = this.clock.iso();
    return this.grants.some((grant) =>
      grant.groupId === groupId &&
      grant.entityId === entityId &&
      grant.scope === 'CONVERSATION_CONTENT' &&
      !grant.revokedAt &&
      (!grant.expiresAt || grant.expiresAt > now),
    );
  }

  /**
   * Apply the group policy floor to an entity's own settings. An entity may be
   * stricter; it can never be more permissive.
   */
  applyPolicyFloor<T extends {
    escalation: { confidenceFloor: number };
    recording: { enabled: boolean };
    followUp: { enabled: boolean };
    requireApprovalForOpportunity: boolean;
  }>(groupId: string, config: T): T {
    const group = this.groups.get(groupId);
    if (!group) return config;
    const floor = group.policyFloor;
    return {
      ...config,
      escalation: {
        ...config.escalation,
        confidenceFloor: Math.max(config.escalation.confidenceFloor, floor.minimumConfidenceFloor),
      },
      recording: { ...config.recording, enabled: config.recording.enabled && floor.recordingAllowed },
      followUp: { ...config.followUp, enabled: config.followUp.enabled && floor.followUpLaneTwoAllowed },
      requireApprovalForOpportunity:
        config.requireApprovalForOpportunity || floor.requireApprovalForOpportunity,
    };
  }
}
