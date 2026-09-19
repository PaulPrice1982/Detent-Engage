import {
  AwaError,
  FORBIDDEN_WRITE_FIELDS,
  type CanonicalActivity, type CanonicalOpportunity, type CanonicalOrganisation,
  type CanonicalOwner, type CanonicalPerson, type CanonicalPipeline,
  type CanonicalWriteEnvelope, type Clock, type WriteResult,
  systemClock, type Keyring, type SealedValue,
} from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';
import type { CapabilityDeclaration, Credential, CrmConnector, MatchCandidate, PersonQuery } from './contract.js';
import type { ConnectorRegistry } from './registry.js';
import { RateLimiter, backoffMs } from './rate-limit.js';
import type { ParkedWriteStore } from './reconciliation.js';
import { WriteReceiptService } from './receipts.js';

/**
 * The CRM adapter layer.
 *
 * Everything upstream speaks canonical; everything downstream speaks a specific
 * CRM. Three things live here rather than in connectors, because a rule that
 * lives in five connectors is a rule that will be wrong in one of them:
 *
 *  - source-of-truth enforcement (owner, lifecycle stage, pipeline and stage
 *    are never written, whatever the envelope says);
 *  - idempotency, via the write receipt, claimed before the call;
 *  - rate limiting and retry, sized per tenant below the vendor's limit.
 */
export type ConnectionState = 'CONNECTED' | 'DEGRADED' | 'DISCONNECTED';

export interface TenantConnection {
  readonly tenantId: string;
  readonly connector: string;
  readonly credential: Credential;
  state: ConnectionState;
  lastError?: string;
}

export interface ConnectionStore {
  get(tenantId: string): Promise<TenantConnection | undefined>;
  put(connection: TenantConnection): Promise<void>;
}

export class InMemoryConnectionStore implements ConnectionStore {
  private readonly connections = new Map<string, TenantConnection>();
  async get(tenantId: string): Promise<TenantConnection | undefined> { return this.connections.get(tenantId); }
  async put(connection: TenantConnection): Promise<void> { this.connections.set(connection.tenantId, connection); }
}

export interface AdapterOptions {
  readonly maxAttempts?: number;
  /** Injectable so tests do not actually sleep through a backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Where a retryable failure parks its envelope so the reconciliation worker
   * can replay it (audit PERF-8). Without one, a parked write leaves a receipt
   * and nothing to retry from.
   */
  readonly parked?: ParkedWriteStore;
}

export class CrmAdapter {
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly parked?: ParkedWriteStore;

  constructor(
    private readonly registry: ConnectorRegistry,
    private readonly connections: ConnectionStore,
    private readonly receipts: WriteReceiptService,
    private readonly audit: AuditLog,
    private readonly limiter: RateLimiter = new RateLimiter(),
    options: AdapterOptions = {},
    private readonly clock: Clock = systemClock,
  ) {
    this.maxAttempts = options.maxAttempts ?? 4;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.parked = options.parked;
  }

  private async resolve(tenantId: string): Promise<{ connection: TenantConnection; connector: CrmConnector }> {
    const connection = await this.connections.get(tenantId);
    if (!connection) {
      throw new AwaError({ kind: 'TENANT_NOT_FOUND', message: `no CRM connection for tenant ${tenantId}`, tenantId });
    }
    const connector = this.registry.get(connection.connector);
    if (!connector) {
      throw new AwaError({ kind: 'INTERNAL', message: `connector ${connection.connector} is not registered`, tenantId });
    }
    const capabilities = connector.capabilities();
    this.limiter.configure(tenantId, connector.name, 'default', capabilities.rateLimit.requestsPerSecond);
    this.limiter.configure(tenantId, connector.name, 'search', capabilities.rateLimit.searchRequestsPerSecond);
    return { connection, connector };
  }

  async capabilities(tenantId: string): Promise<CapabilityDeclaration> {
    const { connector } = await this.resolve(tenantId);
    return connector.capabilities();
  }

  async connectionState(tenantId: string): Promise<ConnectionState> {
    return (await this.connections.get(tenantId))?.state ?? 'DISCONNECTED';
  }

  // --- reads --------------------------------------------------------------

