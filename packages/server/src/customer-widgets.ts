import { AwaError } from '@detent/awa-core';
import type { Account } from '@detent/awa-billing';
import type { ApiKeyService } from './auth.js';
import type { TenantStore } from './tenant-store.js';

/** Provisions customer identities in the same registry used by the serving API. */
export class CustomerWidgetProvisioner {
  private readonly issued = new Map<string, { accountId: string; key: string; keyId: string }>();

  snapshot() { return structuredClone([...this.issued.entries()]); }

  restore(records: ReturnType<CustomerWidgetProvisioner['snapshot']>): void {
    this.issued.clear();
    for (const [tenant, record] of structuredClone(records)) this.issued.set(tenant, record);
  }

  constructor(private readonly tenants: TenantStore, private readonly keys: ApiKeyService,
    private readonly defaultConnector = 'sandbox') {}

  provision(account: Pick<Account, 'accountId' | 'tenantId' | 'name'>): string {
    const existing = this.issued.get(account.tenantId);
    if (existing) {
      if (existing.accountId !== account.accountId) {
        throw new AwaError({ kind: 'POLICY_DENIED', message: 'The widget belongs to another account.' });
      }
      if (!this.keys.list(account.tenantId).some(key => key.id === existing.keyId && key.active)) {
        throw new AwaError({ kind: 'POLICY_DENIED', message: 'The widget key is inactive. Contact support.' });
      }
      return existing.key;
    }
    // Never adopt a boot/demo tenant merely because an account names its ID.
    if (!account.tenantId || this.tenants.list().some(tenant => tenant.tenantId === account.tenantId)) {
      throw new AwaError({ kind: 'CONFLICT', message: 'This tenant already exists outside customer provisioning.' });
    }
    this.tenants.create({
      tenantId: account.tenantId, name: account.name, connector: this.defaultConnector,
      // Onboarding must register origins and satisfy the ordinary lifecycle gates.
      origins: [],
    });
    const issued = this.keys.issue(account.tenantId, 'widget', { label: 'customer website' });
    this.issued.set(account.tenantId, { accountId: account.accountId, key: issued.key, keyId: issued.record.id });
    return issued.key;
  }
}
