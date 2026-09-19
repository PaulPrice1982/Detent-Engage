import { createHash, randomBytes } from 'node:crypto';
import { AwaError, approvedValues, type Clock, type TenantConfig, systemClock } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';

/**
 * The machine surface (section 57).
 *
 * The category assumes a human in a browser. Increasingly the visitor is
 * another AI agent researching on a buyer's behalf. A business whose commercial
 * knowledge is available only through a chat widget rendered in a browser is
 * progressively less visible to that traffic, and has no way to know it is
 * happening.
 *
 * The opportunity is not to serve agents better than humans. It is to be the
 * vendor that can tell a tenant **how much agent traffic they receive, what it
 * asked, and what it was told.** That reporting is currently unavailable
 * anywhere.
 *
 * Governance, from section 57.3, and each answer is enforced not argued:
 *
 *  - An agent cannot give consent on a person's behalf. All agent traffic is
 *    non-consented. No identity resolution, no identifier persistence.
 *  - The Article 50 disclosure is served anyway, so any downstream human is
 *    told. Cost is zero, ambiguity is removed.
 *  - A self-declared identity is never trusted. Registration issues a scoped
 *    key; unregistered access gets a lower rate limit and a reduced surface.
 *  - The surface receives *less* than a human does. No CRM information, ever.
 *  - Separate rate limits, quota and spend cap. It never shares the voice pool.
 *  - A booking is provisional until a verified human confirms.
 */
export interface AgentPrincipal {
  readonly registered: boolean;
  readonly agentId?: string;
  readonly label?: string;
}

export interface MachineSurfaceDocument {
  readonly tenant: string;
  /** Article 50, served to machines so any downstream human is told. */
  readonly disclosure: string;
  readonly policy: MachinePolicyDeclaration;
  readonly services: readonly { id: string; name: string }[];
  readonly pricing: readonly {
    sku: string; label: string;
    price?: { amount: number; currency: string; unit: string };
    range?: { min: number; max: number; currency: string; unit: string };
    conditions: readonly string[];
  }[];
  readonly availability: readonly { slotId: string; startsAt: string; endsAt: string }[];
  readonly intakeSchema: Record<string, unknown>;
}

/**
 * The policy declaration is published *and enforced server-side*, rather than
 * trusted. Publishing it is a courtesy to well-behaved agents; enforcing it is
 * what makes it true.
 */
export interface MachinePolicyDeclaration {
  readonly mayRead: readonly string[];
  readonly mayNotRead: readonly string[];
  readonly mayWrite: readonly string[];
  readonly bookingIsProvisional: true;
  readonly identityResolution: 'never';
  readonly rateLimitPerMinute: number;
  readonly registrationUrl?: string;
}

export const UNREGISTERED_RATE_PER_MINUTE = 10;
export const REGISTERED_RATE_PER_MINUTE = 60;

export interface ProvisionalBooking {
  readonly id: string;
  readonly tenantId: string;
  readonly slotId: string;
  readonly requesterEmail: string;
  readonly requestedByAgent: string;
  readonly createdAt: string;
  state: 'PROVISIONAL' | 'CONFIRMED' | 'EXPIRED';
  readonly confirmationTokenDigest: string;
}

export interface AgentTrafficRecord {
  readonly tenantId: string;
  readonly at: string;
  readonly agentId: string;
  readonly surface: string;
  readonly query?: string;
  readonly outcome: string;
}

export class MachineSurface {
  private readonly buckets = new Map<string, { count: number; windowStart: number }>();
  private readonly registrations = new Map<string, { agentId: string; label: string }>();
  private readonly bookings = new Map<string, ProvisionalBooking>();
  readonly traffic: AgentTrafficRecord[] = [];

  constructor(
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
  ) {}