  async searchPerson(tenantId: string, query: PersonQuery): Promise<MatchCandidate[]> {
    const { connection, connector } = await this.resolve(tenantId);
    return this.call(tenantId, connector.name, 'search', () => connector.searchPerson(connection.credential, query));
  }

  async searchOrganisationByDomain(tenantId: string, domain: string): Promise<MatchCandidate[]> {
    const { connection, connector } = await this.resolve(tenantId);
    if (connector.capabilities().organisationResolutionByDomain === 'NONE') return [];
    return this.call(tenantId, connector.name, 'search', () => connector.searchOrganisation(connection.credential, { domain }));
  }

  async readOpportunities(tenantId: string, personExternalId: string): Promise<CanonicalOpportunity[]> {
    const { connection, connector } = await this.resolve(tenantId);
    const opportunities = await this.call(tenantId, connector.name, 'default', () => connector.readOpportunities(connection.credential, personExternalId));
    // Open/closed is resolved against the tenant's live pipeline configuration,
    // never against a hard-coded stage name (section 16.4).
    const pipelines = await this.readPipelines(tenantId);
    return opportunities.map((opportunity) => reconcileStage(opportunity, pipelines));
  }

  async readOwners(tenantId: string): Promise<CanonicalOwner[]> {
    const { connection, connector } = await this.resolve(tenantId);
    return this.call(tenantId, connector.name, 'default', () => connector.readOwners(connection.credential));
  }

  async readPipelines(tenantId: string): Promise<CanonicalPipeline[]> {
    const { connection, connector } = await this.resolve(tenantId);
    return this.call(tenantId, connector.name, 'default', () => connector.readPipelines(connection.credential));
  }

  // --- writes -------------------------------------------------------------

  /**
   * Execute one canonical write envelope.
   *
   * The envelope is rejected outright if it carries a forbidden field. That is
   * a deliberate belt-and-braces control: the tool schemas already exclude
   * owner and lifecycle stage, so an envelope containing one means something
   * upstream is wrong, and the correct response is to refuse, not to strip it
   * and proceed.
   */
  async write(envelope: CanonicalWriteEnvelope): Promise<WriteResult> {
    assertNoForbiddenFields(envelope);

    const { connection, connector } = await this.resolve(envelope.tenantId);
    if (connection.state !== 'CONNECTED') {
      throw new AwaError({
        kind: 'CONNECTION_DEGRADED',
        message: `tenant ${envelope.tenantId} connection is ${connection.state}; write must be parked`,
        tenantId: envelope.tenantId,
        correlationId: envelope.correlationId,
      });
    }

    const { receipt, alreadyConfirmed } = await this.receipts.claim({
      tenantId: envelope.tenantId,
      correlationId: envelope.correlationId,
      idempotencyKey: envelope.idempotencyKey,
      connector: connector.name,
      operation: envelope.operation,
    });

    if (alreadyConfirmed && receipt.externalId) {
      // A retried tool call returns the original record. This is the
      // difference between "at least once" and "exactly one CRM record".
      return { externalId: receipt.externalId, created: false, connector: connector.name, objectType: envelope.operation };
    }

    await this.audit.write({
      tenantId: envelope.tenantId,
      type: 'crm_write_attempted',
      correlationId: envelope.correlationId,
      actor: 'system',
      payload: { operation: envelope.operation, connector: connector.name, idempotencyKey: envelope.idempotencyKey },
    });

    try {
      const result = await this.call(envelope.tenantId, connector.name, 'default', () =>
        this.dispatch(connector, connection.credential, envelope),
      );
      await this.receipts.confirm(receipt, result.externalId);
      // Whatever route got here — first attempt or a replay — the write is
      // done, so it leaves the queue.
      await this.parked?.remove(envelope.tenantId, envelope.idempotencyKey);
      await this.audit.write({
        tenantId: envelope.tenantId,
        type: 'crm_write_confirmed',
        correlationId: envelope.correlationId,
        actor: 'system',
        payload: { operation: envelope.operation, externalId: result.externalId, created: result.created, convertedFromCreate: result.convertedFromCreate ?? false },
      });
      return result;
    } catch (cause) {
      const error = cause instanceof AwaError ? cause : new AwaError({ kind: 'INTERNAL', message: String(cause), cause });
      await this.receipts.fail(receipt, error.message, error.retryable);

      if (error.retryable || error.kind === 'CONNECTION_DEGRADED') {
        // The envelope is kept, not just the receipt: reconciliation needs
        // something to replay, and the idempotency key makes replaying safe.
        await this.parked?.put({
          tenantId: envelope.tenantId,
          idempotencyKey: envelope.idempotencyKey,
          envelope,
          parkedAt: this.clock.iso(),
          attempts: receipt.attempts,
          lastError: error.message,
        });
      }

      if (error.kind === 'CONNECTION_DEGRADED') {
        // Fail closed on the credential, fail open on the conversation
        // (flow 19). Writes park; the assistant keeps talking.
        await this.markDegraded(envelope.tenantId, error.message);
      }

      await this.audit.write({
        tenantId: envelope.tenantId,
        type: error.retryable || error.kind === 'CONNECTION_DEGRADED' ? 'crm_write_parked' : 'tool_call_failed',
        correlationId: envelope.correlationId,
        actor: 'system',
        payload: { operation: envelope.operation, kind: error.kind, message: error.message },
      });
      throw error;
    }
  }

