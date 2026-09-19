import { describe, expect, it } from 'vitest';
import { AuditLog, InMemoryAuditStore } from '@detent/awa-audit';
import { FixedClock } from '@detent/awa-core';
import { GroupIdentityService, HierarchyService, PartnerRegistry, type Partner } from '@detent/awa-groups';
import { MachineSurface, REGISTERED_RATE_PER_MINUTE, UNREGISTERED_RATE_PER_MINUTE } from '@detent/awa-machine';
import {
  AssurancePackGenerator, DETERMINISTIC_BOUNDARIES, SECTOR_PRESETS,
  applySectorPreset, buildAccessibilityStatement,
} from '@detent/awa-assurance';
import { ComplianceScorecardService, allTime } from '@detent/awa-analytics';
import { buildHarness } from './fixtures/tenant.js';

/**
 * CI gates for v1.2 sections 53, 57, 58 and 59.
 *
 * Section 62.1 invariants: **zero cross-entity content crossing without an
 * explicit grant**, group-wide suppression honoured 100%, and **zero identity
 * resolutions on the machine surface.**
 */
const POLICY_FLOOR = {
  minimumConfidenceFloor: 0.7,
  recordingAllowed: false,
  followUpLaneTwoAllowed: false,
  requireApprovalForOpportunity: true,
};

function groupFixture() {
  const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
  const audit = new AuditLog(new InMemoryAuditStore(), clock);
  const hierarchy = new HierarchyService(audit, clock);
  hierarchy.createGroup({ groupId: 'g1', name: 'Northwind Capital', policyFloor: POLICY_FLOOR });
  for (const [entityId, tenantId, name] of [
    ['e_a', 't_a', 'Portfolio A'], ['e_b', 't_b', 'Portfolio B'],
    ['e_c', 't_c', 'Portfolio C'], ['e_d', 't_d', 'Portfolio D'],
  ] as const) {
    hierarchy.addEntity({ entityId, groupId: 'g1', tenantId, name });
  }
  const identity = new GroupIdentityService(hierarchy, audit, (groupId) => `salt:${groupId}`);
  return { hierarchy, identity, audit, clock };
}

describe('the group is a billing and reporting construct, not a data-sharing one', () => {
  it('supports one group operating four distinct CRMs (FR-075)', () => {
    const { hierarchy } = groupFixture();
    const entities = hierarchy.entitiesIn('g1');
    expect(entities).toHaveLength(4);
    // Each entity is a separate tenant. Isolation is section 14, unchanged.
    expect(new Set(entities.map((entity) => entity.tenantId)).size).toBe(4);
  });

  it('denies group access to entity conversation content by default (FR-076)', () => {
    const { hierarchy } = groupFixture();
    expect(hierarchy.mayReadContent('g1', 'e_a')).toBe(false);
  });

  it('permits content access only on an explicit, auditable grant from the entity', async () => {
    const { hierarchy, audit } = groupFixture();
    await hierarchy.grantContentAccess({
      groupId: 'g1', entityId: 'e_a', grantedBy: 'dpo@portfolio-a.example',
      basis: 'Documented joint-controller arrangement dated 2026-08-01', correlationId: 'c1',
    });
    expect(hierarchy.mayReadContent('g1', 'e_a')).toBe(true);
    // Entity B is unaffected: a grant is per entity, not per group.
    expect(hierarchy.mayReadContent('g1', 'e_b')).toBe(false);

    const exported = await audit.export('t_a');
    expect(exported.entries.some((entry) => entry.type === 'break_glass_access')).toBe(true);
  });

  it('honours a revocation immediately', async () => {
    const { hierarchy } = groupFixture();
    const grant = await hierarchy.grantContentAccess({
      groupId: 'g1', entityId: 'e_a', grantedBy: 'dpo', basis: 'documented', correlationId: 'c1',
    });
    await hierarchy.revokeContentAccess(grant.grantId, 'c2');
    expect(hierarchy.mayReadContent('g1', 'e_a')).toBe(false);
  });

  it('honours an expiry', async () => {
    const { hierarchy, clock } = groupFixture();
    await hierarchy.grantContentAccess({
      groupId: 'g1', entityId: 'e_a', grantedBy: 'dpo', basis: 'documented',
      correlationId: 'c1', expiresAt: '2026-09-04T10:00:00.000Z',
    });
    expect(hierarchy.mayReadContent('g1', 'e_a')).toBe(true);
    clock.advance(2 * 60 * 60 * 1000);
    expect(hierarchy.mayReadContent('g1', 'e_a')).toBe(false);
  });

  it('applies the group policy floor as a floor, never a ceiling', () => {
    const { hierarchy } = groupFixture();
    const stricter = hierarchy.applyPolicyFloor('g1', {
      escalation: { confidenceFloor: 0.9 },
      recording: { enabled: false }, followUp: { enabled: false },
      requireApprovalForOpportunity: true,
    });
    expect(stricter.escalation.confidenceFloor).toBe(0.9);

    const looser = hierarchy.applyPolicyFloor('g1', {
      escalation: { confidenceFloor: 0.3 },
      recording: { enabled: true }, followUp: { enabled: true },
      requireApprovalForOpportunity: false,
    });
    expect(looser.escalation.confidenceFloor).toBe(0.7);
    expect(looser.recording.enabled).toBe(false);
    expect(looser.followUp.enabled).toBe(false);
    expect(looser.requireApprovalForOpportunity).toBe(true);
  });
});

