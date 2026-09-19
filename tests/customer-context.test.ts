import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { FixedClock } from '@detent/awa-core';
import {
  CustomerContextService, PERMITTED_WRITE_CAPABILITIES, SystemRegistry,
  assertReadOnlyUnlessEnabled, derive,
  type BillingConnector, type BillingFacts, type ClmConnector, type ClmFacts,
  type SupportConnector, type SupportFacts, type SystemCapabilityDeclaration,
} from '@detent/awa-context';
import { MODES, checkModeGate, selectMode } from '@detent/awa-modes';

/**
 * CI gates for v1.2 sections 54 and 56 / FR-081 to FR-087, FR-094 to FR-096.
 *
 * Two invariants from section 62.1: **zero source-system data in model
 * context**, and **zero sales behaviours in service-only mode.**
 */
const clock = () => new FixedClock(new Date('2026-09-04T09:00:00.000Z'));

function stubBilling(facts: BillingFacts): BillingConnector {
  return {
    name: 'stub-billing', category: 'billing',
    capabilities: (): SystemCapabilityDeclaration => ({
      system: 'stub-billing', category: 'billing', readOnly: true, optionalWrites: [],
      rateLimit: { requestsPerSecond: 10 }, degradationNotes: ['stub'],
    }),
    async readBilling() { return facts; },
  };
}

function stubSupport(facts: SupportFacts): SupportConnector {
  return {
    name: 'stub-support', category: 'support',
    capabilities: (): SystemCapabilityDeclaration => ({
      system: 'stub-support', category: 'support', readOnly: true, optionalWrites: [],
      rateLimit: { requestsPerSecond: 10 }, degradationNotes: ['stub'],
    }),
    async readSupport() { return facts; },
  };
}

function stubClm(facts: ClmFacts): ClmConnector {
  return {
    name: 'stub-clm', category: 'clm',
    capabilities: (): SystemCapabilityDeclaration => ({
      system: 'stub-clm', category: 'clm', readOnly: true, optionalWrites: [],
      rateLimit: { requestsPerSecond: 5 }, degradationNotes: ['stub'],
    }),
    async readContract() { return facts; },
  };
}

async function contextFor(systems: Parameters<SystemRegistry['register']>[0]['connector'][], verificationLevel: 0 | 1 | 2 | 3 = 1) {
  const fixed = clock();
  const audit = new AuditLog(new InMemoryAuditStore(), fixed);
  const registry = new SystemRegistry();
  for (const connector of systems) {
    registry.register({ tenantId: 't1', connector, credential: { kind: 'api_key', accessToken: 'tok' } });
  }
  const service = new CustomerContextService((tenantId) => registry.forTenant(tenantId), audit, fixed);
  const context = await service.resolve({
    tenantId: 't1', correlationId: 'corr_1',
    lookup: { email: 'alex@acme.co.uk' },
    verificationLevel,
  });
  return { context, service, audit, registry };
}

describe('the read-only rule (FR-083)', () => {
  it('permits exactly three write exceptions and no others', () => {
    expect(PERMITTED_WRITE_CAPABILITIES).toEqual(['create_support_ticket', 'create_clm_task', 'create_quote_request']);
  });

  it('refuses a connector declaring a write outside the three exceptions', () => {
    const rogue = {
      ...stubBilling({ isCustomer: true, paymentStatus: 'current' }),
      capabilities: (): SystemCapabilityDeclaration => ({
        system: 'rogue', category: 'billing' as const, readOnly: true,
        optionalWrites: ['refund_invoice' as never],
        rateLimit: { requestsPerSecond: 1 }, degradationNotes: [],
      }),
    };
    expect(() => assertReadOnlyUnlessEnabled(rogue, [])).toThrowError(/outside the three permitted exceptions/);
  });

  it('refuses a connector holding a write the tenant has not enabled', () => {
    const ticketing = {
      ...stubSupport({ openTicketCount: 0, sentiment: 'UNKNOWN', recentEscalations: 0 }),
      capabilities: (): SystemCapabilityDeclaration => ({
        system: 'zendesk', category: 'support' as const, readOnly: true,
        optionalWrites: ['create_support_ticket' as const],
        rateLimit: { requestsPerSecond: 1 }, degradationNotes: [],
      }),
    };
    expect(() => assertReadOnlyUnlessEnabled(ticketing, [])).toThrowError(/has not enabled/);
    expect(() => assertReadOnlyUnlessEnabled(ticketing, ['create_support_ticket'])).not.toThrow();
  });
});

