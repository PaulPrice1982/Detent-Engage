import { AwaError, newId, type Clock, systemClock } from '@detent/awa-core';

/**
 * Calendar and notification ports (section 18).
 *
 * The booking invariant, from section 28: never retract a commitment already
 * made to a person in order to preserve system consistency. A slot is held,
 * confirmed against the provider, and the provider is authoritative. The
 * assistant never confirms a slot it has not held.
 */
export interface Slot {
  readonly id: string;
  readonly ownerRef: string;
  readonly startsAt: string;
  readonly endsAt: string;
}

export type BookingState = 'Requested' | 'SlotHeld' | 'Confirmed' | 'Expired' | 'CRMLogged' | 'ReconciliationPending' | 'Escalated';

export interface Booking {
  readonly id: string;
  readonly tenantId: string;
  readonly slot: Slot;
  readonly visitorEmail: string;
  state: BookingState;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface CalendarService {
  availability(tenantId: string, ownerRef: string | undefined, from: string, to: string): Promise<Slot[]>;
  /** Hold a slot. Two concurrent holds on the same slot: exactly one succeeds. */
  hold(tenantId: string, slotId: string, ttlMs?: number): Promise<Slot>;
  confirm(tenantId: string, slotId: string, visitorEmail: string, idempotencyKey: string): Promise<Booking>;
  release(tenantId: string, slotId: string): Promise<void>;
}

interface HeldSlot { readonly slot: Slot; expiresAt: number; }

export class InMemoryCalendarService implements CalendarService {
  private readonly slots = new Map<string, Slot[]>();
  private readonly holds = new Map<string, HeldSlot>();
  private readonly bookings = new Map<string, Booking>();
  private readonly byIdempotencyKey = new Map<string, Booking>();

  constructor(private readonly clock: Clock = systemClock) {}

  seed(tenantId: string, slots: Slot[]): void {
    this.slots.set(tenantId, slots);
  }

  private key(tenantId: string, slotId: string): string { return `${tenantId}:${slotId}`; }

  async availability(tenantId: string, ownerRef: string | undefined, from: string, to: string): Promise<Slot[]> {
    const now = this.clock.nowMs();
    return (this.slots.get(tenantId) ?? []).filter((slot) => {
      if (ownerRef && slot.ownerRef !== ownerRef) return false;
      if (slot.startsAt < from || slot.startsAt > to) return false;
      const held = this.holds.get(this.key(tenantId, slot.id));
      if (held && held.expiresAt > now) return false;
      return !this.bookings.has(this.key(tenantId, slot.id));
    });
  }

  async hold(tenantId: string, slotId: string, ttlMs = 120_000): Promise<Slot> {
    const key = this.key(tenantId, slotId);
    const now = this.clock.nowMs();
    const existing = this.holds.get(key);
    if (existing && existing.expiresAt > now) {
      throw new AwaError({ kind: 'CONFLICT', message: `slot ${slotId} is already held`, tenantId });
    }
    if (this.bookings.has(key)) {
      throw new AwaError({ kind: 'CONFLICT', message: `slot ${slotId} is already booked`, tenantId });
    }
    const slot = (this.slots.get(tenantId) ?? []).find((s) => s.id === slotId);
    if (!slot) throw new AwaError({ kind: 'NOT_FOUND', message: `slot ${slotId} does not exist`, tenantId });
    this.holds.set(key, { slot, expiresAt: now + ttlMs });
    return slot;
  }