describe('suppression crosses where data does not (FR-077, FR-078)', () => {
  it('suppresses at every entity from an opt-out at one', async () => {
    const { identity, audit } = groupFixture();
    const result = await identity.suppressAcrossGroup({
      groupId: 'g1', email: 'alex@acme.co.uk', originEntityId: 'e_a', correlationId: 'c1',
    });
    expect(result.entitiesSuppressed).toBe(4);
    expect(identity.isSuppressedInGroup('g1', 'alex@acme.co.uk')).toBe(true);

    // Each entity is a separate controller and needs its own evidence.
    for (const tenantId of ['t_a', 't_b', 't_c', 't_d']) {
      const exported = await audit.export(tenantId);
      expect(exported.entries.some((entry) => entry.type === 'consent_withdrawn')).toBe(true);
      // No address crossed. Only a digest.
      expect(JSON.stringify(exported.entries)).not.toContain('alex@acme.co.uk');
    }
  });

  it('counts a visitor once across entities without content crossing', () => {
    const { identity } = groupFixture();
    identity.countConversation('g1', 'e_a', 'alex@acme.co.uk');
    identity.countConversation('g1', 'e_b', 'alex@acme.co.uk');
    identity.countConversation('g1', 'e_b', 'alex@acme.co.uk');

    const report = identity.groupReport('g1');
    expect(report.uniqueVisitors).toBe(1);
    expect(report.rows[0]!.entityIds.sort()).toEqual(['e_a', 'e_b']);
    expect(report.rows[0]!.conversations).toBe(3);
    // Pseudonymised. Not reversible to an address.
    expect(JSON.stringify(report)).not.toContain('alex');
  });

  it('produces different digests for the same person in different groups', () => {
    const { identity } = groupFixture();
    identity.countConversation('g1', 'e_a', 'alex@acme.co.uk');
    identity.countConversation('g2', 'e_z', 'alex@acme.co.uk');
    const a = identity.groupReport('g1').rows[0]!.subjectDigest;
    const b = identity.groupReport('g2').rows[0]!.subjectDigest;
    expect(a).not.toBe(b);
  });

  it('refuses cross-entity relationship disclosure by default', () => {
    const { identity } = groupFixture();
    const verdict = identity.mayLearnCrossEntityRelationship({
      groupId: 'g1', readingEntityId: 'e_b', holdingEntityId: 'e_a',
      jointControllerArrangementDocumented: false, visitorInformed: false,
    });
    expect(verdict.permitted).toBe(false);
  });

  it('requires a documented arrangement, an informed visitor and a grant, all three', async () => {
    const { identity, hierarchy } = groupFixture();
    await hierarchy.grantContentAccess({ groupId: 'g1', entityId: 'e_a', grantedBy: 'dpo', basis: 'documented', correlationId: 'c1' });

    expect(identity.mayLearnCrossEntityRelationship({
      groupId: 'g1', readingEntityId: 'e_b', holdingEntityId: 'e_a',
      jointControllerArrangementDocumented: true, visitorInformed: false,
    }).permitted).toBe(false);

    expect(identity.mayLearnCrossEntityRelationship({
      groupId: 'g1', readingEntityId: 'e_b', holdingEntityId: 'e_a',
      jointControllerArrangementDocumented: true, visitorInformed: true,
    }).permitted).toBe(true);
  });
});