describe('CustomerContext resolution (FR-082)', () => {
  it('answers "is this a customer in good standing" from billing', async () => {
    const { context } = await contextFor([stubBilling({ isCustomer: true, paymentStatus: 'current' })]);
    expect(context.relationship).toBe('CUSTOMER');
    expect(context.standing).toBe('GOOD');
  });

  it('detects arrears from an overdue payment status', async () => {
    const { context } = await contextFor([stubBilling({ isCustomer: true, paymentStatus: 'overdue', agedDebtDays: 45 })]);
    expect(context.standing).toBe('IN_ARREARS');
  });

  it('answers "is now a terrible moment to sell" from support', async () => {
    const { context } = await contextFor([
      stubBilling({ isCustomer: true, paymentStatus: 'current' }),
      stubSupport({ openTicketCount: 2, highestSeverity: 1, sentiment: 'NEGATIVE', recentEscalations: 2 }),
    ]);
    expect(context.sentiment).toBe('NEGATIVE');
    expect(context.openItems.severityBand).toBe('severe');
  });

  it('derives entitlement from the CLM', async () => {
    const { context } = await contextFor([
      stubBilling({ isCustomer: true, paymentStatus: 'current' }),
      stubClm({
        hasExecutedAgreement: true, agreementRef: 'agr_1',
        inScope: [{ category: 'contract-review', label: 'Contract review', clauseRef: '4.2' }],
        outOfScope: ['implementation'],
        expiresAt: '2026-10-15T00:00:00.000Z',
      }),
    ], 2);
    expect(context.entitlement.inScope).toContain('contract-review');
    expect(context.entitlement.outOfScope).toContain('implementation');
    expect(context.commercial.renewalWindow).toBe(true);
  });

  it('reverts to CRM-only and names the gap where a category is not connected (FR-085)', async () => {
    const { context } = await contextFor([stubBilling({ isCustomer: true, paymentStatus: 'current' })]);
    expect(context.sourceSystems).toEqual(['billing']);
    expect(context.unconnectedCategories).toEqual(['support', 'clm']);
    expect(context.sentiment).toBe('UNKNOWN');
  });

  it('survives one system failing without losing the others', async () => {
    const broken: BillingConnector = {
      ...stubBilling({ isCustomer: true, paymentStatus: 'current' }),
      async readBilling() { throw new Error('billing timed out'); },
    };
    const { context } = await contextFor([
      broken,
      stubSupport({ openTicketCount: 1, highestSeverity: 3, sentiment: 'NEUTRAL', recentEscalations: 0 }),
    ]);
    expect(context.sourceSystems).toEqual(['support']);
    expect(context.standing).toBe('UNKNOWN');
  });

  it('returns UNKNOWN rather than an optimistic guess when nothing is connected', async () => {
    const { context } = await contextFor([]);
    expect(context.relationship).toBe('UNKNOWN');
    expect(context.standing).toBe('UNKNOWN');
    expect(context.permittedBehaviours).toEqual(['qualify_normally']);
  });
});

describe('the model receives permittedBehaviours only (FR-084)', () => {
  it('places zero source-system data in model context', async () => {
    const { context, service } = await contextFor([
      stubBilling({ isCustomer: true, paymentStatus: 'overdue', agedDebtDays: 92, planName: 'Enterprise', renewalDate: '2026-12-01T00:00:00.000Z' }),
      stubSupport({ openTicketCount: 3, highestSeverity: 1, sentiment: 'NEGATIVE', recentEscalations: 2 }),
    ]);
    const modelSafe = service.toModelSafe(context);
    const serialised = JSON.stringify(modelSafe);

    // The invariant. The model is never told the customer has not paid, so it
    // cannot say so.
    expect(Object.keys(modelSafe).sort()).toEqual(['permittedBehaviours', 'verificationLevel']);
    for (const leak of ['overdue', 'IN_ARREARS', '92', 'Enterprise', 'NEGATIVE', '2026-12-01', 'ticket']) {
      expect(serialised).not.toContain(leak);
    }
  });

  it('produces the section 54.4 behaviours for a customer in arrears with a severe ticket', async () => {
    const { context } = await contextFor([
      stubBilling({ isCustomer: true, paymentStatus: 'overdue' }),
      stubSupport({ openTicketCount: 1, highestSeverity: 1, sentiment: 'NEGATIVE', recentEscalations: 1 }),
    ]);
    expect(context.permittedBehaviours).toEqual(
      expect.arrayContaining(['acknowledge_existing_relationship', 'route_to_account_team', 'do_not_sell']),
    );
  });

  it('does not offer entitlement behaviours below verification level 2', async () => {
    const clm = stubClm({
      hasExecutedAgreement: true, inScope: [{ category: 'x', label: 'X' }], outOfScope: ['y'],
    });
    const level1 = await contextFor([stubBilling({ isCustomer: true, paymentStatus: 'current' }), clm], 1);
    expect(level1.context.permittedBehaviours).not.toContain('confirm_in_scope');

    const level2 = await contextFor([stubBilling({ isCustomer: true, paymentStatus: 'current' }), clm], 2);
    expect(level2.context.permittedBehaviours).toContain('confirm_in_scope');
  });

  it('records bands in the audit log, never the balance', async () => {
    const { audit } = await contextFor([stubBilling({ isCustomer: true, paymentStatus: 'overdue', agedDebtDays: 92 })]);
    const exported = await audit.export('t1');
    // The band is recorded; the number behind it is not.
    const payloads = exported.entries.map((entry) => entry.payload ?? {});
    expect(JSON.stringify(payloads)).toContain('IN_ARREARS');
    for (const payload of payloads) {
      expect(payload).not.toHaveProperty('agedDebtDays');
      expect(JSON.stringify(payload)).not.toContain('overdue');
    }
  });
});

