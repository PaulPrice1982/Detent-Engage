import { createHash } from 'node:crypto';
import type { AuditLog } from '@detent/awa-audit';
import type { HierarchyService } from './hierarchy.js';

/**
 * Cross-entity identity, and what it must not do (section 53.3).
 *
 * A visitor may be a customer of entity A and a prospect for entity B. The
 * resolved-entity layer can know this. Whether it may *act* on it is a
 * lawful-basis question with a different answer per group, so the default is
 * that it may not.
 *
 * The correct asymmetry, and worth stating in the sales conversation:
 * **suppression crosses where data does not.** A group can honour an opt-out
 * everywhere without pooling personal data anywhere.
 */
export interface GroupCountRow {
  /** Pseudonymised. Never reversible to an address. */
  readonly subjectDigest: string;
  readonly entityIds: readonly string[];
  readonly conversations: number;
}

export class GroupIdentityService {
  /** Pseudonymised counting only. No content, no addresses, no CRM data. */
  private readonly counts = new Map<string, Map<string, number>>();
  private readonly suppressed = new Set<string>();

  constructor(
    private readonly hierarchy: HierarchyService,
    private readonly audit: AuditLog,
    /** Per-group salt. Two groups never produce the same digest for a person. */
    private readonly saltFor: (groupId: string) => string,
  ) {}

  private digest(groupId: string, email: string): string {
    return createHash('sha256').update(`${this.saltFor(groupId)}:${email.trim().toLowerCase()}`).digest('hex');
  }

  /**
   * Count a conversation against the group, on a pseudonymised identifier, with
   * no content crossing (FR-077).
   */
  countConversation(groupId: string, entityId: string, email: string): void {
    const subject = this.digest(groupId, email);
    const key = `${groupId}:${subject}`;
    const perEntity = this.counts.get(key) ?? new Map<string, number>();
    perEntity.set(entityId, (perEntity.get(entityId) ?? 0) + 1);
    this.counts.set(key, perEntity);
  }

  /** Group reporting: one visitor counted once across entities. No content. */
  groupReport(groupId: string): { uniqueVisitors: number; rows: GroupCountRow[] } {
    const rows: GroupCountRow[] = [];
    for (const [key, perEntity] of this.counts) {
      if (!key.startsWith(`${groupId}:`)) continue;
      rows.push({
        subjectDigest: key.slice(groupId.length + 1, groupId.length + 13),
        entityIds: [...perEntity.keys()],
        conversations: [...perEntity.values()].reduce((a, b) => a + b, 0),
      });
    }
    return { uniqueVisitors: rows.length, rows };
  }

  /**
   * Group-wide suppression (FR-078). An opt-out at entity A suppresses at
   * entities B to H, immediately.
   */
  async suppressAcrossGroup(input: {
    groupId: string; email: string; originEntityId: string; correlationId: string;
  }): Promise<{ entitiesSuppressed: number }> {
    this.suppressed.add(this.digest(input.groupId, input.email));
    const entities = this.hierarchy.entitiesIn(input.groupId);

    // Written to every entity's own audit chain, because each is a separate
    // controller and each needs its own evidence that it honoured the opt-out.
    for (const entity of entities) {
      await this.audit.write({
        tenantId: entity.tenantId,
        type: 'consent_withdrawn',
        correlationId: input.correlationId,
        actor: 'visitor',
        payload: {
          change: 'group_wide_suppression',
          groupId: input.groupId,
          originEntityId: input.originEntityId,
          // No address. The digest is enough to prove the same person.
          subjectDigest: this.digest(input.groupId, input.email).slice(0, 12),
        },
      });
    }
    return { entitiesSuppressed: entities.length };
  }

  isSuppressedInGroup(groupId: string, email: string): boolean {
    return this.suppressed.has(this.digest(groupId, email));
  }

  /**
   * Whether entity B may be told the visitor is a customer of entity A.
   *
   * Off by default, and permitted only where the group operates a documented
   * joint-controller or shared-controller arrangement **and the visitor has
   * been told.** Both conditions, not either.
   */
  mayLearnCrossEntityRelationship(input: {
    groupId: string; readingEntityId: string; holdingEntityId: string;
    jointControllerArrangementDocumented: boolean; visitorInformed: boolean;
  }): { permitted: boolean; reason: string } {
    if (!input.jointControllerArrangementDocumented) {
      return { permitted: false, reason: 'no documented joint-controller arrangement for this group' };
    }
    if (!input.visitorInformed) {
      return { permitted: false, reason: 'the visitor has not been told that entities in this group share relationship status' };
    }
    if (!this.hierarchy.mayReadContent(input.groupId, input.holdingEntityId)) {
      return { permitted: false, reason: 'the holding entity has not granted access' };
    }
    return { permitted: true, reason: 'documented arrangement, visitor informed, and an explicit grant is in force' };
  }
}