  private dispatch(connector: CrmConnector, credential: Credential, envelope: CanonicalWriteEnvelope): Promise<WriteResult> {
    switch (envelope.operation) {
      case 'upsert_person':
        return connector.upsertPerson(credential, envelope.canonical as CanonicalPerson, envelope.idempotencyKey);
      case 'upsert_organisation':
        return connector.upsertOrganisation(credential, envelope.canonical as CanonicalOrganisation, envelope.idempotencyKey);
      case 'create_note':
        return connector.createNote(credential, envelope.canonical as CanonicalActivity, envelope.idempotencyKey);
      case 'create_task':
        return connector.createTask(credential, envelope.canonical as CanonicalActivity, envelope.idempotencyKey);
      case 'create_meeting':
        return connector.createMeeting(credential, envelope.canonical as CanonicalActivity, envelope.idempotencyKey);
      case 'associate': {
        const association = envelope.canonical as { fromType: string; fromId: string; toType: string; toId: string; associationType: never };
        return connector.associate(
          credential,
          { type: association.fromType, id: association.fromId },
          { type: association.toType, id: association.toId },
          association.associationType,
        );
      }
    }
  }

  async markDegraded(tenantId: string, reason: string): Promise<void> {
    const connection = await this.connections.get(tenantId);
    if (!connection || connection.state === 'DEGRADED') return;
    await this.connections.put({ ...connection, state: 'DEGRADED', lastError: reason });
    await this.audit.write({
      tenantId, type: 'connection_degraded', correlationId: `sys_${this.clock.nowMs()}`,
      actor: 'system', payload: { reason },
    });
  }

  async markConnected(tenantId: string, credential?: Credential): Promise<void> {
    const connection = await this.connections.get(tenantId);
    if (!connection) return;
    await this.connections.put({ ...connection, credential: credential ?? connection.credential, state: 'CONNECTED', lastError: undefined });
    await this.audit.write({
      tenantId, type: 'connection_restored', correlationId: `sys_${this.clock.nowMs()}`, actor: 'system',
    });
  }

  /**
   * Drain parked writes after a reconnect. Idempotent by construction: each
   * write re-claims its receipt, and one already confirmed is a no-op.
   */
  async reconcile(tenantId: string, envelopeFor: (idempotencyKey: string) => CanonicalWriteEnvelope | undefined): Promise<{ reconciled: number; stillFailing: number }> {
    const pending = await this.receipts.pendingReconciliation(tenantId);
    let reconciled = 0;
    let stillFailing = 0;
    for (const receipt of pending) {
      const envelope = envelopeFor(receipt.idempotencyKey);
      if (!envelope) { stillFailing++; continue; }
      try {
        await this.write(envelope);
        reconciled++;
        await this.audit.write({
          tenantId, type: 'crm_write_reconciled', correlationId: receipt.correlationId,
          actor: 'system', payload: { idempotencyKey: receipt.idempotencyKey, attempts: receipt.attempts },
        });
      } catch {
        stillFailing++;
      }
    }
    return { reconciled, stillFailing };
  }