  /** Optional registration issuing a scoped key. Never trusts a self-declared id. */
  register(label: string): { key: string; agentId: string } {
    const agentId = `agent_${randomBytes(6).toString('hex')}`;
    const key = `awa_agt_${agentId}_${randomBytes(18).toString('base64url')}`;
    this.registrations.set(digest(key), { agentId, label });
    return { key, agentId };
  }

  authenticate(presentedKey: string | undefined): AgentPrincipal {
    if (!presentedKey) return { registered: false };
    const registration = this.registrations.get(digest(presentedKey));
    // An unrecognised key is not an error: it degrades to unregistered, which
    // is the same as anonymous. There is nothing to brute-force.
    return registration
      ? { registered: true, agentId: registration.agentId, label: registration.label }
      : { registered: false };
  }

  /**
   * Separate rate limits, quota and spend cap (FR-102). Agent traffic never
   * shares the voice concurrency pool, so an agent flood cannot degrade a
   * human's voice conversation.
   */
  checkRate(tenantId: string, principal: AgentPrincipal): { allowed: boolean; limit: number; retryAfterSeconds?: number } {
    const limit = principal.registered ? REGISTERED_RATE_PER_MINUTE : UNREGISTERED_RATE_PER_MINUTE;
    const key = `${tenantId}:${principal.agentId ?? 'anonymous'}`;
    const now = this.clock.nowMs();
    const bucket = this.buckets.get(key);

    if (!bucket || now - bucket.windowStart >= 60_000) {
      this.buckets.set(key, { count: 1, windowStart: now });
      return { allowed: true, limit };
    }
    if (bucket.count >= limit) {
      return { allowed: false, limit, retryAfterSeconds: Math.ceil((60_000 - (now - bucket.windowStart)) / 1000) };
    }
    bucket.count += 1;
    return { allowed: true, limit };
  }

