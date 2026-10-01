import { Keyring, type SealedValue } from '@detent/awa-core';
import type { ChainCheckpoint, CheckpointStore } from '@detent/awa-audit';
import type { ParkedWrite, ParkedWriteStore } from '@detent/awa-connectors';
import type { ApprovalStore, OperatorAction } from '@detent/awa-console';
import { type Database, PostgresAuditStore, PostgresConsentStore, PostgresUsageStore,
  PostgresConnectionStore, PostgresWriteReceiptStore, PostgresKnowledgeArchive,
  PostgresOutcomeStore, PostgresSuppressionStore, PostgresLedgerStore, PostgresSubscriptionStore } from '@detent/awa-persistence';
import type { PlatformOptions } from './platform.js';
import type { RuntimeArchive, RuntimeSnapshot } from './runtime-state.js';

/** Shared by the deployed entry point and restart integration tests. */
export function durablePlatformStores(db: Database, rootKey: string): Partial<PlatformOptions> {
  return {
    auditStore: new PostgresAuditStore(db), checkpointStore: new PostgresCheckpointStore(db),
    consentStore: new PostgresConsentStore(db), usageStore: new PostgresUsageStore(db),
    connectionStore: new PostgresConnectionStore(db, Buffer.from(rootKey, 'base64url').toString('base64')),
    receiptStore: new PostgresWriteReceiptStore(db), parkedWriteStore: new PostgresParkedWriteStore(db),
    knowledgeArchive: new PostgresKnowledgeArchive(db), outcomeStore: new PostgresOutcomeStore(db),
    suppressionStore: new PostgresSuppressionStore(db), ledgerStore: new PostgresLedgerStore(db),
    subscriptionStore: new PostgresSubscriptionStore(db),
  };
}

export class PostgresRuntimeArchive implements RuntimeArchive {
  constructor(private readonly db: Database, private readonly keyring: Keyring, private readonly id = 'runtime') {}

  async load(): Promise<RuntimeSnapshot | undefined> {
    const rows = await this.db.query<{ payload: SealedValue }>('SELECT payload FROM runtime_snapshot WHERE id = $1', [this.id]);
    return rows[0] ? JSON.parse(await this.keyring.open('*platform*', rows[0].payload)) as RuntimeSnapshot : undefined;
  }

  async save(snapshot: RuntimeSnapshot): Promise<void> {
    const payload = await this.keyring.seal('*platform*', JSON.stringify(snapshot));
    // Registry and snapshot commit together. A crash cannot leave a tenant
    // registered without the widget ownership/key needed to recover it.
    await this.db.transaction(async client => {
      for (const config of snapshot.tenants) {
        await client.query(`INSERT INTO tenant
          (tenant_id,name,state,residency,home_jurisdiction,connector,config_version,config,dpa_signed_at,field_mapping_accepted_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (tenant_id) DO UPDATE SET name=EXCLUDED.name,state=EXCLUDED.state,
          residency=EXCLUDED.residency,home_jurisdiction=EXCLUDED.home_jurisdiction,
          connector=EXCLUDED.connector,config_version=EXCLUDED.config_version,config=EXCLUDED.config,
          dpa_signed_at=EXCLUDED.dpa_signed_at,field_mapping_accepted_at=EXCLUDED.field_mapping_accepted_at,
          updated_at=now()`, [config.tenantId, config.name, config.state, config.residency,
          config.homeJurisdiction, config.connector, config.version, JSON.stringify(config),
          config.dpaSignedAt ?? null, config.fieldMappingAcceptedAt ?? null]);
      }
      await client.query(`INSERT INTO runtime_snapshot (id,payload) VALUES ($1,$2)
        ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=now()`, [this.id, JSON.stringify(payload)]);
    });
  }
}

export class PostgresCheckpointStore implements CheckpointStore {
  readonly durable = true;
  constructor(private readonly db: Database) {}
  async latest(tenantId: string): Promise<ChainCheckpoint | undefined> {
    const rows = await this.db.queryAs(tenantId, 'SELECT * FROM audit_checkpoint WHERE tenant_id=$1 ORDER BY sequence DESC LIMIT 1', [tenantId]);
    const row = rows[0];
    return row ? { tenantId, sequence: Number(row['sequence']), hash: String(row['hash']),
      signature: String(row['signature']), verifiedAt: new Date(row['verified_at']).toISOString() } : undefined;
  }
  async put(c: ChainCheckpoint): Promise<void> {
    await this.db.queryAs(c.tenantId, `INSERT INTO audit_checkpoint (tenant_id,sequence,hash,verified_at,signature)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id,sequence) DO NOTHING`, [c.tenantId,c.sequence,c.hash,c.verifiedAt,c.signature]);
  }
}

export class PostgresParkedWriteStore implements ParkedWriteStore {
  readonly durable = true;
  constructor(private readonly db: Database) {}
  async put(p: ParkedWrite): Promise<void> {
    await this.db.queryAs(p.tenantId, `INSERT INTO parked_write (tenant_id,idempotency_key,payload) VALUES ($1,$2,$3)
      ON CONFLICT (tenant_id,idempotency_key) DO UPDATE SET payload=EXCLUDED.payload`, [p.tenantId,p.idempotencyKey,JSON.stringify(p)]);
  }
  async remove(tenant: string, key: string): Promise<void> {
    await this.db.queryAs(tenant, 'DELETE FROM parked_write WHERE tenant_id=$1 AND idempotency_key=$2', [tenant,key]);
  }
  async list(tenant: string): Promise<ParkedWrite[]> {
    const rows = await this.db.queryAs<{payload: ParkedWrite}>(tenant, 'SELECT payload FROM parked_write WHERE tenant_id=$1', [tenant]);
    return rows.map(r => r.payload);
  }
  async tenants(): Promise<string[]> {
    const tenants = await this.db.query<{tenant_id: string}>('SELECT tenant_id FROM tenant');
    const pending: string[] = [];
    for (const tenant of tenants) if ((await this.list(tenant.tenant_id)).length) pending.push(tenant.tenant_id);
    return pending;
  }
}

export class PostgresApprovalStore implements ApprovalStore {
  constructor(private readonly db: Database) {}
  async get(id: string): Promise<OperatorAction | undefined> {
    const rows = await this.db.query<{payload: OperatorAction}>('SELECT payload FROM operator_approval WHERE action_id=$1', [id]);
    return rows[0]?.payload;
  }
  async put(action: OperatorAction): Promise<void> {
    await this.db.query(`INSERT INTO operator_approval (action_id,payload) VALUES ($1,$2)
      ON CONFLICT (action_id) DO UPDATE SET payload=EXCLUDED.payload`, [action.actionId,JSON.stringify(action)]);
  }
  async listPending(): Promise<readonly OperatorAction[]> {
    const rows = await this.db.query<{payload: OperatorAction}>("SELECT payload FROM operator_approval WHERE payload->>'state'='pending' ORDER BY payload->>'requestedAt'");
    return rows.map(r => r.payload);
  }
  async listByAccount(id: string): Promise<readonly OperatorAction[]> {
    const rows = await this.db.query<{payload: OperatorAction}>("SELECT payload FROM operator_approval WHERE payload->>'accountId'=$1 ORDER BY payload->>'requestedAt' DESC", [id]);
    return rows.map(r => r.payload);
  }
}
