import { money, type Money } from '@detent/awa-billing';

/**
 * Who may do what in the Detent operator console.
 *
 * The console is the most dangerous surface in the product. Everything else
 * acts on one tenant's data within that tenant's boundary; the console acts on
 * every tenant's money. A compromised or careless console account can grant
 * itself credit, refund to a card it controls, or suspend a customer.
 *
 * So the model is deliberately restrictive in two directions at once:
 *
 *  1. **Role gates capability.** Support cannot move money; billing cannot
 *     change roles.
 *  2. **Value gates authority.** Above a threshold, no single person acts
 *     alone, whatever their role. An administrator is not a superuser: they
 *     are the person most worth compromising.
 */

export type ConsoleRole =
  /** Read-only. Sees no card details and no full audit payloads. */
  | 'viewer'
  /** Day-to-day customer support. May look, may not move money. */
  | 'support'
  /** Billing operations: invoices, credits, payments, refunds. */
  | 'billing'
  /** Commercial authority: plan overrides, spend caps, write-offs. */
  | 'admin'
  /** Manages console users and roles. Deliberately cannot move money. */
  | 'owner';

export type ConsoleCapability =
  | 'account.read'
  | 'account.list'
  | 'audit.read'
  | 'usage.read'
  | 'invoice.read'
  | 'invoice.issue'
  | 'invoice.void'
  | 'invoice.write_off'
  | 'credit.grant'
  | 'credit.reverse'
  | 'payment.read'
  | 'payment.take'
  | 'payment.refund'
  | 'subscription.read'
  | 'subscription.change'
  | 'plan.override'
  | 'spend_cap.change'
  | 'dunning.hold'
  | 'dunning.suspend'
  | 'tenant.kill_switch'
  | 'user.manage'
  | 'approval.grant';

const VIEWER: readonly ConsoleCapability[] = [
  'account.read', 'account.list', 'usage.read', 'invoice.read',
  'payment.read', 'subscription.read',
];

const SUPPORT: readonly ConsoleCapability[] = [
  ...VIEWER, 'audit.read', 'dunning.hold',
];

const BILLING: readonly ConsoleCapability[] = [
  ...SUPPORT, 'invoice.issue', 'invoice.void', 'credit.grant', 'credit.reverse',
  'payment.take', 'payment.refund', 'subscription.change',
];

const ADMIN: readonly ConsoleCapability[] = [
  ...BILLING, 'invoice.write_off', 'plan.override', 'spend_cap.change',
  'dunning.suspend', 'tenant.kill_switch', 'approval.grant',
];

/**
 * The owner manages people, not money.
 *
 * Separating the two is the point: whoever can add a console user must not also
 * be able to pay themselves, or adding a user becomes a way to launder an
 * action through an account they control. This is the same reason the person
 * who opens a supplier account is not the person who pays it.
 */
const OWNER: readonly ConsoleCapability[] = [
  ...VIEWER, 'audit.read', 'user.manage', 'approval.grant',
];

export const ROLE_CAPABILITIES: Readonly<Record<ConsoleRole, readonly ConsoleCapability[]>> = {
  viewer: VIEWER,
  support: SUPPORT,
  billing: BILLING,
  admin: ADMIN,
  owner: OWNER,
};

export interface ConsoleUser {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly roles: readonly ConsoleRole[];
  readonly active: boolean;
  /** Enforced for every role that can move money. */
  readonly mfaEnrolled: boolean;
  readonly createdAt: string;
  readonly lastSeenAt?: string;
}

export function capabilitiesOf(user: ConsoleUser): ReadonlySet<ConsoleCapability> {
  const capabilities = new Set<ConsoleCapability>();
  if (!user.active) return capabilities;
  for (const role of user.roles) {
    for (const capability of ROLE_CAPABILITIES[role] ?? []) capabilities.add(capability);
  }
  return capabilities;
}

/** Capabilities that move money or change what a customer may spend. */
export const MONEY_CAPABILITIES: readonly ConsoleCapability[] = [
  'credit.grant', 'credit.reverse', 'payment.take', 'payment.refund',
  'invoice.void', 'invoice.write_off', 'plan.override', 'spend_cap.change',
  'subscription.change',
];

export function can(user: ConsoleUser, capability: ConsoleCapability): boolean {
  if (!user.active) return false;
  // A money capability without MFA is refused regardless of role. A password
  // alone is one phishing email away from a refund to an attacker's card.
  if (MONEY_CAPABILITIES.includes(capability) && !user.mfaEnrolled) return false;
  return capabilitiesOf(user).has(capability);
}

export class ForbiddenError extends Error {
  constructor(public readonly capability: ConsoleCapability, reason: string) {
    super(`Not permitted: ${capability}. ${reason}`);
    this.name = 'ForbiddenError';
  }
}

export function require(user: ConsoleUser, capability: ConsoleCapability): void {
  if (!user.active) throw new ForbiddenError(capability, 'The account is disabled.');
  if (MONEY_CAPABILITIES.includes(capability) && !user.mfaEnrolled) {
    throw new ForbiddenError(capability, 'Multi-factor authentication is required to move money.');
  }
  if (!capabilitiesOf(user).has(capability)) {
    throw new ForbiddenError(capability, `Roles ${user.roles.join(', ') || '(none)'} do not include it.`);
  }
}

/**
 * Value above which a second person must approve, per capability.
 *
 * Set where a mistake stops being an inconvenience and starts being a loss
 * worth someone's attention. Anything not listed needs approval whenever it is
 * a money capability at all: a plan override has no amount, but changing what
 * a customer pays every month forever is not a solo decision.
 */
export const APPROVAL_THRESHOLDS: Readonly<Partial<Record<ConsoleCapability, Money>>> = {
  'credit.grant': money(50_000),      // £500
  'payment.refund': money(25_000),    // £250
  'invoice.write_off': money(50_000), // £500
  'spend_cap.change': money(500_000), // £5,000
};

/** Money capabilities that always need a second person, whatever the amount. */
export const ALWAYS_DUAL_CONTROL: readonly ConsoleCapability[] = [
  'plan.override', 'tenant.kill_switch', 'dunning.suspend',
];

export function needsSecondPerson(capability: ConsoleCapability, amount?: Money): boolean {
  if (ALWAYS_DUAL_CONTROL.includes(capability)) return true;
  const threshold = APPROVAL_THRESHOLDS[capability];
  if (!threshold) return false;
  // No amount given for a capability that has a threshold means we cannot show
  // it is below one. Requiring approval is the safe reading.
  if (!amount) return true;
  return amount.amount >= threshold.amount;
}