describe('partner routing (FR-109 to FR-112)', () => {
  const partner = (over: Partial<Partner>): Partner => ({
    partnerId: 'p1', name: 'Partner One', territories: ['UK'], sectors: ['legal'],
    services: ['contract-review'], capacity: 10, tier: 1, crmConnected: false, ...over,
  });

  function registry() {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const audit = new AuditLog(new InMemoryAuditStore(), clock);
    return { registry: new PartnerRegistry(audit), audit };
  }

  it('refuses to route without a recorded third-party disclosure consent (FR-110)', async () => {
    const { registry: reg } = registry();
    reg.register('t1', partner({}));
    const outcome = await reg.route({
      tenantId: 't1', correlationId: 'c1',
      signals: { territory: 'UK', sector: 'legal', service: 'contract-review' },
      thirdPartyDisclosureConsentRecorded: false,
    });
    expect(outcome.kind).toBe('CONSENT_REQUIRED');
  });

  it('routes deterministically on territory, sector, service and capacity', async () => {
    const { registry: reg } = registry();
    reg.register('t1', partner({ partnerId: 'p_uk', territories: ['UK'] }));
    reg.register('t1', partner({ partnerId: 'p_ie', territories: ['IE'] }));
    const outcome = await reg.route({
      tenantId: 't1', correlationId: 'c1',
      signals: { territory: 'IE', sector: 'legal', service: 'contract-review' },
      thirdPartyDisclosureConsentRecorded: true,
    });
    expect(outcome.kind).toBe('ROUTED');
    expect(outcome.kind === 'ROUTED' && outcome.partner.partnerId).toBe('p_ie');
  });

  it('round-robins within a tier', async () => {
    const { registry: reg } = registry();
    reg.register('t1', partner({ partnerId: 'p_a', tier: 1 }));
    reg.register('t1', partner({ partnerId: 'p_b', tier: 1 }));
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) {
      const outcome = await reg.route({
        tenantId: 't1', correlationId: `c${i}`,
        signals: { territory: 'UK', sector: 'legal', service: 'contract-review' },
        thirdPartyDisclosureConsentRecorded: true,
      });
      if (outcome.kind === 'ROUTED') picks.push(outcome.partner.partnerId);
    }
    expect(new Set(picks).size).toBe(2);
  });

  it('never routes to a partner at zero capacity', async () => {
    const { registry: reg } = registry();
    reg.register('t1', partner({ capacity: 0 }));
    const outcome = await reg.route({
      tenantId: 't1', correlationId: 'c1',
      signals: { territory: 'UK', sector: 'legal', service: 'contract-review' },
      thirdPartyDisclosureConsentRecorded: true,
    });
    expect(outcome.kind).toBe('NO_MATCH');
  });

  it('escalates an internal-versus-partner ownership conflict, never resolving it (FR-112)', async () => {
    const { registry: reg } = registry();
    reg.register('t1', partner({}));
    const outcome = await reg.route({
      tenantId: 't1', correlationId: 'c1',
      signals: { territory: 'UK', sector: 'legal', service: 'contract-review' },
      thirdPartyDisclosureConsentRecorded: true,
      internalOwnerRef: 'owner_1',
    });
    expect(outcome.kind).toBe('CONFLICT_ESCALATED');
    expect(outcome.kind === 'CONFLICT_ESCALATED' && outcome.claimants).toContain('owner_1');
  });

  it('preserves attribution end to end in deal registration (FR-111)', () => {
    const { registry: reg } = registry();
    const registration = reg.buildDealRegistration({
      partner: partner({ crmConnected: true }),
      person: { email: 'alex@acme.co.uk' },
      attribution: { source: 'organic', campaign: 'q3', landingPage: '/pricing' },
      correlationId: 'corr_1',
    });
    expect(registration.destination).toBe('partner_crm');
    expect(registration.payload['attribution']).toMatchObject({ source: 'organic', campaign: 'q3', correlation_id: 'corr_1' });
  });
});

