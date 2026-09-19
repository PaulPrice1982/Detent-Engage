/**
 * Per-field configuration authority (audit SEC-6).
 *
 * `TenantStore.update()` used to validate exactly two things and spread the
 * rest. That let a tenant admin raise the spend cap the plan defines as
 * operator-controlled, and add any host to `outboundAllowlist`, which is
 * precisely the list the output validator uses to block link and image-beacon
 * exfiltration. The `actor` argument was written to the audit line and used for
 * nothing.
 *
 * Authority is declared per field here, once, and enforced in the store. A
 * field absent from this table is not editable by anyone through `update()`:
 * the default is refusal, so adding a field to `TenantConfig` cannot silently
 * open a hole.
 */
import type { TenantConfig } from './tenant.js';

export type FieldAuthority =
  /** The tenant's own copy, catalogue and thresholds. */
  | 'tenant'
  /** Commercial and containment controls. Operator only, whatever the plan. */
  | 'operator'
  /** Not settable through update() by any actor. */
  | 'system';

export type ConfigFieldAuthority = Readonly<Partial<Record<keyof TenantConfig, FieldAuthority>>>;

export const CONFIG_FIELD_AUTHORITY: ConfigFieldAuthority = {
  // --- the tenant's own product and voice
  name: 'tenant',
  disclosure: 'tenant',
  priceList: 'tenant',
  serviceCatalogue: 'tenant',
  qualification: 'tenant',
  objections: 'tenant',
  escalation: 'tenant',
  recording: 'tenant',
  bookingLinkUrl: 'tenant',
  requireApprovalForOpportunity: 'tenant',
  followUp: 'tenant',
  engagement: 'tenant',
  outcomes: 'tenant',
  privacyPolicyUrl: 'tenant',
  locales: 'tenant',
  branding: 'tenant',
  homeJurisdiction: 'tenant',

  // --- operator-controlled containment and commercials
  //
  // spendCaps is the ceiling the plan sells; outboundAllowlist is the
  // exfiltration control; killSwitch is the incident control; retention and
  // residency are contractual; the version pins are release management.
  spendCaps: 'operator',
  outboundAllowlist: 'operator',
  killSwitch: 'operator',
  retention: 'operator',
  residency: 'operator',
  connector: 'operator',
  origins: 'operator',
  promptVersion: 'operator',
  policyVersion: 'operator',
  modelVersion: 'operator',
  dryRun: 'operator',
  playbookVersion: 'operator',

  // --- never through update()
  tenantId: 'system',
  version: 'system',
  state: 'system',
  dpaSignedAt: 'system',
  fieldMappingAcceptedAt: 'system',
};

export interface AuthorityVerdict {
  readonly allowed: boolean;
  /** Fields the actor may not set, named so the refusal is actionable. */
  readonly refused: readonly string[];
  /** Fields not present in the authority table at all. */
  readonly unknown: readonly string[];
}

/**
 * Check a patch against an actor's authority.
 *
 * `platform_admin` may set tenant- and operator-authority fields. A tenant
 * admin may set tenant-authority fields only. Nobody sets a `system` field.
 */
export function checkFieldAuthority(
  patch: Readonly<Record<string, unknown>>,
  actor: 'tenant_admin' | 'platform_admin' | string,
): AuthorityVerdict {
  const isPlatform = actor === 'platform_admin' || actor === 'platform';
  const refused: string[] = [];
  const unknown: string[] = [];

  for (const field of Object.keys(patch)) {
    const authority = CONFIG_FIELD_AUTHORITY[field as keyof TenantConfig];
    if (authority === undefined) { unknown.push(field); continue; }
    if (authority === 'system') { refused.push(field); continue; }
    if (authority === 'operator' && !isPlatform) { refused.push(field); continue; }
  }
  return { allowed: refused.length === 0 && unknown.length === 0, refused, unknown };
}