  /**
   * Rate-limited call with backoff. Retry-After is honoured where the provider
   * supplies it; jitter is applied so a shared outage does not produce a
   * synchronised retry storm across tenants.
   */
  private async call<T>(tenantId: string, connector: string, channel: 'default' | 'search', fn: () => Promise<T>): Promise<T> {
    let lastError: AwaError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const waitMs = this.limiter.waitMs(tenantId, connector, channel);
      if (waitMs > 0) await this.sleep(waitMs);
      this.limiter.tryAcquire(tenantId, connector, channel);

      try {
        return await fn();
      } catch (cause) {
        const error = cause instanceof AwaError ? cause : new AwaError({ kind: 'INTERNAL', message: String(cause), cause });
        lastError = error;
        if (!error.retryable || attempt === this.maxAttempts) throw error;
        const delay = error.retryAfterSeconds !== undefined
          ? error.retryAfterSeconds * 1000
          : backoffMs(attempt);
        await this.sleep(delay);
      }
    }
    throw lastError ?? new AwaError({ kind: 'INTERNAL', message: 'retry loop exited without result' });
  }
}

/**
 * Operations where an activity is *assigned* to an owner. Assigning a task to
 * an owner reference that was read from the CRM is not the same thing as
 * writing ownership onto a person or an opportunity, and conflating the two
 * would make flow 5 impossible: a returning contact's owner must receive a
 * task, and that task has to land in the right person's queue.
 *
 * The distinction that keeps this safe is upstream: `ownerRef` on an activity
 * comes from a CRM read (`readOwners`, or the matched record's owner), never
 * from a model-supplied argument — no tool schema exposes an owner field.
 */
const ACTIVITY_OPERATIONS: ReadonlySet<CanonicalWriteEnvelope['operation']> = new Set([
  'create_note', 'create_task', 'create_meeting',
]);

export function assertNoForbiddenFields(envelope: CanonicalWriteEnvelope): void {
  const canonical = envelope.canonical as unknown as Record<string, unknown>;
  const applicable = ACTIVITY_OPERATIONS.has(envelope.operation)
    ? FORBIDDEN_WRITE_FIELDS.filter((field) => field !== 'ownerRef')
    : FORBIDDEN_WRITE_FIELDS;

  const offending = applicable.filter((field) => canonical[field] !== undefined);
  if (offending.length > 0) {
    throw new AwaError({
      kind: 'POLICY_DENIED',
      message: `write envelope contains CRM-authoritative fields: ${offending.join(', ')}`,
      tenantId: envelope.tenantId,
      correlationId: envelope.correlationId,
      details: { offending },
    });
  }
}

/** Resolve isOpen / isClosedWon against the tenant's live pipeline configuration. */
function reconcileStage(opportunity: CanonicalOpportunity, pipelines: readonly CanonicalPipeline[]): CanonicalOpportunity {
  for (const pipeline of pipelines) {
    const stage = pipeline.stages.find((s) => s.id === opportunity.stageRef);
    if (stage) {
      return { ...opportunity, stageLabel: stage.label, isOpen: stage.isOpen, isClosedWon: stage.isClosedWon };
    }
  }
  return opportunity;
}

/**
 * Credentials encrypted at rest (audit SEC-4).
 *
 * The finding: OAuth access tokens for every connected CRM of every tenant were
 * held as plain strings in a Map. The redaction layer keeps them out of logs;
 * nothing protected them at rest, so a heap dump, a core file or a debug
 * endpoint exposed live credentials for every tenant at once.
 *
 * This wraps any `ConnectionStore` and seals the credential before it is
 * written, opening it just in time on read. The plaintext exists only inside
 * the adapter's call stack; what the store holds — in memory, in Postgres, in a
 * backup — is ciphertext under a per-tenant data key.
 *
 * Rotation is `rewrap`: re-seal every stored credential under the current root
 * key. Ciphertext is rewritten and the plaintext never leaves this process.
 */
