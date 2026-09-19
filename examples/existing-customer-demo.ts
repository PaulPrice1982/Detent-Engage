/**
 * The single most persuasive thing in any of the three specifications.
 *
 * Section 62.3: "connect one billing system and one support system to a single
 * pilot tenant and demonstrate the assistant declining to sell to a customer
 * with an open severity-one ticket. No competitor can show it at any price."
 *
 *   pnpm demo:customer
 */
import { FixedClock } from '@detent/awa-core';
import { SandboxConnector } from '@detent/awa-connectors';
import { ScriptedModelProvider, buildToolCatalogue } from '@detent/awa-agent';
import {
  type BillingConnector, type BillingFacts, type ClmConnector, type ClmFacts,
  type SupportConnector, type SupportFacts, type SystemCapabilityDeclaration,
} from '@detent/awa-context';
import { selectMode, checkModeGate, MODES, SELLING_TOOLS } from '@detent/awa-modes';
import { detectExcessUse } from '@detent/awa-entitlement';
import { Platform } from '@detent/awa-server';

const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
const crm = new SandboxConnector();

const platform = new Platform({
  model: new ScriptedModelProvider([
    { match: /.*/, output: { text: 'Happy to help with that.', confidence: 0.9 } },
  ]),
  clock,
  connectors: [crm],
});

const TENANT = 't_pilot';

// --- stub systems standing in for a real Stripe and Zendesk -----------------

const billing = (facts: BillingFacts): BillingConnector => ({
  name: 'stripe', category: 'billing',
  capabilities: (): SystemCapabilityDeclaration => ({
    system: 'stripe', category: 'billing', readOnly: true, optionalWrites: [],
    rateLimit: { requestsPerSecond: 25 }, degradationNotes: [],
  }),
  async readBilling() { return facts; },
});

const support = (facts: SupportFacts): SupportConnector => ({
  name: 'zendesk', category: 'support',
  capabilities: (): SystemCapabilityDeclaration => ({
    system: 'zendesk', category: 'support', readOnly: true, optionalWrites: [],
    rateLimit: { requestsPerSecond: 10 }, degradationNotes: [],
  }),
  async readSupport() { return facts; },
});

const clm = (facts: ClmFacts): ClmConnector => ({
  name: 'ironclad', category: 'clm',
  capabilities: (): SystemCapabilityDeclaration => ({
    system: 'ironclad', category: 'clm', readOnly: true, optionalWrites: [],
    rateLimit: { requestsPerSecond: 5 }, degradationNotes: [],
  }),
  async readContract() { return facts; },
});

async function provision(): Promise<void> {
  platform.tenants.create({
    tenantId: TENANT, name: 'Acme Revenue Ltd', connector: 'sandbox',
    serviceCatalogue: ['contract-review', 'revenue-recovery'],
    outboundAllowlist: ['acme.co.uk'],
  });
  await platform.tenants.recordDpa(TENANT, 'DPA-PILOT');
  await platform.connectCrm(TENANT, 'sandbox', { kind: 'oauth2', accessToken: 'tok' });
  await platform.tenants.transition(TENANT, 'CRM_CONNECTED', 'tenant');
  await platform.tenants.transition(TENANT, 'MAPPED', 'tenant');
  platform.tenants.acceptFieldMapping(TENANT);
  await platform.tenants.transition(TENANT, 'TEST_MODE', 'tenant');
  await platform.tenants.transition(TENANT, 'LIVE', 'tenant');
  // `dryRun` is operator-authority (audit SEC-6): a tenant admin cannot turn
  // their own dry run off, so the platform operator does it.
  await platform.tenants.applyOperatorPatch(TENANT, { dryRun: false }, 'demo provisioning');
  await platform.tenants.update(TENANT, {
    outcomes: { enabled: ['book_meeting', 'resolve_service_query', 'detect_expansion', 'flag_excess_use', 'escalate_at_risk', 'escalate_human'] },
    priceList: [{
      sku: 'contract-review', label: 'Contract review',
      price: { amount: 4500, currency: 'GBP', unit: 'per engagement' },
      conditions: ['Fixed scope of up to 25 contracts.'],
    }],
  }, 'tenant_admin');
}

const heading = (text: string) => console.log(`\n\x1b[1m${text}\x1b[0m\n${'─'.repeat(text.length)}`);
const note = (text: string) => console.log(`  \x1b[90m·  ${text}\x1b[0m`);
const good = (text: string) => console.log(`  \x1b[32m✓  ${text}\x1b[0m`);
const stop = (text: string) => console.log(`  \x1b[33m⨯  ${text}\x1b[0m`);

function connect(systems: Array<BillingConnector | SupportConnector | ClmConnector>): void {
  for (const connector of systems) {
    platform.systems.register({ tenantId: TENANT, connector, credential: { kind: 'api_key', accessToken: 'tok' } });
  }
}