describe('the machine surface (FR-099 to FR-104)', () => {
  function surface() {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const audit = new AuditLog(new InMemoryAuditStore(), clock);
    return { surface: new MachineSurface(audit, clock), audit, clock };
  }

  it('serves the AI disclosure to machines, so any downstream human is told', async () => {
    const { surface: machine } = surface();
    const { config } = await buildHarness();
    const document = await machine.serve({
      config, principal: { registered: false }, correlationId: 'c1', availability: [],
    });
    expect(document.disclosure).toContain('AI');
  });

  it('serves approved content only, and publishes what it may not read', async () => {
    const { surface: machine } = surface();
    const { config } = await buildHarness();
    const document = await machine.serve({
      config, principal: { registered: false }, correlationId: 'c1', availability: [],
    });
    expect(document.pricing.map((row) => row.sku)).toEqual(config.priceList.map((row) => row.sku));
    expect(document.policy.mayNotRead.join(' ')).toMatch(/CRM record/);
    expect(document.policy.identityResolution).toBe('never');
  });

  it('never resolves identity, and logs the refusal (FR-100)', async () => {
    const { surface: machine, audit } = surface();
    await expect(machine.refuseIdentityResolution('t1', 'c1')).rejects.toMatchObject({ kind: 'CONSENT_REQUIRED' });
    const exported = await audit.export('t1');
    expect(exported.entries.some((entry) => entry.type === 'resolution_blocked_no_consent')).toBe(true);
  });

  it('never trusts a self-declared identity', () => {
    const { surface: machine } = surface();
    expect(machine.authenticate('awa_agt_agent_deadbeef_forged').registered).toBe(false);
    const { key } = machine.register('Research Agent');
    expect(machine.authenticate(key).registered).toBe(true);
  });

  it('rate-limits anonymous traffic harder than registered, in a separate pool (FR-102)', () => {
    const { surface: machine } = surface();
    const anonymous = { registered: false as const };
    for (let i = 0; i < UNREGISTERED_RATE_PER_MINUTE; i++) {
      expect(machine.checkRate('t1', anonymous).allowed).toBe(true);
    }
    const blocked = machine.checkRate('t1', anonymous);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    // A registered agent has its own bucket and a higher ceiling.
    const registered = { registered: true as const, agentId: 'agent_1' };
    expect(machine.checkRate('t1', registered).allowed).toBe(true);
    expect(machine.checkRate('t1', registered).limit).toBe(REGISTERED_RATE_PER_MINUTE);
  });

  it('makes an agent booking provisional until a human confirms (FR-101)', async () => {
    const { surface: machine } = surface();
    const { booking, confirmationToken } = await machine.requestProvisionalBooking({
      tenantId: 't1', principal: { registered: true, agentId: 'agent_1' },
      slotId: 'slot_1', requesterEmail: 'buyer@acme.co.uk', correlationId: 'c1',
    });
    expect(booking.state).toBe('PROVISIONAL');

    await expect(machine.confirmByHuman({ tenantId: 't1', bookingId: booking.id, token: 'wrong', correlationId: 'c2' }))
      .rejects.toMatchObject({ kind: 'POLICY_DENIED' });

    const confirmed = await machine.confirmByHuman({
      tenantId: 't1', bookingId: booking.id, token: confirmationToken, correlationId: 'c2',
    });
    expect(confirmed.state).toBe('CONFIRMED');
  });

  it('reports agent traffic separately from human traffic (FR-103)', async () => {
    const { surface: machine } = surface();
    const { config } = await buildHarness();
    await machine.serve({ config, principal: { registered: false }, correlationId: 'c1', availability: [] });
    await machine.serve({ config, principal: { registered: true, agentId: 'agent_1' }, correlationId: 'c2', availability: [] });

    const report = machine.trafficReport(config.tenantId);
    expect(report.total).toBe(2);
    expect(report.registered).toBe(1);
    expect(report.anonymous).toBe(1);
    expect(report.bySurface['catalogue']).toBe(2);
  });

  it('shows an unregistered agent less than a registered one', async () => {
    const { surface: machine } = surface();
    const { config } = await buildHarness();
    const availability = Array.from({ length: 10 }, (_, i) => ({ slotId: `s${i}`, startsAt: 'x', endsAt: 'y' }));
    const anon = await machine.serve({ config, principal: { registered: false }, correlationId: 'c1', availability });
    const reg = await machine.serve({ config, principal: { registered: true, agentId: 'a' }, correlationId: 'c2', availability });
    expect(anon.availability.length).toBeLessThan(reg.availability.length);
  });
});

