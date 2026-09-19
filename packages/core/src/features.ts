/**
 * Feature flags (audit BIZ-1, UX-9).
 *
 * The audit's commercial finding was that breadth without a spine reads as
 * risk: three specification versions fully built, roughly a third of the code
 * unreachable from a browser, and nothing to say which parts are load-bearing.
 * The answer is not to delete the work, it is tested and correct, but to make
 * the shipping surface explicit. Everything beyond the v1.0 spine is off by
 * default and named here, so what a pilot runs is a decision rather than an
 * accident.
 */
export interface FeatureFlags {
  // --- v1.1 parity extension
  /** Governed crawl, generation and section-by-section approval. */
  readonly onboardingGeneration: boolean;
  /** Playbook authoring, versioning and the synthetic-buyer publish gate. */
  readonly studioSimulation: boolean;
  /** Outcome ledger and the per-outcome fee. */
  readonly outcomeBilling: boolean;
  /** Lane-two legitimate-interest follow-up. Gated again on a completed LIA. */
  readonly followUp: boolean;
  /** Proactive engagement, company resolution and paid enrichment. */
  readonly proactiveEngagement: boolean;
  // --- v1.2 unoccupied ground
  /** Customer context beyond the CRM (billing, support, CLM). */
  readonly customerContext: boolean;
  /** Step-up verification and the entitlement ladder. */
  readonly entitlementLadder: boolean;
  /** The seven conversational modes. */
  readonly conversationModes: boolean;
  /** Group hierarchy, partner registry and cross-entity identity. */
  readonly groupsAndPartners: boolean;
  /** The machine-readable buyer surface. */
  readonly machineSurface: boolean;
  /** The behavioural assurance pack. */
  readonly assurancePack: boolean;
  // --- commercial surfaces
  /** Self-serve trial provisioning and the public sign-up path. */
  readonly selfServeTrial: boolean;
  /** Streaming responses over server-sent events. */
  readonly streaming: boolean;
}

/**
 * The spine. Everything a pilot needs and nothing it does not: a governed
 * conversation, consent, policy, CRM writes behind a dry run, evidence.
 */
export const SPINE_FEATURES: FeatureFlags = {
  onboardingGeneration: true,
  studioSimulation: true,
  outcomeBilling: true,
  followUp: false,
  proactiveEngagement: false,
  customerContext: false,
  entitlementLadder: false,
  conversationModes: false,
  groupsAndPartners: false,
  machineSurface: false,
  assurancePack: true,
  selfServeTrial: false,
  streaming: true,
};

/** Everything on. Used by the demo, the test suite and the studio. */
export const ALL_FEATURES: FeatureFlags = {
  onboardingGeneration: true,
  studioSimulation: true,
  outcomeBilling: true,
  followUp: true,
  proactiveEngagement: true,
  customerContext: true,
  entitlementLadder: true,
  conversationModes: true,
  groupsAndPartners: true,
  machineSurface: true,
  assurancePack: true,
  selfServeTrial: true,
  streaming: true,
};

export function featuresFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  base: FeatureFlags = SPINE_FEATURES,
): FeatureFlags {
  const next = { ...base } as Record<string, boolean>;
  for (const key of Object.keys(base)) {
    // AWA_FEATURE_FOLLOW_UP=1 turns on `followUp`.
    const envKey = `AWA_FEATURE_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
    const raw = env[envKey];
    if (raw === undefined) continue;
    next[key] = raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'on';
  }
  return next as unknown as FeatureFlags;
}

export function requireFeature(flags: FeatureFlags, feature: keyof FeatureFlags): boolean {
  return flags[feature] === true;
}
