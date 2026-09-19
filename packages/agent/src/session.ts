import { newId, type Clock, type Jurisdiction, type TenantConfig, systemClock } from '@detent/awa-core';
import type { ConversationMessage } from './model.js';
import type { QualificationState } from './playbook.js';

/**
 * Conversation state machine (section 23.1).
 *
 * The branch that matters is Engaged: consent affirmative goes to Consented and
 * then Resolving; consent refused or absent goes to NonResolving, which reaches
 * Qualifying without ever touching a CRM. Both paths qualify and both paths can
 * book. Refusing consent costs the visitor nothing.
 */
export type ConversationState =
  | 'Anonymous' | 'Engaged' | 'Consented' | 'NonResolving'
  | 'Resolving' | 'Qualifying' | 'Booked' | 'HandedOff' | 'Ended' | 'PostProcessing';

/**
 * Booking and handoff are reachable from every active state, not only from
 * Qualifying. A visitor who arrives through a "book a demo" surface and books
 * on the first turn is an ordinary path, and so is asking for a human before
 * saying anything else. Modelling those as illegal would mean the machine
 * throws on a legitimate conversation.
 */
const ACTIVE: readonly ConversationState[] = ['Booked', 'HandedOff', 'Ended'];

const TRANSITIONS: Readonly<Record<ConversationState, readonly ConversationState[]>> = {
  Anonymous: ['Engaged', ...ACTIVE],
  Engaged: ['Consented', 'NonResolving', ...ACTIVE],
  Consented: ['Resolving', ...ACTIVE],
  NonResolving: ['Qualifying', ...ACTIVE],
  Resolving: ['Qualifying', ...ACTIVE],
  Qualifying: [...ACTIVE],
  Booked: ['PostProcessing', 'HandedOff'],
  HandedOff: ['PostProcessing'],
  Ended: ['PostProcessing'],
  PostProcessing: [],
};

export function canTransition(from: ConversationState, to: ConversationState): boolean {
  return TRANSITIONS[from].includes(to);
}

export type Modality = 'text' | 'voice';

export interface Session {
  readonly id: string;
  readonly tenantId: string;
  /** Pseudonymous, per-tenant, partitioned. Never follows a person across sites. */
  readonly subjectRef: string;
  readonly correlationId: string;
  readonly jurisdiction: Jurisdiction;
  state: ConversationState;
  modality: Modality;
  readonly history: ConversationMessage[];
  qualification: QualificationState;
  classification?: string;
  ownerRef?: string;
  personExternalId?: string;
  humanRequested: boolean;
  /** v1.2: the conversational mode, set by the mode selector. */
  mode?: string;
  modeForbiddenTools?: readonly string[];
  /** v1.2: the verification level reached in this session (section 55.3). */
  verificationLevel: 0 | 1 | 2 | 3;
  valueDelivered: boolean;
  consecutiveNegativeTurns: number;
  disclosureShown: boolean;
  writeSequence: number;
  readonly versions: { prompt: string; policy: string; model: string; config: number };
  readonly startedAt: string;
}

/**
 * Session lifetime (audit PERF-7).
 *
 * Sessions had no TTL, no eviction and no sweep: every session and its full
 * transcript stayed in process memory until restart. That is an unbounded leak
 * in the component that holds the most visitor-supplied personal data, and a
 * retention breach against the project's own stated policy, a transcript kept
 * "until the process restarts" is not kept for the documented period, it is
 * kept for an arbitrary one.
 */
export interface SessionTtl {
  /** Idle time after which a session is dropped. */
  readonly idleMs: number;
  /** Absolute lifetime from open, however active. */
  readonly absoluteMs: number;
}

