/**
 * Canonical data model (section 21.1).
 *
 * Nothing upstream of the adapter layer knows which CRM a tenant uses. The
 * canonical model owns the lead-versus-contact split so that connectors never
 * improvise it, and it carries `qualificationState` precisely so a lead-based
 * CRM is never handed a Contact for an unqualified visitor.
 */

export type QualificationState =
  | 'UNQUALIFIED'
  | 'CAPTURED'
  | 'QUALIFIED'
  | 'DISQUALIFIED';

export interface CanonicalName {
  readonly given?: string;
  readonly family?: string;
  readonly full?: string;
}

export interface CanonicalPerson {
  readonly id?: string;
  readonly emails: readonly string[];
  readonly phones?: readonly string[];
  readonly name?: CanonicalName;
  readonly jobTitle?: string;
  readonly timezone?: string;
  readonly qualificationState: QualificationState;
  readonly organisation?: CanonicalOrganisation;
  readonly consentRefs?: readonly string[];
  /** Per-tenant custom fields, resolved through the custom-field registry. */
  readonly custom?: Readonly<Record<string, string | number | boolean>>;
}

export interface CanonicalOrganisation {
  readonly id?: string;
  readonly name?: string;
  readonly domains: readonly string[];
  readonly sizeBand?: string;
  readonly custom?: Readonly<Record<string, string | number | boolean>>;
}

export interface CanonicalOpportunity {
  readonly id: string;
  readonly personRef?: string;
  readonly organisationRef?: string;
  readonly pipelineRef?: string;
  readonly stageRef?: string;
  readonly stageLabel?: string;
  readonly ownerRef?: string;
  readonly isOpen: boolean;
  readonly isClosedWon?: boolean;
  readonly amount?: number;
  readonly currency?: string;
}

export type ActivityType = 'note' | 'task' | 'meeting' | 'call';

export interface CanonicalActivity {
  readonly type: ActivityType;
  readonly subject: string;
  readonly body?: string;
  readonly personRef?: string;
  readonly organisationRef?: string;
  readonly opportunityRef?: string;
  readonly ownerRef?: string;
  readonly occurredAt?: string;
  readonly startsAt?: string;
  readonly endsAt?: string;
  readonly dueAt?: string;
}

export interface CanonicalOwner {
  readonly id: string;
  readonly name: string;
  readonly email?: string;
  readonly teamRef?: string;
  readonly active: boolean;
}

export interface CanonicalStage {
  readonly id: string;
  readonly label: string;
  readonly isOpen: boolean;
  readonly isClosedWon: boolean;
  readonly order: number;
}

export interface CanonicalPipeline {
  readonly id: string;
  readonly label: string;
  readonly stages: readonly CanonicalStage[];
}

export type AssociationType =
  | 'person_to_organisation'
  | 'activity_to_person'
  | 'activity_to_organisation'
  | 'activity_to_opportunity'
  | 'opportunity_to_person';

/**
 * Fields the assistant may never write, in any CRM, under any configuration.
 * Enforced by the adapter layer, not by connector discipline (section 22.3).
 */
export const FORBIDDEN_WRITE_FIELDS = [
  'owner',
  'ownerId',
  'ownerRef',
  'lifecycle_stage',
  'lifecycleStage',
  'pipeline',
  'pipelineRef',
  'stage',
  'stageRef',
] as const;

export type ForbiddenWriteField = (typeof FORBIDDEN_WRITE_FIELDS)[number];

export type CanonicalOperation =
  | 'upsert_person'
  | 'upsert_organisation'
  | 'create_note'
  | 'create_task'
  | 'create_meeting'
  | 'associate';

/** Canonical write envelope (section 22.3). Every external write is one of these. */
export interface CanonicalWriteEnvelope {
  readonly tenantId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly operation: CanonicalOperation;
  readonly canonical:
    | CanonicalPerson
    | CanonicalOrganisation
    | CanonicalActivity
    | CanonicalAssociation;
  readonly sourceOfTruthPolicy: 'assistant_may_write_contact_fields_only';
  readonly forbiddenFields: readonly ForbiddenWriteField[];
}

export interface CanonicalAssociation {
  readonly fromType: 'person' | 'organisation' | 'activity' | 'opportunity';
  readonly fromId: string;
  readonly toType: 'person' | 'organisation' | 'activity' | 'opportunity';
  readonly toId: string;
  readonly associationType: AssociationType;
}

export interface WriteResult {
  readonly externalId: string;
  readonly created: boolean;
  readonly connector: string;
  readonly objectType: string;
  /** Set when a create was converted into an update on a duplicate response. */
  readonly convertedFromCreate?: boolean;
}

export type WriteReceiptState = 'PENDING' | 'CONFIRMED' | 'FAILED' | 'RECONCILING';

export interface WriteReceipt {
  readonly id: string;
  readonly tenantId: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly connector: string;
  readonly operation: CanonicalOperation;
  readonly state: WriteReceiptState;
  readonly externalId?: string;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastError?: string;
}