describe('mode selection is deterministic (FR-094)', () => {
  const base = derive({
    verificationLevel: 1, sourceSystems: ['billing', 'support'],
    renewalWindowDays: 90, now: '2026-09-04T09:00:00.000Z',
  });

  it('selects acquisition for a non-customer', () => {
    expect(selectMode(base)).toBe('ACQUISITION');
  });

  it('selects service and expansion for a happy customer in good standing', () => {
    const context = { ...base, relationship: 'CUSTOMER' as const, standing: 'GOOD' as const, sentiment: 'POSITIVE' as const };
    expect(selectMode(context)).toBe('SERVICE_AND_EXPANSION');
  });

  it('selects service-only for an unhappy customer', () => {
    const context = { ...base, relationship: 'CUSTOMER' as const, standing: 'GOOD' as const, sentiment: 'NEGATIVE' as const };
    expect(selectMode(context)).toBe('SERVICE_ONLY');
  });

  it('selects service-only for a severe open ticket even when sentiment is neutral', () => {
    const context = {
      ...base, relationship: 'CUSTOMER' as const, standing: 'GOOD' as const, sentiment: 'NEUTRAL' as const,
      openItems: { ...base.openItems, severityBand: 'severe' as const },
    };
    expect(selectMode(context)).toBe('SERVICE_ONLY');
  });

  it('selects escalate-only in arrears, and arrears outrank unhappiness', () => {
    const context = { ...base, relationship: 'CUSTOMER' as const, standing: 'IN_ARREARS' as const, sentiment: 'NEGATIVE' as const };
    expect(selectMode(context)).toBe('ESCALATE_ONLY');
  });

  it('selects the renewal mode when a window is open', () => {
    const context = {
      ...base, relationship: 'CUSTOMER' as const, standing: 'GOOD' as const, sentiment: 'NEUTRAL' as const,
      commercial: { ...base.commercial, renewalWindow: true },
    };
    expect(selectMode(context)).toBe('SERVICE_AND_RENEWAL');
  });

  it('selects human-led win-back for a churned customer, never an automated sequence', () => {
    expect(selectMode({ ...base, relationship: 'CHURNED' })).toBe('WIN_BACK');
    expect(MODES.WIN_BACK.mustEscalate).toBe(true);
    expect(MODES.WIN_BACK.sellingPermitted).toBe(false);
  });
});

describe('the mode gate refuses selling, it does not discourage it (FR-095)', () => {
  it('refuses every selling tool in service-only mode', () => {
    for (const tool of ['quote_price', 'create_opportunity', 'enrol_sequence', 'capture_contact']) {
      expect(checkModeGate('SERVICE_ONLY', tool).allowed).toBe(false);
    }
  });

  it('still permits answering and escalating in service-only mode', () => {
    for (const tool of ['knowledge_lookup', 'escalate_to_human', 'create_note']) {
      expect(checkModeGate('SERVICE_ONLY', tool).allowed).toBe(true);
    }
  });

  it('refuses commitments in escalate-only mode (FR-096)', () => {
    expect(checkModeGate('ESCALATE_ONLY', 'book_meeting').allowed).toBe(false);
    expect(checkModeGate('ESCALATE_ONLY', 'send_transactional_email').allowed).toBe(false);
  });

  it('permits selling in acquisition and expansion modes', () => {
    expect(checkModeGate('ACQUISITION', 'quote_price').allowed).toBe(true);
    expect(checkModeGate('SERVICE_AND_EXPANSION', 'quote_price').allowed).toBe(true);
  });
});