describe('the Behavioural Assurance Pack (FR-105 to FR-108)', () => {
  it('assembles the boundary table across all three specification versions', () => {
    const sources = new Set(DETERMINISTIC_BOUNDARIES.map((row) => row.source.split(' ')[0]));
    expect(sources).toEqual(new Set(['v1.0', 'v1.1', 'v1.2']));
    expect(DETERMINISTIC_BOUNDARIES.length).toBeGreaterThan(20);
  });

  it('exports in one action, with the compliance scorecard and its chain verification', async () => {
    const harness = await buildHarness();
    const generator = new AssurancePackGenerator(
      harness.platform.audit, new ComplianceScorecardService(harness.platform.audit),
    );
    const pack = await generator.generate({
      config: harness.config, window: allTime(), generatedAt: '2026-09-04T10:00:00.000Z',
      accessibility: buildAccessibilityStatement({}),
    });
    expect(pack.compliance.evidence.chainVerified).toBe(true);
    expect(pack.deterministicBoundaries.length).toBeGreaterThan(0);
  });

  it('replays a conversation with the exact versions that produced it (FR-107)', async () => {
    const harness = await buildHarness({ script: [{ match: /.*/, output: { text: 'Hello.' } }] });
    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    await harness.platform.orchestrator.run({
      session, config: harness.platform.effectiveConfig(session.tenantId), visitorInput: 'Hi',
    });

    const generator = new AssurancePackGenerator(
      harness.platform.audit, new ComplianceScorecardService(harness.platform.audit),
    );
    const replay = await generator.replay(session.tenantId, session.correlationId);
    expect(replay.versions.policy).toBe(harness.config.policyVersion);
    expect(replay.chainVerified).toBe(true);
    expect(replay.entries.length).toBeGreaterThan(1);
  });

  it('refuses to claim conformance without a named auditor and a date', () => {
    const unaudited = buildAccessibilityStatement({});
    expect(unaudited.conformance).toBe('not_assessed');
    expect(unaudited.statement).toContain('no conformance claim is made');

    const audited = buildAccessibilityStatement({ auditedBy: 'AbilityNet', auditedAt: '2026-08-20' });
    expect(audited.conformance).toBe('full');
  });

  it('warns in the pack itself when no simulation or audit backs it', async () => {
    const harness = await buildHarness();
    const generator = new AssurancePackGenerator(
      harness.platform.audit, new ComplianceScorecardService(harness.platform.audit),
    );
    const pack = await generator.generate({
      config: harness.config, window: allTime(), generatedAt: 'now',
      accessibility: buildAccessibilityStatement({}),
    });
    expect(pack.caveats.join(' ')).toContain('No simulation run is included');
    expect(pack.caveats.join(' ')).toContain('has not been independently audited');
  });

  it('applies a sector preset that only ever tightens (FR-108)', async () => {
    const { config } = await buildHarness();
    const tightened = applySectorPreset(config, SECTOR_PRESETS.legal_services);
    expect(tightened.escalation.confidenceFloor).toBeGreaterThanOrEqual(0.85);
    expect(tightened.escalation.highRiskTopics).toContain('privilege');
    expect(tightened.recording.enabled).toBe(false);
    expect(tightened.followUp.enabled).toBe(false);

    // A tenant already stricter than the preset stays stricter.
    const stricter = applySectorPreset(
      { ...config, escalation: { ...config.escalation, confidenceFloor: 0.95 } },
      SECTOR_PRESETS.financial_services,
    );
    expect(stricter.escalation.confidenceFloor).toBe(0.95);
  });
});
