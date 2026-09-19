import { FixedClock, type TenantConfig } from '@detent/awa-core';
import { SandboxConnector } from '@detent/awa-connectors';
import { ScriptedModelProvider, type ScriptedTurn } from '@detent/awa-agent';
import { Platform, Api, ApiKeyService } from '@detent/awa-server';

/**
 * Shared fixture: a fully provisioned, live tenant with a sandbox CRM.
 *
 * Provisioning goes through the real lifecycle — DPA, connect, mapping, test
 * mode, live — rather than constructing a LIVE tenant directly, so every test
 * also exercises the gates it depends on.
 */
export interface Harness {
  readonly platform: Platform;
  readonly api: Api;
  readonly keys: ApiKeyService;
  readonly clock: FixedClock;
  readonly crm: SandboxConnector;
  readonly config: TenantConfig;
  readonly widgetKey: string;
  readonly adminKey: string;
  readonly platformKey: string;
}

export async function buildHarness(options: {
  tenantId?: string;
  script?: readonly ScriptedTurn[];
  crm?: SandboxConnector;
  /** Retry policy, so a reconciliation test does not sleep through a backoff. */
  adapter?: { maxAttempts?: number; sleep?: (ms: number) => Promise<void> };
  reconciliationMaxAttempts?: number;
} = {}): Promise<Harness> {
  const tenantId = options.tenantId ?? 't_acme';
  const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
  const crm = options.crm ?? new SandboxConnector({ hasSeparateLeadObject: true });
  const platform = new Platform({
    model: new ScriptedModelProvider(options.script ?? []),
    clock,
    connectors: [crm],
    adapter: options.adapter,
    reconciliationMaxAttempts: options.reconciliationMaxAttempts,
  });

  platform.tenants.create({
    tenantId,
    name: 'Acme Revenue Ltd',
    connector: 'sandbox',
    serviceCatalogue: ['contract-review', 'revenue-recovery', 'implementation'],
    outboundAllowlist: ['acme.co.uk', '.acme.co.uk'],
    // Registered browser origins. A widget key is refused from anywhere else
    // (audit SEC-5), so the fixture registers the tenant's own site.
    origins: ['https://www.acme.co.uk'],
  });

  await platform.tenants.recordDpa(tenantId, 'DPA-2026-0001');
  await platform.connectCrm(tenantId, 'sandbox', { kind: 'oauth2', accessToken: 'test-token' });
  await platform.tenants.transition(tenantId, 'CRM_CONNECTED', 'tenant');
  await platform.tenants.transition(tenantId, 'MAPPED', 'tenant');
  platform.tenants.acceptFieldMapping(tenantId);
  await platform.tenants.transition(tenantId, 'TEST_MODE', 'tenant');
  await platform.tenants.transition(tenantId, 'LIVE', 'tenant');
  // Step 9 of the generation pipeline: the tenant confirms the dry-run diff and
  // writes are enabled. Tests that exercise dry-run set it back on explicitly.
  // `dryRun` is operator-authority (audit SEC-6), so it goes through the
  // operator path rather than a tenant-admin patch.
  await platform.tenants.applyOperatorPatch(tenantId, { dryRun: false }, 'fixture');

  await platform.tenants.update(tenantId, {
    priceList: [
      {
        sku: 'contract-review',
        label: 'Contract review',
        price: { amount: 4500, currency: 'GBP', unit: 'per engagement' },
        conditions: ['Fixed scope of up to 25 contracts.'],
      },
      {
        sku: 'revenue-recovery',
        label: 'Revenue recovery programme',
        range: { min: 12000, max: 45000, currency: 'GBP', unit: 'per programme' },
        conditions: ['Twelve-week minimum term.'],
        rangeDrivers: ['contract volume', 'number of entities'],
      },
    ],
    requireApprovalForOpportunity: false,
  }, 'tenant_admin');

  // Governed knowledge: draft, then published by a named approver.
  const chunk = platform.corpus.ingest({
    tenantId,
    sourceKind: 'service_catalogue',
    sourceRef: 'services/contract-review',
    title: 'Contract review',
    text: 'Our contract review service audits commercial agreements for unbilled excess use, uplift clauses and renewal exposure. A fixed-scope engagement covers up to 25 contracts and is £4500.',
    shipped: true,
  });
  platform.corpus.publish(tenantId, chunk.id, 'marketing@acme.co.uk');

  const keys = new ApiKeyService();
  const api = new Api(platform, keys);
  const widgetKey = keys.issue(tenantId, 'widget').key;
  const adminKey = keys.issue(tenantId, 'tenant_admin').key;
  const platformKey = keys.issue('*platform*', 'platform_admin').key;

  return { platform, api, keys, clock, crm, config: platform.tenants.get(tenantId), widgetKey, adminKey, platformKey };
}

/**
 * Headers for an authenticated request.
 *
 * The origin travels with it because a widget key is bound to the tenant's
 * registered origins and is refused without one (audit SEC-5). The fixture's
 * tenant registers `https://www.acme.co.uk`.
 */
export function bearer(key: string, origin = 'https://www.acme.co.uk'): Record<string, string> {
  return { authorization: `Bearer ${key}`, origin };
}