export interface SealedConnectionRecord {
  readonly tenantId: string;
  readonly connector: string;
  readonly state: ConnectionState;
  readonly lastError?: string;
  readonly credentialKind: Credential['kind'];
  readonly instanceUrl?: string;
  readonly expiresAt?: string;
  readonly region?: string;
  readonly sealed: SealedValue;
}

export interface SealedConnectionStore {
  get(tenantId: string): Promise<SealedConnectionRecord | undefined>;
  put(record: SealedConnectionRecord): Promise<void>;
  /** Every tenant holding a credential, for key rotation. */
  tenants(): Promise<string[]>;
}

export class InMemorySealedConnectionStore implements SealedConnectionStore {
  private readonly records = new Map<string, SealedConnectionRecord>();
  async get(tenantId: string): Promise<SealedConnectionRecord | undefined> { return this.records.get(tenantId); }
  async put(record: SealedConnectionRecord): Promise<void> { this.records.set(record.tenantId, record); }
  async tenants(): Promise<string[]> { return [...this.records.keys()]; }
}

export class EncryptedConnectionStore implements ConnectionStore {
  constructor(
    private readonly keyring: Keyring,
    private readonly store: SealedConnectionStore = new InMemorySealedConnectionStore(),
  ) {}

  async get(tenantId: string): Promise<TenantConnection | undefined> {
    const record = await this.store.get(tenantId);
    if (!record) return undefined;
    // The secret half is sealed; everything else is ordinary configuration and
    // is stored in the clear so an operator can see which CRM a tenant is on
    // without holding a key.
    const secret = JSON.parse(await this.keyring.open(tenantId, record.sealed)) as {
      accessToken: string; refreshToken?: string;
    };
    return {
      tenantId: record.tenantId,
      connector: record.connector,
      state: record.state,
      lastError: record.lastError,
      credential: {
        kind: record.credentialKind,
        accessToken: secret.accessToken,
        refreshToken: secret.refreshToken,
        instanceUrl: record.instanceUrl,
        expiresAt: record.expiresAt,
        region: record.region,
      },
    };
  }

  async put(connection: TenantConnection): Promise<void> {
    const sealed = await this.keyring.seal(connection.tenantId, JSON.stringify({
      accessToken: connection.credential.accessToken,
      refreshToken: connection.credential.refreshToken,
    }));
    await this.store.put({
      tenantId: connection.tenantId,
      connector: connection.connector,
      state: connection.state,
      lastError: connection.lastError,
      credentialKind: connection.credential.kind,
      instanceUrl: connection.credential.instanceUrl,
      expiresAt: connection.credential.expiresAt,
      region: connection.credential.region,
      sealed,
    });
  }

  /**
   * Re-seal every stored credential under the current root key.
   *
   * Returns how many were rewrapped. A tenant whose ciphertext cannot be opened
   * is reported rather than skipped silently: a credential that will not
   * decrypt is a connection that is about to fail, and the operator should hear
   * about it during a rotation rather than during a customer's conversation.
   */
  async rotateKeys(): Promise<{ rewrapped: number; failed: string[] }> {
    const failed: string[] = [];
    let rewrapped = 0;
    for (const tenantId of await this.store.tenants()) {
      const record = await this.store.get(tenantId);
      if (!record) continue;
      try {
        await this.store.put({ ...record, sealed: await this.keyring.rewrap(tenantId, record.sealed) });
        rewrapped += 1;
      } catch {
        failed.push(tenantId);
      }
    }
    return { rewrapped, failed };
  }

  /**
   * Replace a credential after a refresh, keeping everything else.
   *
   * The rotation path the error taxonomy already modelled and nothing
   * implemented: a refreshed access token is written back sealed, and a failed
   * refresh degrades the connection rather than silently retrying with a dead
   * token.
   */
  async refresh(tenantId: string, credential: Credential): Promise<void> {
    const existing = await this.store.get(tenantId);
    if (!existing) {
      throw new AwaError({ kind: 'TENANT_NOT_FOUND', message: `no CRM connection for tenant ${tenantId}`, tenantId });
    }
    await this.put({
      tenantId,
      connector: existing.connector,
      credential,
      state: 'CONNECTED',
    });
  }
}
