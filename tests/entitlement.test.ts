import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { FixedClock, VERIFICATION_LADDER, checkLadder, permits } from '@detent/awa-core';
import {
  EntitlementService, VerificationService, detectExcessUse, isInterpretationRequest, maskEmail,
  type CodeSender,
} from '@detent/awa-entitlement';
import type { ClmFacts } from '@detent/awa-context';

/**
 * CI gates for v1.2 section 55 / FR-088 to FR-093.
 *
 * Section 62.1 invariants: **zero clause disclosures below verification level
 * 3**, and **zero arrears or excess use disclosed to a visitor.**
 */
const CONTRACT: ClmFacts = {
  hasExecutedAgreement: true,
  agreementRef: 'agr_1',
  counterpartyEmailDomain: 'acme.co.uk',
  inScope: [{ category: 'contract-review', label: 'Contract review', clauseRef: '4.2', limit: 25, unit: 'contracts' }],
  outOfScope: ['implementation'],
  expiresAt: '2026-12-01T00:00:00.000Z',
  autoRenew: true,
  noticeByDate: '2026-10-01T00:00:00.000Z',
  excessUseTerms: { metric: 'contracts', limit: 25, rate: 120 },
  clauses: { '4.2': 'The Supplier shall review up to twenty-five (25) Contracts per Engagement.' },
};

function service() {
  const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
  const audit = new AuditLog(new InMemoryAuditStore(), clock);
  return { service: new EntitlementService(audit), audit, clock };
}

describe('the verification ladder', () => {
  it('grants nothing at level 0', () => {
    expect(permits(0, 'relationship_band')).toBe(false);
    expect(VERIFICATION_LADDER[0].label).toBe('Anonymous');
  });

  it('grants bands at level 1, but never entitlement', () => {
    expect(permits(1, 'standing_band')).toBe(true);
    expect(permits(1, 'entitlement_category')).toBe(false);
  });

  it('grants category-level entitlement at level 2, never clause text', () => {
    expect(permits(2, 'entitlement_category')).toBe(true);
    expect(permits(2, 'clause_text')).toBe(false);
  });

  it('grants clause text only at level 3', () => {
    expect(permits(3, 'clause_text')).toBe(true);
    expect(checkLadder(2, 'clause_text')).toMatchObject({ permitted: false, required: 3, escalate: true });
  });
});

describe('the verification service', () => {
  class RecordingSender implements CodeSender {
    readonly sent: { email: string; code: string }[] = [];
    async send(email: string, code: string): Promise<void> { this.sent.push({ email, code }); }
  }

  function build() {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const sender = new RecordingSender();
    const audit = new AuditLog(new InMemoryAuditStore(), clock);
    return { verification: new VerificationService(sender, audit, clock), sender, audit, clock };
  }

  it('sends the code to the address on the contract, not the address typed', async () => {
    const { verification, sender } = build();
    await verification.issueCode({
      tenantId: 't1', sessionId: 's1',
      // The entitlement layer supplies this from the executed agreement.
      contractEmail: 'alex@acme.co.uk',
      correlationId: 'c1',
    });
    expect(sender.sent[0]!.email).toBe('alex@acme.co.uk');
  });

  it('masks the destination when telling the visitor where it went', () => {
    expect(maskEmail('alex@acme.co.uk')).toBe('a***@acme.co.uk');
  });

  it('reaches level 2 on a correct code', async () => {
    const { verification, sender } = build();
    const { challengeId } = await verification.issueCode({ tenantId: 't1', sessionId: 's1', contractEmail: 'a@acme.co.uk', correlationId: 'c1' });
    const state = await verification.verifyCode({
      tenantId: 't1', sessionId: 's1', challengeId, code: sender.sent[0]!.code, correlationId: 'c1',
    });
    expect(state.level).toBe(2);
    expect(verification.level('t1', 's1')).toBe(2);
  });

  it('refuses a wrong code and does not raise the level', async () => {
    const { verification } = build();
    const { challengeId } = await verification.issueCode({ tenantId: 't1', sessionId: 's1', contractEmail: 'a@acme.co.uk', correlationId: 'c1' });
    await expect(verification.verifyCode({ tenantId: 't1', sessionId: 's1', challengeId, code: '000000', correlationId: 'c1' }))
      .rejects.toMatchObject({ kind: 'POLICY_DENIED' });
    expect(verification.level('t1', 's1')).toBe(0);
  });

  it('refuses to reuse a consumed code', async () => {
    const { verification, sender } = build();
    const { challengeId } = await verification.issueCode({ tenantId: 't1', sessionId: 's1', contractEmail: 'a@acme.co.uk', correlationId: 'c1' });
    const code = sender.sent[0]!.code;
    await verification.verifyCode({ tenantId: 't1', sessionId: 's1', challengeId, code, correlationId: 'c1' });
    await expect(verification.verifyCode({ tenantId: 't1', sessionId: 's1', challengeId, code, correlationId: 'c1' }))
      .rejects.toThrowError(/already been used/);
  });

  it('expires a code after its window', async () => {
    const { verification, sender, clock } = build();
    const { challengeId } = await verification.issueCode({ tenantId: 't1', sessionId: 's1', contractEmail: 'a@acme.co.uk', correlationId: 'c1' });
    clock.advance(11 * 60 * 1000);
    await expect(verification.verifyCode({ tenantId: 't1', sessionId: 's1', challengeId, code: sender.sent[0]!.code, correlationId: 'c1' }))
      .rejects.toThrowError(/expired/);
  });

  it('never mints level 3 from an unverified assertion', async () => {
    const { verification } = build();
    await expect(verification.acceptAuthenticatedHandoff({
      tenantId: 't1', sessionId: 's1', subjectEmail: 'a@acme.co.uk',
      correlationId: 'c1', assertionVerified: false,
    })).rejects.toMatchObject({ kind: 'POLICY_DENIED' });
    expect(verification.level('t1', 's1')).toBe(0);
  });

  it('never logs the code itself', async () => {
    const { verification, audit } = build();
    await verification.issueCode({ tenantId: 't1', sessionId: 's1', contractEmail: 'a@acme.co.uk', correlationId: 'c1' });
    const exported = await audit.export('t1');
    expect(JSON.stringify(exported.entries)).not.toContain('a@acme.co.uk');
  });
});

