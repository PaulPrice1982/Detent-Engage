import type { AuditLog } from '@detent/awa-audit';
import { AwaError, type Clock, systemClock } from '@detent/awa-core';
import { format, type Money } from '@detent/awa-billing';
import { ForbiddenError, can, needsSecondPerson, type ConsoleCapability, type ConsoleUser } from './rbac.js';

/**
 * Two-person control for high-value operator actions.
 *
 * The rule this enforces has one job: **no single console account can move
 * significant money on its own.** That covers the careless case and the
 * compromised case with the same mechanism, which is why it is a control rather
 * than a policy in a handbook.
 *
 * Three properties matter, and each one exists because leaving it out is how
 * dual control is usually defeated:
 *
 *  - **The approver is not the requester.** Obvious, and the first thing people
 *    get wrong when they are in a hurry and hold both roles.
 *  - **The approved action is the requested action.** The request is fingerprinted
 *    at submission and re-checked at execution, so amending the amount after
 *    approval invalidates it rather than sailing through.
 *  - **Approval expires.** A standing approval on a forgotten request is a
 *    credential lying around.
 */

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'executed' | 'expired' | 'cancelled';

export interface OperatorAction {
  readonly actionId: string;
  readonly capability: ConsoleCapability;
  readonly accountId: string;
  readonly tenantId: string;
  /** Human-readable summary, shown to the approver. */
  readonly summary: string;
  readonly amount?: Money;
  /** Arguments the action will execute with. Fingerprinted. */
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly state: ApprovalState;
  readonly fingerprint: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
  readonly rejectedBy?: string;
  readonly rejectedAt?: string;
  readonly rejectionReason?: string;
  readonly executedAt?: string;
  readonly expiresAt: string;
}

export interface ApprovalStore {
  get(actionId: string): Promise<OperatorAction | undefined>;
  put(action: OperatorAction): Promise<void>;
  listPending(): Promise<readonly OperatorAction[]>;
  listByAccount(accountId: string): Promise<readonly OperatorAction[]>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly actions = new Map<string, OperatorAction>();
  async get(actionId: string): Promise<OperatorAction | undefined> {
    return this.actions.get(actionId);
  }
  async put(action: OperatorAction): Promise<void> {
    this.actions.set(action.actionId, action);
  }
  async listPending(): Promise<readonly OperatorAction[]> {
    return [...this.actions.values()]
      .filter((action) => action.state === 'pending')
      .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }
  async listByAccount(accountId: string): Promise<readonly OperatorAction[]> {
    return [...this.actions.values()]
      .filter((action) => action.accountId === accountId)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }
}

/**
 * Deterministic fingerprint of what was asked for.
 *
 * Keys are sorted so that an identical request fingerprints identically
 * regardless of property order, otherwise a re-serialised request looks like a
 * tampered one and every approval fails for the wrong reason.
 */