export const DEFAULT_SESSION_TTL: SessionTtl = {
  idleMs: 30 * 60 * 1_000,
  absoluteMs: 24 * 60 * 60 * 1_000,
};

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly lastSeen = new Map<string, number>();
  private readonly ttl: SessionTtl;

  constructor(private readonly clock: Clock = systemClock, ttl: SessionTtl = DEFAULT_SESSION_TTL) {
    this.ttl = ttl;
  }

  open(config: TenantConfig, jurisdiction: Jurisdiction, modality: Modality = 'text'): Session {
    const now = this.clock.nowMs();
    const session: Session = {
      id: newId('sess', now),
      tenantId: config.tenantId,
      // A fresh pseudonymous reference per session. Under partitioned cookies
      // there is no cross-site identity to carry, and building one would be
      // both technically unavailable and the wrong privacy outcome.
      subjectRef: newId('pers', now),
      correlationId: newId('corr', now),
      jurisdiction,
      state: 'Anonymous',
      modality,
      history: [],
      qualification: { captured: {}, askedThisSession: [] },
      humanRequested: false,
      verificationLevel: 0,
      valueDelivered: false,
      consecutiveNegativeTurns: 0,
      disclosureShown: false,
      writeSequence: 0,
      versions: {
        prompt: config.promptVersion,
        policy: config.policyVersion,
        model: config.modelVersion,
        config: config.version,
      },
      startedAt: this.clock.iso(),
    };
    this.sessions.set(session.id, session);
    this.lastSeen.set(session.id, now);
    return session;
  }

  /**
   * Look up a session, treating an expired one as absent.
   *
   * Checked on read as well as swept on a timer: a sweep that has not run yet
   * must not be the reason an expired transcript is still readable.
   */
  get(sessionId: string): Session | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    if (this.expired(session, this.clock.nowMs())) {
      this.drop(sessionId);
      return undefined;
    }
    this.lastSeen.set(sessionId, this.clock.nowMs());
    return session;
  }

  private expired(session: Session, nowMs: number): boolean {
    const idleSince = this.lastSeen.get(session.id) ?? Date.parse(session.startedAt);
    if (nowMs - idleSince >= this.ttl.idleMs) return true;
    return nowMs - Date.parse(session.startedAt) >= this.ttl.absoluteMs;
  }

  private drop(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    // The transcript is the personal data. Clearing it before dropping the
    // reference means a retained handle elsewhere does not retain the content.
    if (session) session.history.length = 0;
    this.sessions.delete(sessionId);
    this.lastSeen.delete(sessionId);
  }

  /** Evict expired sessions. Returns how many went, for the metrics gauge. */
  sweep(): number {
    const now = this.clock.nowMs();
    let removed = 0;
    for (const session of [...this.sessions.values()]) {
      if (!this.expired(session, now)) continue;
      this.drop(session.id);
      removed += 1;
    }
    return removed;
  }

  /** Live session count, for the gauge and for capacity planning. */
  get size(): number { return this.sessions.size; }

  /** End a session explicitly, e.g. on a visitor's "forget me". */
  end(sessionId: string): void { this.drop(sessionId); }

  transition(session: Session, to: ConversationState): void {
    if (session.state === to) return;
    if (!canTransition(session.state, to)) {
      throw new Error(`illegal conversation transition ${session.state} -> ${to}`);
    }
    session.state = to;
  }

  /**
   * Record a state that follows a commitment already made to a person, a
   * confirmed booking, a raised handoff. Never throws.
   *
   * The invariant in section 28 is that a commitment is not retracted to
   * preserve system consistency. A bookkeeping mismatch in this state machine
   * is exactly that kind of consistency, and it must not be allowed to turn a
   * confirmed meeting into an error the visitor sees. The mismatch is returned
   * so the caller can report it.
   */
  settle(session: Session, to: ConversationState): { settled: boolean; wasIllegal: boolean } {
    if (session.state === to) return { settled: true, wasIllegal: false };
    const legal = canTransition(session.state, to);
    session.state = to;
    return { settled: true, wasIllegal: !legal };
  }

  /** Next write sequence for this session, used to build the idempotency key. */
  nextWriteSequence(session: Session): number {
    session.writeSequence += 1;
    return session.writeSequence;
  }

  record(session: Session, role: 'visitor' | 'assistant', text: string): void {
    session.history.push({ role, text, at: this.clock.iso() });
    this.lastSeen.set(session.id, this.clock.nowMs());
  }
}