describe('the assistant reads and cites, it never interprets (FR-091)', () => {
  const interpretations = [
    'Does this clause mean we can terminate early?',
    'Am I entitled to a refund under the agreement?',
    'Can we withhold payment while the dispute is open?',
    'What happens if we breach the notice period?',
    'Is that clause enforceable?',
    'How would a court read section 4?',
  ];

  it.each(interpretations)('refuses: %s', (question) => {
    expect(isInterpretationRequest(question)).toBe(true);
  });

  it('does not refuse an ordinary factual question about scope', () => {
    expect(isInterpretationRequest('Is contract review included in what we have?')).toBe(false);
    expect(isInterpretationRequest('How many contracts does our engagement cover?')).toBe(false);
  });

  it('refuses interpretation before reading the contract at all', async () => {
    const { service: entitlement, audit } = service();
    const answer = await entitlement.answer({
      tenantId: 't1', sessionId: 's1', correlationId: 'c1',
      question: 'Does this clause mean we can terminate early?',
      verificationLevel: 3, contract: CONTRACT, verifiedEmail: 'alex@acme.co.uk',
    });
    expect(answer.kind).toBe('REFUSED_INTERPRETATION');
    expect(answer.escalate).toBe(true);
    // No clause text leaked in the refusal.
    expect(answer.say).not.toContain('twenty-five');
    const exported = await audit.export('t1');
    expect(JSON.stringify(exported.entries)).not.toContain('twenty-five');
  });
});