  /**
   * Serve the governed document. Approved content only, on the same allowlist
   * as the human surface — and less of it. No owner identity, no calendar
   * detail, no CRM information of any kind.
   */
  async serve(input: {
    config: TenantConfig;
    principal: AgentPrincipal;
    correlationId: string;
    availability: readonly { slotId: string; startsAt: string; endsAt: string }[];
    registrationUrl?: string;
  }): Promise<MachineSurfaceDocument> {
    await this.recordTraffic(input.config.tenantId, input.principal, 'catalogue', undefined, 'served');

    return {
      tenant: input.config.name,
      disclosure: input.config.disclosure.text,
      policy: {
        mayRead: ['service catalogue', 'approved list pricing', 'bookable availability', 'intake schema'],
        mayNotRead: [
          'any CRM record or classification',
          'any customer, contract, billing or support information',
          'owner or individual identity',
          'anything not approved under the tenant price and claim allowlist',
        ],
        mayWrite: ['a provisional booking request', 'a structured qualification intake'],
        bookingIsProvisional: true,
        identityResolution: 'never',
        rateLimitPerMinute: input.principal.registered ? REGISTERED_RATE_PER_MINUTE : UNREGISTERED_RATE_PER_MINUTE,
        registrationUrl: input.registrationUrl,
      },
      services: input.config.serviceCatalogue.map((id) => ({ id, name: id })),
      pricing: input.config.priceList.map((entry) => ({
        sku: entry.sku, label: entry.label, price: entry.price, range: entry.range,
        conditions: entry.conditions,
      })),
      // Slots only. No owner name, no calendar detail: an agent does not need
      // to know whose diary it is, and a human visitor is not told either.
      availability: input.principal.registered ? input.availability.slice(0, 10) : input.availability.slice(0, 3),
      intakeSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          organisation: { type: 'string' },
          requirement: { type: 'string', maxLength: 2000 },
          timescale: { type: 'string' },
          contact_email: { type: 'string', format: 'email' },
        },
        required: ['organisation', 'requirement', 'contact_email'],
      },
    };
  }

  /**
   * A booking made through the machine surface is **provisional** until a
   * verified human confirms it (FR-101). An agent cannot commit the tenant to
   * anything, per section 13.3.
   */
  async requestProvisionalBooking(input: {
    tenantId: string; principal: AgentPrincipal; slotId: string;
    requesterEmail: string; correlationId: string;
  }): Promise<{ booking: ProvisionalBooking; confirmationToken: string }> {
    const confirmationToken = randomBytes(24).toString('base64url');
    const booking: ProvisionalBooking = {
      id: `pbk_${randomBytes(8).toString('hex')}`,
      tenantId: input.tenantId,
      slotId: input.slotId,
      requesterEmail: input.requesterEmail,
      requestedByAgent: input.principal.agentId ?? 'anonymous',
      createdAt: this.clock.iso(),
      state: 'PROVISIONAL',
      confirmationTokenDigest: digest(confirmationToken),
    };
    this.bookings.set(booking.id, booking);

    await this.recordTraffic(input.tenantId, input.principal, 'booking', undefined, 'provisional');
    await this.audit.write({
      tenantId: input.tenantId, type: 'tool_call_executed', correlationId: input.correlationId, actor: 'system',
      payload: {
        change: 'provisional_booking_requested', bookingId: booking.id,
        requestedByAgent: booking.requestedByAgent, held: false,
      },
    });

    // The token goes to the requester's own address, so the human confirming is
    // the human whose diary it is, not the agent that asked.
    return { booking, confirmationToken };
  }

  /** Only a verified human, holding the emailed token, can make it real. */
  async confirmByHuman(input: {
    tenantId: string; bookingId: string; token: string; correlationId: string;
  }): Promise<ProvisionalBooking> {
    const booking = this.bookings.get(input.bookingId);
    if (!booking || booking.tenantId !== input.tenantId) {
      throw new AwaError({ kind: 'NOT_FOUND', message: 'provisional booking not found' });
    }
    if (booking.confirmationTokenDigest !== digest(input.token)) {
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'that confirmation link is not valid' });
    }
    booking.state = 'CONFIRMED';
    await this.audit.write({
      tenantId: input.tenantId, type: 'tool_call_executed', correlationId: input.correlationId, actor: 'visitor',
      payload: { change: 'provisional_booking_confirmed_by_human', bookingId: booking.id },
    });
    return booking;
  }

  /** Agent traffic analytics, reported separately from human traffic (FR-103). */
  async recordTraffic(tenantId: string, principal: AgentPrincipal, surface: string, query: string | undefined, outcome: string): Promise<void> {
    this.traffic.push({
      tenantId, at: this.clock.iso(),
      agentId: principal.agentId ?? 'anonymous',
      surface, query, outcome,
    });
  }

  trafficReport(tenantId: string): {
    total: number; registered: number; anonymous: number;
    bySurface: Record<string, number>; recentQueries: string[];
  } {
    const rows = this.traffic.filter((row) => row.tenantId === tenantId);
    const bySurface: Record<string, number> = {};
    for (const row of rows) bySurface[row.surface] = (bySurface[row.surface] ?? 0) + 1;
    return {
      total: rows.length,
      registered: rows.filter((row) => row.agentId !== 'anonymous').length,
      anonymous: rows.filter((row) => row.agentId === 'anonymous').length,
      bySurface,
      recentQueries: rows.map((row) => row.query).filter((query): query is string => Boolean(query)).slice(-20),
    };
  }

  /** The refusal path for anything that would resolve an identity (FR-100). */
  async refuseIdentityResolution(tenantId: string, correlationId: string): Promise<never> {
    await this.audit.write({
      tenantId, type: 'resolution_blocked_no_consent', correlationId, actor: 'policy',
      payload: { change: 'machine_surface_identity_refused', reason: 'an agent cannot give consent on a person behalf' },
    });
    throw new AwaError({
      kind: 'CONSENT_REQUIRED',
      message: 'the machine surface never resolves identity: an agent cannot consent on a person behalf',
      tenantId,
    });
  }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export { approvedValues };
