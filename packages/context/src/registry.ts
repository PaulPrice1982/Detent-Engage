import { AwaError } from '@detent/awa-core';
import type { Credential } from '@detent/awa-connectors';
import {
  assertReadOnlyUnlessEnabled,
  type AnySystemConnector, type SystemCategory, type WriteCapability,
} from './contract.js';
import type { ConnectedSystem } from './customer-context.js';

/**
 * Per-tenant registry of connected non-CRM systems.
 *
 * Registration is where the read-only rule is enforced (FR-083): a connector
 * declaring a write the tenant has not explicitly enabled is refused at
 * registration rather than at call time, so it never reaches a credential.
 */
export interface SystemRegistration {
  readonly tenantId: string;
  readonly connector: AnySystemConnector;
  readonly credential: Credential;
  readonly enabledWrites?: readonly WriteCapability[];
}

export class SystemRegistry {
  private readonly byTenant = new Map<string, ConnectedSystem[]>();

  register(registration: SystemRegistration): void {
    assertReadOnlyUnlessEnabled(registration.connector, registration.enabledWrites ?? []);

    const list = this.byTenant.get(registration.tenantId) ?? [];
    if (list.some((system) => system.connector.name === registration.connector.name)) {
      throw new AwaError({
        kind: 'CONFLICT',
        message: `system ${registration.connector.name} is already connected for tenant ${registration.tenantId}`,
        tenantId: registration.tenantId,
      });
    }
    list.push({ connector: registration.connector, credential: registration.credential });
    this.byTenant.set(registration.tenantId, list);
  }

  /** Bound by tenant, with no default and no overload that omits it. */
  async forTenant(tenantId: string): Promise<readonly ConnectedSystem[]> {
    return this.byTenant.get(tenantId) ?? [];
  }

  categories(tenantId: string): SystemCategory[] {
    return (this.byTenant.get(tenantId) ?? []).map((system) => system.connector.category);
  }

  /** Categories a tenant has not connected, disclosed to them per FR-085. */
  missingPriorityOne(tenantId: string): SystemCategory[] {
    const present = new Set(this.categories(tenantId));
    return (['billing', 'support', 'clm'] as SystemCategory[]).filter((category) => !present.has(category));
  }
}