  async confirm(tenantId: string, slotId: string, visitorEmail: string, idempotencyKey: string): Promise<Booking> {
    // Idempotent on the session-derived key, so a retried confirmation returns
    // the original booking rather than double-booking the owner.
    const previous = this.byIdempotencyKey.get(`${tenantId}:${idempotencyKey}`);
    if (previous) return previous;

    const key = this.key(tenantId, slotId);
    const held = this.holds.get(key);
    if (!held || held.expiresAt <= this.clock.nowMs()) {
      throw new AwaError({
        kind: 'CONFLICT',
        message: `slot ${slotId} was not held, or the hold has lapsed`,
        tenantId,
        visitorMessage: 'That time has just gone. Let me offer you the next few that are free.',
      });
    }
    if (this.bookings.has(key)) {
      throw new AwaError({ kind: 'CONFLICT', message: `slot ${slotId} is already booked`, tenantId });
    }

    const booking: Booking = {
      id: newId('bk', this.clock.nowMs()),
      tenantId,
      slot: held.slot,
      visitorEmail,
      state: 'Confirmed',
      idempotencyKey,
      createdAt: this.clock.iso(),
    };
    this.bookings.set(key, booking);
    this.byIdempotencyKey.set(`${tenantId}:${idempotencyKey}`, booking);
    this.holds.delete(key);
    return booking;
  }

  async release(tenantId: string, slotId: string): Promise<void> {
    this.holds.delete(this.key(tenantId, slotId));
  }

  bookingsFor(tenantId: string): Booking[] {
    return [...this.bookings.values()].filter((booking) => booking.tenantId === tenantId);
  }
}

/**
 * "Push to email" is four distinct actions and they are never conflated
 * (section 18.2, table 28). Three are permitted by default. The fourth,
 * marketing enrolment, is structurally incapable of executing without a stored
 * consent event id, enforced in the policy engine, not here.
 */
export type NotificationKind = 'internal_owner_notification' | 'transactional' | 'marketing_enrolment';

export interface Notification {
  readonly kind: NotificationKind;
  readonly tenantId: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly correlationId: string;
  readonly consentEventId?: string;
  readonly sentAt: string;
}

export interface NotificationService {
  notifyOwner(input: Omit<Notification, 'kind' | 'sentAt'>): Promise<void>;
  sendTransactional(input: Omit<Notification, 'kind' | 'sentAt'>): Promise<void>;
  enrolInSequence(input: Omit<Notification, 'kind' | 'sentAt'> & { consentEventId: string }): Promise<void>;
}

export class InMemoryNotificationService implements NotificationService {
  readonly sent: Notification[] = [];

  constructor(private readonly clock: Clock = systemClock) {}

  async notifyOwner(input: Omit<Notification, 'kind' | 'sentAt'>): Promise<void> {
    this.sent.push({ ...input, kind: 'internal_owner_notification', sentAt: this.clock.iso() });
  }

  async sendTransactional(input: Omit<Notification, 'kind' | 'sentAt'>): Promise<void> {
    // Strictly transactional. Bundling promotional content into a meeting
    // confirmation is how a lawful message becomes an unlawful one.
    this.sent.push({ ...input, kind: 'transactional', sentAt: this.clock.iso() });
  }

  async enrolInSequence(input: Omit<Notification, 'kind' | 'sentAt'> & { consentEventId: string }): Promise<void> {
    if (!input.consentEventId) {
      throw new AwaError({ kind: 'CONSENT_REQUIRED', message: 'marketing enrolment requires a stored consent event id' });
    }
    this.sent.push({ ...input, kind: 'marketing_enrolment', sentAt: this.clock.iso() });
  }
}

/** Handoff console (section 27). Context travels; the visitor never repeats themselves. */
export interface HandoffContext {
  readonly handoffId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly reason: string;
  readonly transcript: readonly { role: string; text: string }[];
  readonly qualification: Readonly<Record<string, unknown>>;
  readonly classification?: string;
  readonly ownerRef?: string;
  readonly createdAt: string;
}

export class HandoffService {
  readonly queue: HandoffContext[] = [];

  constructor(private readonly clock: Clock = systemClock) {}

  async raise(input: Omit<HandoffContext, 'handoffId' | 'createdAt'>): Promise<HandoffContext> {
    const handoff: HandoffContext = { ...input, handoffId: newId('ho', this.clock.nowMs()), createdAt: this.clock.iso() };
    this.queue.push(handoff);
    return handoff;
  }

  forTenant(tenantId: string): HandoffContext[] {
    return this.queue.filter((handoff) => handoff.tenantId === tenantId);
  }
}
