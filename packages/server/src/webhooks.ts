import { createHmac, timingSafeEqual } from 'node:crypto';
import { AwaError } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';

/**
 * Inbound change events (FR-020, section 22.4).
 *
 * Three properties are required and all three are tested against a recorded
 * event corpus: signature verification on every event, idempotency under
 * replay and duplication, and correct behaviour under reordering. Payloads
 * carry metadata only; a follow-up read fetches the record, because a payload
 * is a claim about state at some past moment and the record is the state now.
 */
export interface ChangeEvent {
  readonly event_id: string;
  readonly tenant_id: string;
  readonly connector: string;
  readonly object_type: 'person' | 'organisation' | 'opportunity';
  readonly external_id: string;
  readonly change_type: 'property_changed' | 'created' | 'deleted' | 'merged';
  /** The CRM's own last-modified timestamp. Ordering is decided by this. */
  readonly source_version: string;
  readonly attempt: number;
  /** Set for a merge event: the record id that survived. */
  readonly merged_into?: string;
}

export type EventOutcome = 'applied' | 'duplicate' | 'out_of_order' | 'rejected_signature' | 'remapped';

export class ChangeEventProcessor {
  /** Dedup key {event_id, tenant_id, attempt}, exactly as specified. */
  private readonly seen = new Set<string>();
  /** Last applied source_version per {tenant, connector, object, external id}. */
  private readonly lastApplied = new Map<string, string>();
  /** Identifier remapping after a merge; a merge can produce a new record id. */
  readonly identifierRemap = new Map<string, string>();

  constructor(private readonly audit: AuditLog) {}

  /**
   * Verify a vendor signature. Timing-safe, and a length mismatch is treated as
   * a failure rather than being allowed to short-circuit the comparison.
   */
  verifySignature(secret: string, rawBody: string, signature: string): boolean {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  async process(event: ChangeEvent, options: { signatureVerified: boolean }): Promise<EventOutcome> {
    if (!options.signatureVerified) {
      // An unsigned or mismatched event is a forgery attempt (table 34), not a
      // delivery problem. It is rejected and recorded as a security event.
      await this.audit.write({
        tenantId: event.tenant_id, type: 'cross_tenant_denied',
        correlationId: `evt_${event.event_id}`, actor: 'system',
        payload: { reason: 'webhook signature verification failed', connector: event.connector },
      });
      return 'rejected_signature';
    }

    const dedupKey = `${event.tenant_id}:${event.event_id}:${event.attempt}`;
    if (this.seen.has(dedupKey)) return 'duplicate';
    this.seen.add(dedupKey);

    const orderKey = `${event.tenant_id}:${event.connector}:${event.object_type}:${event.external_id}`;
    const last = this.lastApplied.get(orderKey);
    if (last !== undefined && event.source_version <= last) {
      // Discarded, never applied. Applying a stale event overwrites current
      // state with old state, which is worse than dropping it.
      return 'out_of_order';
    }
    this.lastApplied.set(orderKey, event.source_version);

    if (event.change_type === 'merged' && event.merged_into) {
      // Stored identifiers are remapped rather than assumed stable.
      this.identifierRemap.set(`${event.tenant_id}:${event.external_id}`, event.merged_into);
      return 'remapped';
    }

    return 'applied';
  }

  resolveIdentifier(tenantId: string, externalId: string): string {
    let current = externalId;
    const visited = new Set<string>();
    // Follow a chain of merges, guarding against a cycle in vendor data.
    while (this.identifierRemap.has(`${tenantId}:${current}`) && !visited.has(current)) {
      visited.add(current);
      current = this.identifierRemap.get(`${tenantId}:${current}`)!;
    }
    return current;
  }
}

export function parseChangeEvent(body: unknown): ChangeEvent {
  const event = body as Partial<ChangeEvent>;
  const required: (keyof ChangeEvent)[] = ['event_id', 'tenant_id', 'connector', 'object_type', 'external_id', 'change_type', 'source_version', 'attempt'];
  const missing = required.filter((key) => event[key] === undefined);
  if (missing.length > 0) {
    throw new AwaError({ kind: 'SCHEMA_INVALID', message: `change event missing: ${missing.join(', ')}` });
  }
  return event as ChangeEvent;
}