export function fingerprintOf(action: {
  readonly capability: string;
  readonly accountId: string;
  readonly amount?: Money;
  readonly arguments: Readonly<Record<string, unknown>>;
}): string {
  const canonical = JSON.stringify({
    capability: action.capability,
    accountId: action.accountId,
    amount: action.amount ? `${action.amount.currency}:${action.amount.amount}` : null,
    arguments: canonicalise(action.arguments),
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return entries.map(([key, nested]) => [key, canonicalise(nested)]);
  }
  return value;
}

export const APPROVAL_WINDOW_HOURS = 24;

export interface RequestActionInput {
  readonly actionId: string;
  readonly capability: ConsoleCapability;
  readonly accountId: string;
  readonly tenantId: string;
  readonly summary: string;
  readonly amount?: Money;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly reason: string;
  readonly requestedBy: ConsoleUser;
}

export class ApprovalService {
  constructor(
    private readonly store: ApprovalStore,
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
    private readonly windowHours = APPROVAL_WINDOW_HOURS,
  ) {}

  /**
   * Submits an action.
   *
   * Returns it already `approved` when no second person is required, so a
   * caller has exactly one path: request, then execute. A caller that could
   * skip the request for small amounts would eventually skip it for large ones.
   */
  async request(input: RequestActionInput): Promise<OperatorAction> {
    if (!can(input.requestedBy, input.capability)) {
      throw new ForbiddenError(input.capability, 'The requester does not hold this capability.');
    }
    if (!input.reason.trim()) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'An operator action requires a reason.' });
    }

    const now = this.clock.iso();
    const dual = needsSecondPerson(input.capability, input.amount);
    const args = input.arguments ?? {};
    const action: OperatorAction = {
      actionId: input.actionId,
      capability: input.capability,
      accountId: input.accountId,
      tenantId: input.tenantId,
      summary: input.summary,
      amount: input.amount,
      arguments: args,
      reason: input.reason,
      requestedBy: input.requestedBy.userId,
      requestedAt: now,
      state: dual ? 'pending' : 'approved',
      fingerprint: fingerprintOf({
        capability: input.capability, accountId: input.accountId,
        amount: input.amount, arguments: args,
      }),
      approvedBy: dual ? undefined : input.requestedBy.userId,
      approvedAt: dual ? undefined : now,
      expiresAt: new Date(Date.parse(now) + this.windowHours * 3_600_000).toISOString(),
    };
    await this.store.put(action);
    await this.audit.write({
      tenantId: input.tenantId, type: 'operator_action_requested', actor: 'platform_admin',
      correlationId: action.actionId,
      payload: {
        capability: action.capability, summary: action.summary,
        amount: action.amount ? format(action.amount) : undefined,
        reason: action.reason, requestedBy: action.requestedBy,
        requiresSecondPerson: dual, fingerprint: action.fingerprint,
      },
    });
    return action;
  }

  /** Approves a pending action. The approver may not be the requester. */
  async approve(actionId: string, approver: ConsoleUser): Promise<OperatorAction> {
    const action = await this.require(actionId);
    if (!can(approver, 'approval.grant')) {
      throw new ForbiddenError('approval.grant', 'The approver may not grant approvals.');
    }
    if (!can(approver, action.capability)) {
      // Approving what you could not do yourself is rubber-stamping: the
      // approver has to be able to judge the action, which means holding it.
      throw new ForbiddenError(action.capability, 'The approver does not hold the capability being approved.');
    }
    if (action.requestedBy === approver.userId) {
      throw new ForbiddenError(action.capability, 'An action cannot be approved by the person who requested it.');
    }
    if (action.state !== 'pending') {
      throw new AwaError({ kind: 'CONFLICT', message: `This action is ${action.state}, not pending.` });
    }
    if (action.expiresAt <= this.clock.iso()) {
      const expired = { ...action, state: 'expired' as const };
      await this.store.put(expired);
      throw new AwaError({ kind: 'CONFLICT', message: 'This action has expired. Request it again.' });
    }

    const approved: OperatorAction = {
      ...action, state: 'approved',
      approvedBy: approver.userId, approvedAt: this.clock.iso(),
    };
    await this.store.put(approved);
    await this.audit.write({
      tenantId: action.tenantId, type: 'operator_action_approved', actor: 'platform_admin',
      correlationId: action.actionId,
      payload: {
        capability: action.capability, approvedBy: approver.userId,
        requestedBy: action.requestedBy, fingerprint: action.fingerprint,
      },
    });
    return approved;
  }

  async reject(actionId: string, approver: ConsoleUser, reason: string): Promise<OperatorAction> {
    const action = await this.require(actionId);
    if (!can(approver, 'approval.grant')) {
      throw new ForbiddenError('approval.grant', 'The approver may not grant approvals.');
    }
    if (!reason.trim()) {
      throw new AwaError({ kind: 'SCHEMA_INVALID', message: 'A rejection requires a reason.' });
    }
    const rejected: OperatorAction = {
      ...action, state: 'rejected',
      rejectedBy: approver.userId, rejectedAt: this.clock.iso(), rejectionReason: reason,
    };
    await this.store.put(rejected);
    await this.audit.write({
      tenantId: action.tenantId, type: 'operator_action_rejected', actor: 'platform_admin',
      correlationId: action.actionId,
      payload: { capability: action.capability, rejectedBy: approver.userId, reason },
    });
    return rejected;
  }

  /**
   * Checks an approved action is still good, then marks it executed.
   *
   * The fingerprint is recomputed from the arguments the caller is about to use
   *, not read back from the record, because the attack this defends against
   * is approving £100 and executing £10,000.
   */
  async claim(actionId: string, executing: {
    readonly capability: ConsoleCapability;
    readonly accountId: string;
    readonly amount?: Money;
    readonly arguments: Readonly<Record<string, unknown>>;
  }): Promise<OperatorAction> {
    const action = await this.require(actionId);
    if (action.state === 'executed') {
      throw new AwaError({ kind: 'CONFLICT', message: 'This action has already been executed.' });
    }
    if (action.state !== 'approved') {
      throw new AwaError({ kind: 'CONFLICT', message: `This action is ${action.state}, not approved.` });
    }
    if (action.expiresAt <= this.clock.iso()) {
      await this.store.put({ ...action, state: 'expired' });
      throw new AwaError({ kind: 'CONFLICT', message: 'The approval has expired. Request it again.' });
    }
    const actual = fingerprintOf(executing);
    if (actual !== action.fingerprint) {
      throw new AwaError({
        kind: 'CONFLICT',
        message: 'What is being executed does not match what was approved. Request approval again.',
      });
    }

    const executed: OperatorAction = { ...action, state: 'executed', executedAt: this.clock.iso() };
    await this.store.put(executed);
    await this.audit.write({
      tenantId: action.tenantId, type: 'operator_action_executed', actor: 'platform_admin',
      correlationId: action.actionId,
      payload: {
        capability: action.capability, requestedBy: action.requestedBy,
        approvedBy: action.approvedBy, fingerprint: action.fingerprint,
        amount: action.amount ? format(action.amount) : undefined,
      },
    });
    return executed;
  }

  async pending(): Promise<readonly OperatorAction[]> {
    const now = this.clock.iso();
    const actions = await this.store.listPending();
    // Expiry is applied on read rather than by a sweeper: an expired approval
    // must never be actionable, and a sweeper that has not run yet is a window.
    return actions.filter((action) => action.expiresAt > now);
  }

  /** One action by id. Throws rather than returning undefined: a caller that
   *  reaches here already believes the action exists. */
  async forAction(actionId: string): Promise<OperatorAction> {
    return this.require(actionId);
  }

  async forAccount(accountId: string): Promise<readonly OperatorAction[]> {
    return this.store.listByAccount(accountId);
  }

  private async require(actionId: string): Promise<OperatorAction> {
    const action = await this.store.get(actionId);
    if (!action) throw new AwaError({ kind: 'NOT_FOUND', message: `No operator action ${actionId}.` });
    return action;
  }
}
