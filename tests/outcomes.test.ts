import { describe, expect, it } from 'vitest';
import {
  BILLABLE_OUTCOMES, NON_BILLABLE_OUTCOMES, OUTCOME_TAXONOMY,
  continuityKeyFor, isBillable, requiresConfirmation, sameThread,
  type ChannelConversationRef,
} from '@detent/awa-core';
import { selectPartner, verifySignature } from '@detent/awa-outcomes';
import { buildToolCatalogue } from '@detent/awa-agent';
import { buildHarness } from './fixtures/tenant.js';
import { RecordingDispatcher } from './fixtures/extension.js';
import { Platform } from '@detent/awa-server';
import { ScriptedModelProvider } from '@detent/awa-agent';
import { SandboxConnector } from '@detent/awa-connectors';
import { FixedClock } from '@detent/awa-core';

/**
 * CI gates for section 40 / FR-044 to FR-048.
 *
 * The two commercial invariants: escalation, disqualification and abandonment
 * are never billable; and no outcome is billed without downstream confirmation
 * where the taxonomy requires it.
 */
describe('the nine-outcome taxonomy', () => {
  const V1_1_OUTCOMES = [
    'book_meeting', 'start_trial', 'route_self_serve', 'route_partner', 'request_quote',
    'escalate_human', 'escalate_support', 'disqualify', 'abandoned',
  ] as const;

  const V1_2_OUTCOMES = [
    'resolve_service_query', 'detect_expansion', 'flag_renewal', 'flag_excess_use',
    'detect_adoption_gap', 'escalate_at_risk', 'route_partner_v2',
  ] as const;

  it('covers the nine v1.1 outcomes plus the seven v1.2 existing-customer outcomes', () => {
    expect(Object.keys(OUTCOME_TAXONOMY)).toHaveLength(16);
    for (const outcome of [...V1_1_OUTCOMES, ...V1_2_OUTCOMES]) {
      expect(OUTCOME_TAXONOMY[outcome]).toBeDefined();
    }
  });

  it('marks escalation, disqualification and abandonment non-billable (FR-047)', () => {
    expect(NON_BILLABLE_OUTCOMES).toEqual(
      expect.arrayContaining(['escalate_human', 'escalate_support', 'disqualify', 'abandoned']),
    );
    for (const outcome of ['escalate_human', 'escalate_support', 'disqualify', 'abandoned'] as const) {
      expect(isBillable(outcome)).toBe(false);
    }
  });

  it('marks the five v1.1 commercial outcomes billable', () => {
    expect(V1_1_OUTCOMES.filter(isBillable)).toEqual(
      ['book_meeting', 'start_trial', 'route_self_serve', 'route_partner', 'request_quote'],
    );
    expect(BILLABLE_OUTCOMES).toEqual(expect.arrayContaining(['book_meeting', 'request_quote']));
  });

  it('never bills an at-risk escalation, for the same reason it never bills any escalation', () => {
    // Billing it would create an incentive to find unhappy customers.
    expect(isBillable('escalate_at_risk')).toBe(false);
  });

  it('requires downstream confirmation before billing recovered excess use', () => {
    // The only revenue line in any variation paid from money the tenant would
    // not otherwise have collected. Billing it before the money exists would be
    // indefensible.
    expect(requiresConfirmation('flag_excess_use')).toBe(true);
  });

  it('requires downstream confirmation only where a second system must report back', () => {
    expect(requiresConfirmation('start_trial')).toBe(true);
    expect(requiresConfirmation('route_self_serve')).toBe(true);
    // The calendar provider already confirmed the slot; there is nobody else to hear from.
    expect(requiresConfirmation('book_meeting')).toBe(false);
  });
});