describe('clause disclosure requires level 3 and the verified party (FR-089)', () => {
  it('withholds entitlement entirely below level 2', async () => {
    const { service: entitlement } = service();
    const answer = await entitlement.answer({
      tenantId: 't1', sessionId: 's1', correlationId: 'c1',
      question: 'Is contract review included?', category: 'contract-review',
      verificationLevel: 1, contract: CONTRACT,
    });
    expect(answer.kind).toBe('INSUFFICIENT_VERIFICATION');
    expect(answer.requiredLevel).toBe(2);
    expect(answer.say).not.toContain('twenty-five');
  });

  it('confirms in scope at level 2, without the clause text', async () => {
    const { service: entitlement } = service();
    const answer = await entitlement.answer({
      tenantId: 't1', sessionId: 's1', correlationId: 'c1',
      question: 'Is contract review included?', category: 'contract-review',
      verificationLevel: 2, contract: CONTRACT,
    });
    expect(answer.kind).toBe('IN_SCOPE');
    expect(answer.clauseText).toBeUndefined();
    expect(answer.say).not.toContain('twenty-five');
  });

  it('cites the clause at level 3 for the verified counterparty', async () => {
    const { service: entitlement } = service();
    const answer = await entitlement.answer({
      tenantId: 't1', sessionId: 's1', correlationId: 'c1',
      question: 'What does our agreement cover for contract review?', category: 'contract-review',
      verificationLevel: 3, contract: CONTRACT, verifiedEmail: 'alex@acme.co.uk',
    });
    expect(answer.kind).toBe('CLAUSE_CITED');
    expect(answer.clauseRef).toBe('4.2');
    expect(answer.say).toContain('twenty-five');
  });

  it('withholds the clause at level 3 when the verified party is not the counterparty', async () => {
    const { service: entitlement } = service();
    const answer = await entitlement.answer({
      tenantId: 't1', sessionId: 's1', correlationId: 'c1',
      question: 'What does our agreement cover?', category: 'contract-review',
      // Verified, but verified as someone else. Level 3 permits clause text
      // from *their own* agreement.
      verificationLevel: 3, contract: CONTRACT, verifiedEmail: 'attacker@northwind.com',
    });
    expect(answer.kind).toBe('IN_SCOPE');
    expect(answer.clauseText).toBeUndefined();
  });

  it('never answers from anything but an executed agreement', async () => {
    const { service: entitlement } = service();
    const answer = await entitlement.answer({
      tenantId: 't1', sessionId: 's1', correlationId: 'c1',
      question: 'Is contract review included?', category: 'contract-review',
      verificationLevel: 3, contract: { hasExecutedAgreement: false, inScope: [], outOfScope: [] },
    });
    expect(answer.kind).toBe('NO_AGREEMENT');
    expect(answer.escalate).toBe(true);
  });

  it('states out of scope without deriving a price (FR-090, section 13.4 stands)', async () => {
    const { service: entitlement } = service();
    const answer = await entitlement.answer({
      tenantId: 't1', sessionId: 's1', correlationId: 'c1',
      question: 'Can you do implementation for us?', category: 'implementation',
      verificationLevel: 2, contract: CONTRACT,
    });
    expect(answer.kind).toBe('OUT_OF_SCOPE');
    expect(answer.say).not.toMatch(/[£$€]\s?\d/);
  });
});

describe('excess use and renewal never reach the visitor (FR-090, FR-092)', () => {
  it('detects excess use deterministically from contract terms and usage', () => {
    expect(detectExcessUse(CONTRACT, { metric: 'contracts', consumed: 40 })).toMatchObject({
      metric: 'contracts', limit: 25, consumed: 40, clauseRef: '4.2',
    });
    expect(detectExcessUse(CONTRACT, { metric: 'contracts', consumed: 20 })).toBeUndefined();
    expect(detectExcessUse(CONTRACT, { metric: 'seats', consumed: 400 })).toBeUndefined();
  });

  it('produces an internal task and records that the visitor was not told', async () => {
    const { service: entitlement, audit } = service();
    const task = await entitlement.recordExcessUse({
      tenantId: 't1', correlationId: 'c1', ownerRef: 'owner_1',
      finding: { metric: 'contracts', limit: 25, consumed: 40, clauseRef: '4.2', agreementRef: 'agr_1' },
    });

    expect(task.subject).toContain('Commercial review');
    expect(task.body).toContain('The visitor was not told');
    expect(task.ownerRef).toBe('owner_1');

    const exported = await audit.export('t1');
    const entry = exported.entries.find((e) => (e.payload as Record<string, unknown>)?.['change'] === 'excess_use_detected');
    expect((entry!.payload as Record<string, unknown>)['disclosedToVisitor']).toBe(false);
  });

  it('flags a renewal window to the owner without pressuring the visitor', async () => {
    const { service: entitlement } = service();
    const task = await entitlement.recordRenewalWindow({
      tenantId: 't1', correlationId: 'c1', ownerRef: 'owner_1',
      expiresAt: CONTRACT.expiresAt, noticeByDate: CONTRACT.noticeByDate, autoRenew: true, agreementRef: 'agr_1',
    });
    expect(task.body).toContain('was not told and was not pressured');
  });
});
