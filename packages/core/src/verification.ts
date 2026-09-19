/**
 * The verification ladder (section 55.3).
 *
 * Contract data is the most sensitive material the assistant will touch, and
 * identity verification for contract questions is deliberately stricter than
 * for lead qualification. **A confirmed email match is insufficient.**
 *
 * Level 2 is the practical working level: a one-time code to the address on the
 * contract. That is a small amount of friction that buys a large amount of
 * safety, and it is friction a customer asking about their own contract will
 * accept without complaint.
 */
export type VerificationLevel = 0 | 1 | 2 | 3;

export interface VerificationLevelDefinition {
  readonly level: VerificationLevel;
  readonly label: string;
  readonly reachedBy: string;
  readonly permits: string;
}

export const VERIFICATION_LADDER: Readonly<Record<VerificationLevel, VerificationLevelDefinition>> = {
  0: {
    level: 0, label: 'Anonymous', reachedBy: 'no identifier supplied',
    permits: 'no entitlement data and no relationship signals at all',
  },
  1: {
    level: 1, label: 'Email stated', reachedBy: 'the visitor stated an email address',
    permits: 'relationship and standing bands, never disclosed — behaviour only',
  },
  2: {
    level: 2, label: 'Email verified', reachedBy: 'a one-time code sent to the address on the contract',
    permits: 'confirming in-scope or out-of-scope at category level. No clause text',
  },
  3: {
    level: 3, label: 'Authenticated portal handoff', reachedBy: 'SSO or OIDC handoff from the tenant',
    permits: 'citing clause text from their own executed agreement',
  },
};

/** What a given level permits, as a machine-checkable capability set. */
export type VerificationCapability =
  | 'relationship_band'
  | 'standing_band'
  | 'entitlement_category'
  | 'clause_text';

const CAPABILITIES: Readonly<Record<VerificationLevel, readonly VerificationCapability[]>> = {
  0: [],
  1: ['relationship_band', 'standing_band'],
  2: ['relationship_band', 'standing_band', 'entitlement_category'],
  3: ['relationship_band', 'standing_band', 'entitlement_category', 'clause_text'],
};

export function permits(level: VerificationLevel, capability: VerificationCapability): boolean {
  return CAPABILITIES[level].includes(capability);
}

/** The minimum level a capability requires. Used to say what is still needed. */
export function levelRequiredFor(capability: VerificationCapability): VerificationLevel {
  for (const level of [0, 1, 2, 3] as VerificationLevel[]) {
    if (permits(level, capability)) return level;
  }
  return 3;
}

/**
 * Escalate to a human at any level where the request exceeds the level reached.
 * Returns the shortfall so the caller can say what would be needed, without
 * implying that the platform will do it automatically.
 */
export interface LadderVerdict {
  readonly permitted: boolean;
  readonly reached: VerificationLevel;
  readonly required: VerificationLevel;
  readonly escalate: boolean;
  readonly reason: string;
}

export function checkLadder(reached: VerificationLevel, capability: VerificationCapability): LadderVerdict {
  const required = levelRequiredFor(capability);
  const permitted = permits(reached, capability);
  return {
    permitted,
    reached,
    required,
    // Exceeding the level reached is not a refusal to the visitor's face: it is
    // a handoff, because the question is legitimate and the answer exists.
    escalate: !permitted,
    reason: permitted
      ? `level ${reached} permits ${capability}`
      : `${capability} requires level ${required} (${VERIFICATION_LADDER[required].label}); level ${reached} reached`,
  };
}