describe('outcome recording and billing', () => {
  async function platformWith(dispatcher = new RecordingDispatcher()) {
    const clock = new FixedClock(new Date('2026-09-04T09:00:00.000Z'));
    const crm = new SandboxConnector();
    const platform = new Platform({
      model: new ScriptedModelProvider([]),
      clock, connectors: [crm],
      outcomeDispatcher: dispatcher,
      publicBaseUrl: 'https://platform.example',
    });
    platform.tenants.create({ tenantId: 't_out', name: 'Out Ltd', connector: 'sandbox', serviceCatalogue: ['x'] });
    await platform.tenants.recordDpa('t_out', 'DPA');
    await platform.connectCrm('t_out', 'sandbox', { kind: 'oauth2', accessToken: 'tok' });
    await platform.tenants.transition('t_out', 'CRM_CONNECTED', 'tenant');
    await platform.tenants.transition('t_out', 'MAPPED', 'tenant');
    platform.tenants.acceptFieldMapping('t_out');
    await platform.tenants.transition('t_out', 'TEST_MODE', 'tenant');
    await platform.tenants.transition('t_out', 'LIVE', 'tenant');
    // `dryRun` is operator-authority; the outcome catalogue is the tenant's.
    await platform.tenants.applyOperatorPatch('t_out', { dryRun: false }, 'test fixture');
    await platform.tenants.update('t_out', {
      outcomes: {
        enabled: ['book_meeting', 'start_trial', 'route_self_serve', 'route_partner', 'request_quote', 'escalate_human', 'disqualify', 'abandoned'],
        trialProvisioning: { method: 'webhook', endpoint: 'https://tenant.example/trials', signingKeyRef: 'shared-secret' },
        partners: [
          { id: 'p_ie', name: 'Acme Ireland', entityRef: 'ent_ie', criteria: 'country=IE' },
          { id: 'p_ent', name: 'Enterprise desk', criteria: 'seats>250' },
        ],
      },
    }, 'tenant_admin');
    return { platform, dispatcher, config: platform.tenants.get('t_out') };
  }

  it('bills a booked meeting immediately, since the calendar already confirmed it', async () => {
    const { platform, config } = await platformWith();
    const recorded = await platform.outcomes.record({
      config, conversationId: 'sess_1', correlationId: 'corr_1', outcome: 'book_meeting',
    });
    expect(recorded.state).toBe('CONFIRMED');
    expect(await platform.outcomes.billableCount('t_out')).toBe(1);
  });

  it('does not bill an escalation, ever', async () => {
    const { platform, config } = await platformWith();
    const recorded = await platform.outcomes.record({
      config, conversationId: 'sess_1', correlationId: 'corr_1', outcome: 'escalate_human',
    });
    expect(recorded.state).toBe('NOT_BILLABLE');
    expect(recorded.billable).toBe(false);
    expect(await platform.outcomes.billableCount('t_out')).toBe(0);
    const usage = await platform.metering.usage('t_out');
    expect(usage.qualifiedOutcomes).toBe(0);
  });

  it('holds a trial unbilled until the tenant system confirms it (FR-046)', async () => {
    const { platform, config, dispatcher } = await platformWith();
    const recorded = await platform.outcomes.record({
      config, conversationId: 'sess_1', correlationId: 'corr_trial', outcome: 'start_trial',
      person: { email: 'alex@acme.co.uk' },
    });

    expect(recorded.state).toBe('AWAITING_CONFIRMATION');
    expect(await platform.outcomes.billableCount('t_out')).toBe(0);

    // The webhook fired, signed, with no product credential in it.
    expect(dispatcher.calls).toHaveLength(1);
    const payload = dispatcher.calls[0]!.payload as Record<string, unknown>;
    expect(payload['success_callback']).toContain('/v1/outcomes/corr_trial/confirm');
    expect(JSON.stringify(payload)).not.toMatch(/password|api_key|credential/i);
    expect(verifySignature('shared-secret', JSON.stringify(payload), dispatcher.calls[0]!.signature)).toBe(true);

    await platform.outcomes.confirm('t_out', 'corr_trial', { succeeded: true });
    expect(await platform.outcomes.billableCount('t_out')).toBe(1);
  });

  it('never bills a routing decision that failed downstream', async () => {
    const { platform, config } = await platformWith();
    await platform.outcomes.record({
      config, conversationId: 'sess_1', correlationId: 'corr_fail', outcome: 'route_self_serve',
    });
    await platform.outcomes.confirm('t_out', 'corr_fail', { succeeded: false, reason: 'checkout abandoned' });
    expect(await platform.outcomes.billableCount('t_out')).toBe(0);
  });

  it('marks a trial failed when the tenant webhook rejects it', async () => {
    const { platform, config } = await platformWith(new RecordingDispatcher(500));
    const recorded = await platform.outcomes.record({
      config, conversationId: 'sess_1', correlationId: 'corr_e', outcome: 'start_trial',
    });
    expect(recorded.state).toBe('FAILED');
    expect(await platform.outcomes.billableCount('t_out')).toBe(0);
  });

  it('refuses an outcome the tenant has not enabled', async () => {
    const { platform, config } = await platformWith();
    await expect(platform.outcomes.record({
      config, conversationId: 's', correlationId: 'c', outcome: 'escalate_support',
    })).rejects.toMatchObject({ kind: 'POLICY_DENIED' });
  });

  it('records an outcome through the tool layer without telling the model it is billable', async () => {
    const { platform, config } = await platformWith();
    const session = await platform.openSession('t_out', 'UK');
    const result = await platform.executor.execute(session, config, buildToolCatalogue(config.serviceCatalogue), {
      tool: 'record_outcome', args: { outcome: 'book_meeting', summary: 'Booked.' },
    });
    expect(result.modelVisible['recorded']).toBe(true);
    // Billability is internal: telling the model invites it to optimise for it.
    expect(result.modelVisible['billable']).toBeUndefined();
    expect(result.internal?.['billable']).toBe(true);
  });
});