async function scenario(
  title: string,
  systems: Array<BillingConnector | SupportConnector | ClmConnector>,
  verificationLevel: 0 | 1 | 2 | 3 = 1,
): Promise<void> {
  heading(title);
  // Fresh registry per scenario so each one reads its own systems.
  (platform.systems as unknown as { byTenant: Map<string, unknown[]> }).byTenant.delete(TENANT);
  connect(systems);

  const session = await platform.openSession(TENANT, 'UK');
  const context = await platform.customerContext.resolve({
    tenantId: TENANT, correlationId: session.correlationId, sessionId: session.id,
    lookup: { email: 'alex@acme.co.uk', domain: 'acme.co.uk' },
    verificationLevel,
  });

  const mode = await platform.modes.select({
    tenantId: TENANT, sessionId: session.id, correlationId: session.correlationId, context,
  });

  note(`what the platform knows:  relationship ${context.relationship}, standing ${context.standing}, sentiment ${context.sentiment}`);
  note(`systems read:             ${context.sourceSystems.join(', ') || 'none'}`);
  note(`mode selected:            ${mode} — ${MODES[mode].objective}`);
  note(`what the MODEL receives:  ${JSON.stringify(platform.customerContext.toModelSafe(context))}`);

  // Run a real turn so the Article 50 disclosure fires and the compliance
  // scorecard has something honest to report.
  session.mode = mode;
  session.modeForbiddenTools = MODES[mode].sellingPermitted ? [] : SELLING_TOOLS;
  await platform.orchestrator.run({
    session, config: platform.effectiveConfig(TENANT),
    visitorInput: 'Hello, I have a question about our account.',
  });

  for (const tool of ['quote_price', 'knowledge_lookup', 'escalate_to_human']) {
    const gate = checkModeGate(mode, tool);
    (gate.allowed ? good : stop)(`${tool.padEnd(18)} ${gate.allowed ? 'permitted' : gate.reason}`);
  }
}

await provision();

await scenario('1. Happy customer in good standing', [
  billing({ isCustomer: true, paymentStatus: 'current', planName: 'Growth' }),
  support({ openTicketCount: 0, sentiment: 'POSITIVE', recentEscalations: 0 }),
]);

await scenario('2. Same customer, open severity-one ticket', [
  billing({ isCustomer: true, paymentStatus: 'current', planName: 'Growth' }),
  support({ openTicketCount: 3, highestSeverity: 1, sentiment: 'NEGATIVE', recentEscalations: 2 }),
]);
note('This is the demonstration. The CRM says "customer, owned by Priya, stage Renewal".');
note('Every competitor sells into that. This one cannot: selling is refused at the policy gate,');
note('and the model was never told there is a ticket, so it cannot mention it either.');

await scenario('3. Same customer, in arrears', [
  billing({ isCustomer: true, paymentStatus: 'overdue', agedDebtDays: 62 }),
  support({ openTicketCount: 0, sentiment: 'NEUTRAL', recentEscalations: 0 }),
]);
note('Routed to the account team without comment. The visitor is never told why.');

await scenario('4. Customer asking about their own contract, verified to level 2', [
  billing({ isCustomer: true, paymentStatus: 'current' }),
  support({ openTicketCount: 0, sentiment: 'POSITIVE', recentEscalations: 0 }),
  clm({
    hasExecutedAgreement: true, agreementRef: 'agr_001', counterpartyEmailDomain: 'acme.co.uk',
    inScope: [{ category: 'contract-review', label: 'Contract review', clauseRef: '4.2', limit: 25, unit: 'contracts' }],
    outOfScope: ['implementation'],
    excessUseTerms: { metric: 'contracts', limit: 25, rate: 120 },
    clauses: { '4.2': 'The Supplier shall review up to twenty-five (25) Contracts per Engagement.' },
  }),
], 2);

heading('5. Entitlement answers at each verification level');
const contract: ClmFacts = {
  hasExecutedAgreement: true, agreementRef: 'agr_001', counterpartyEmailDomain: 'acme.co.uk',
  inScope: [{ category: 'contract-review', label: 'Contract review', clauseRef: '4.2', limit: 25, unit: 'contracts' }],
  outOfScope: ['implementation'],
  excessUseTerms: { metric: 'contracts', limit: 25, rate: 120 },
  clauses: { '4.2': 'The Supplier shall review up to twenty-five (25) Contracts per Engagement.' },
};

for (const level of [1, 2, 3] as const) {
  const answer = await platform.entitlement.answer({
    tenantId: TENANT, sessionId: 'demo', correlationId: 'corr_demo',
    question: 'Is contract review included in what we have?',
    category: 'contract-review',
    verificationLevel: level,
    contract,
    verifiedEmail: level === 3 ? 'alex@acme.co.uk' : undefined,
  });
  note(`level ${level}: ${answer.kind}`);
  console.log(`      "${answer.say}"`);
}

const interpretation = await platform.entitlement.answer({
  tenantId: TENANT, sessionId: 'demo', correlationId: 'corr_demo',
  question: 'Does that clause mean we can terminate early?',
  verificationLevel: 3, contract, verifiedEmail: 'alex@acme.co.uk',
});
stop(`interpretation refused: ${interpretation.kind}`);
console.log(`      "${interpretation.say}"`);

heading('6. Excess use: detected, tasked, and never mentioned');
const finding = detectExcessUse(contract, { metric: 'contracts', consumed: 41 });
const task = await platform.entitlement.recordExcessUse({
  tenantId: TENANT, correlationId: 'corr_demo', ownerRef: 'owner_1', finding: finding!,
});
note(`detected: ${finding!.consumed} against a contracted ${finding!.limit} ${finding!.metric}`);
note(`internal task raised for ${task.ownerRef}: "${task.subject}"`);
stop('the visitor was not told, and the model was never given the figure');

heading('Evidence');
const exported = await platform.audit.export(TENANT);
const compliance = await platform.compliance.build(
  TENANT, { from: '0000-01-01T00:00:00.000Z', to: '9999-12-31T23:59:59.999Z' }, clock.iso(),
);
console.log(`  audit entries: ${exported.entries.length}, chain verified: ${exported.verification.valid}`);
console.log(`  selling tools gated by mode: ${SELLING_TOOLS.join(', ')}`);
console.log(`  compliance scorecard sessions: ${compliance.sessionsOpened}, disclosure coverage: ${compliance.aiDisclosureCoveragePct}%`);
console.log('');
void buildToolCatalogue;
void selectMode;
