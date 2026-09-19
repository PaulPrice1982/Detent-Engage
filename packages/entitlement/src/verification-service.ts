import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { AwaError, type Clock, type VerificationLevel, systemClock } from '@detent/awa-core';
import type { AuditLog } from '@detent/awa-audit';

/**
 * The identity verification service (section 55.3).
 *
 * Level 2 is the practical working level: a one-time code sent to the address
 * **on the contract**, not to whatever address the visitor typed. That
 * distinction is the entire control, a visitor who types a customer's email
 * proves nothing, and a code sent to the typed address would prove nothing
 * either.
 */
export interface VerificationChallenge {
  readonly id: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly emailDigest: string;
  readonly codeDigest: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  attempts: number;
  consumed: boolean;
}

export interface CodeSender {
  send(email: string, code: string): Promise<void>;
}

export interface VerificationState {
  readonly level: VerificationLevel;
  readonly verifiedEmail?: string;
  readonly at?: string;
}

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export class VerificationService {
  private readonly challenges = new Map<string, VerificationChallenge>();
  private readonly levels = new Map<string, VerificationState>();

  constructor(
    private readonly sender: CodeSender,
    private readonly audit: AuditLog,
    private readonly clock: Clock = systemClock,
  ) {}

  private key(tenantId: string, sessionId: string): string { return `${tenantId}:${sessionId}`; }
  private digest(value: string): string { return createHash('sha256').update(value.trim().toLowerCase()).digest('hex'); }

  /** Level 1: an email was stated. Bands only, never disclosed. */
  async recordStatedEmail(tenantId: string, sessionId: string): Promise<VerificationState> {
    const state: VerificationState = { level: 1, at: this.clock.iso() };
    this.levels.set(this.key(tenantId, sessionId), state);
    return state;
  }

  /**
   * Issue a one-time code. `contractEmail` is the address on the executed
   * agreement, supplied by the entitlement layer, never the address the
   * visitor typed. If the two differ, the code goes to the contract address and
   * an impostor learns nothing.
   */
  async issueCode(input: {
    tenantId: string; sessionId: string; contractEmail: string; correlationId: string;
  }): Promise<{ challengeId: string; sentTo: string }> {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const challenge: VerificationChallenge = {
      id: `vc_${this.digest(`${input.sessionId}:${this.clock.nowMs()}`).slice(0, 16)}`,
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      emailDigest: this.digest(input.contractEmail),
      codeDigest: this.digest(code),
      issuedAt: this.clock.iso(),
      expiresAt: new Date(this.clock.nowMs() + CODE_TTL_MS).toISOString(),
      attempts: 0,
      consumed: false,
    };
    this.challenges.set(challenge.id, challenge);
    await this.sender.send(input.contractEmail, code);

    await this.audit.write({
      tenantId: input.tenantId,
      type: 'consent_recorded',
      correlationId: input.correlationId,
      sessionId: input.sessionId,
      actor: 'system',
      // The code is never logged. The digest of the destination is enough to
      // prove which address it went to without recording the address.
      payload: { change: 'verification_code_issued', challengeId: challenge.id, destinationDigest: challenge.emailDigest.slice(0, 12) },
    });

    return { challengeId: challenge.id, sentTo: maskEmail(input.contractEmail) };
  }

  /** Level 2: the code came back. Category-level entitlement becomes available. */
  async verifyCode(input: {
    tenantId: string; sessionId: string; challengeId: string; code: string; correlationId: string;
  }): Promise<VerificationState> {
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge || challenge.tenantId !== input.tenantId || challenge.sessionId !== input.sessionId) {
      throw new AwaError({ kind: 'NOT_FOUND', message: 'verification challenge not found' });
    }
    if (challenge.consumed) {
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'this code has already been used' });
    }
    if (this.clock.iso() > challenge.expiresAt) {
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'this code has expired' });
    }
    challenge.attempts += 1;
    if (challenge.attempts > MAX_ATTEMPTS) {
      challenge.consumed = true;
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'too many attempts; request a new code' });
    }

    const presented = Buffer.from(this.digest(input.code), 'hex');
    const expected = Buffer.from(challenge.codeDigest, 'hex');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      await this.audit.write({
        tenantId: input.tenantId, type: 'policy_denied', correlationId: input.correlationId,
        sessionId: input.sessionId, actor: 'policy',
        payload: { change: 'verification_failed', attempts: challenge.attempts },
      });
      throw new AwaError({ kind: 'POLICY_DENIED', message: 'that code is not correct' });
    }

    challenge.consumed = true;
    const state: VerificationState = { level: 2, at: this.clock.iso() };
    this.levels.set(this.key(input.tenantId, input.sessionId), state);

    await this.audit.write({
      tenantId: input.tenantId, type: 'consent_recorded', correlationId: input.correlationId,
      sessionId: input.sessionId, actor: 'visitor',
      payload: { change: 'verification_level_reached', level: 2 },
    });
    return state;
  }

  /**
   * Level 3: an authenticated portal handoff. Only the tenant can assert this,
   * because only the tenant authenticated the person. The platform will not
   * mint level 3 from anything a visitor says or does in the widget.
   */
  async acceptAuthenticatedHandoff(input: {
    tenantId: string; sessionId: string; subjectEmail: string; correlationId: string;
    /** Proof from the tenant's identity provider, verified before this is called. */
    assertionVerified: boolean;
  }): Promise<VerificationState> {
    if (!input.assertionVerified) {
      throw new AwaError({
        kind: 'POLICY_DENIED',
        message: 'an unverified assertion cannot establish level 3',
        tenantId: input.tenantId,
      });
    }
    const state: VerificationState = { level: 3, verifiedEmail: input.subjectEmail, at: this.clock.iso() };
    this.levels.set(this.key(input.tenantId, input.sessionId), state);
    await this.audit.write({
      tenantId: input.tenantId, type: 'consent_recorded', correlationId: input.correlationId,
      sessionId: input.sessionId, actor: 'system',
      payload: { change: 'verification_level_reached', level: 3, via: 'authenticated_portal_handoff' },
    });
    return state;
  }

  level(tenantId: string, sessionId: string): VerificationLevel {
    return this.levels.get(this.key(tenantId, sessionId))?.level ?? 0;
  }

  state(tenantId: string, sessionId: string): VerificationState {
    return this.levels.get(this.key(tenantId, sessionId)) ?? { level: 0 };
  }
}

/** a***@acme.co.uk, enough to recognise, not enough to learn. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '***';
  return `${local[0]}${'*'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}