describe('partner routing', () => {
  it('selects a partner on a matched criterion', async () => {
    const { config } = await buildHarness();
    const withPartners = {
      ...config,
      outcomes: {
        ...config.outcomes,
        partners: [
          { id: 'p_ie', name: 'Acme Ireland', criteria: 'country=IE' },
          { id: 'p_ent', name: 'Enterprise desk', criteria: 'seats>250' },
        ],
      },
    };
    expect(selectPartner({ config: withPartners, signals: { country: 'IE' } }).partner?.id).toBe('p_ie');
    expect(selectPartner({ config: withPartners, signals: { seats: 400 } }).partner?.id).toBe('p_ent');
    expect(selectPartner({ config: withPartners, signals: { seats: 10 } }).partner).toBeUndefined();
  });

  it('routes to the tenant directly when nothing matches', async () => {
    const { config } = await buildHarness();
    const selection = selectPartner({ config, signals: { country: 'GB' } });
    expect(selection.partner).toBeUndefined();
    expect(selection.reason).toMatch(/no partners registered/);
  });
});

describe('channel-agnostic conversation model (FR-069)', () => {
  it('resolves a website session and a later email reply to one thread', () => {
    const envelope = { purposes: [], jurisdiction: 'UK' as const, source: 'HOST_CMP' as const, eventIds: {} };
    const website: ChannelConversationRef = {
      id: 'c1', tenantId: 't1', channel: 'WEBSITE', modality: 'TEXT',
      consentEnvelope: envelope,
      continuityKey: continuityKeyFor('t1', { email: 'Alex@Acme.co.uk' }),
    };
    const email: ChannelConversationRef = {
      id: 'c2', tenantId: 't1', channel: 'EMAIL', modality: 'TEXT',
      consentEnvelope: { ...envelope, source: 'EMAIL_REPLY' },
      continuityKey: continuityKeyFor('t1', { email: 'alex@acme.co.uk ' }),
    };
    expect(sameThread(website, email)).toBe(true);
  });

  it('does not merge threads across tenants', () => {
    const a = continuityKeyFor('t1', { email: 'alex@acme.co.uk' });
    const b = continuityKeyFor('t2', { email: 'alex@acme.co.uk' });
    expect(a).not.toBe(b);
  });

  it('refuses to build a continuity key with no identifier', () => {
    expect(() => continuityKeyFor('t1', {})).toThrowError(/requires an email or a subject reference/);
  });
});
