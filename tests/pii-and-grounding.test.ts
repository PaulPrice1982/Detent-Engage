import { describe, expect, it } from 'vitest';
import { containsPii, redactObject, redactText, validate } from '@detent/awa-core';
import { KnowledgeCorpus, RetrievalService, checkGrounding, NO_KNOWLEDGE_RESPONSE } from '@detent/awa-knowledge';
import { buildToolCatalogue } from '@detent/awa-agent';
import { buildHarness } from './fixtures/tenant.js';

/**
 * CI gates: PII leakage (zero personal data in logs or output) and
 * groundedness (zero invented facts, prices, availability or commitments)
 * (sections 15.2, 30, 36.2).
 */
describe('PII redaction before logging', () => {
  it('redacts emails, phones, cards, NI numbers, postcodes and IPs', () => {
    const input = 'Alex (alex.warner@acme.co.uk, 07700 900123, NI QQ123456C) at SW1A 1AA from 192.168.0.14, card 4111 1111 1111 1111';
    const { text, counts } = redactText(input);
    expect(text).not.toContain('alex.warner@acme.co.uk');
    expect(text).not.toContain('07700 900123');
    expect(text).not.toContain('QQ123456C');
    expect(text).not.toContain('4111');
    expect(counts['email']).toBe(1);
    expect(containsPii(text)).toBe(false);
  });

  it('drops credentials outright rather than pattern-redacting them', () => {
    const redacted = redactObject({
      access_token: 'at_live_1234',
      refresh_token: 'rt_live_5678',
      nested: { client_secret: 'shh', note: 'call alex@acme.co.uk' },
    }) as Record<string, unknown>;
    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain('at_live_1234');
    expect(serialised).not.toContain('shh');
    expect(serialised).toContain('[redacted]');
    expect(serialised).not.toContain('alex@acme.co.uk');
  });

  it('leaves non-personal operational values readable for debugging', () => {
    const redacted = redactObject({ latency_ms: 412, tool: 'upsert_person', ok: true }) as Record<string, unknown>;
    expect(redacted['latency_ms']).toBe(412);
    expect(redacted['tool']).toBe('upsert_person');
  });

  it('does not put personal data into the audit log even when a caller passes it', async () => {
    const harness = await buildHarness();
    await harness.platform.audit.write({
      tenantId: harness.config.tenantId, type: 'tool_call_executed',
      correlationId: 'c1', actor: 'system',
      payload: { transcript: 'My email is alex@acme.co.uk and my number is 07700 900123' },
    });
    const exported = await harness.platform.audit.export(harness.config.tenantId);
    const serialised = JSON.stringify(exported.entries);
    expect(serialised).not.toContain('alex@acme.co.uk');
    expect(serialised).not.toContain('07700 900123');
  });
});

describe('governed ingestion and grounding', () => {
  it('refuses to ingest unshipped capability', () => {
    const corpus = new KnowledgeCorpus();
    expect(() => corpus.ingest({
      tenantId: 't1', sourceKind: 'faq', sourceRef: 'roadmap',
      title: 'Coming soon', text: 'Q2 2027 we will launch automated recovery.', shipped: false,
    })).toThrowError(/unshipped/);
  });

  it('does not serve a draft until a named tenant approver publishes it', () => {
    const corpus = new KnowledgeCorpus();
    const retrieval = new RetrievalService(corpus);
    const chunk = corpus.ingest({
      tenantId: 't1', sourceKind: 'faq', sourceRef: 'x',
      title: 'Renewals', text: 'We handle renewal uplift audits across the portfolio.', shipped: true,
    });
    expect(retrieval.retrieve('t1', 'renewal uplift audits')).toHaveLength(0);

    corpus.publish('t1', chunk.id, 'marketing@acme.co.uk');
    const results = retrieval.retrieve('t1', 'renewal uplift audits');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.chunk.approvedBy).toBe('marketing@acme.co.uk');
  });

  it('versions every published change so a past answer can be explained', () => {
    const corpus = new KnowledgeCorpus();
    const a = corpus.ingest({ tenantId: 't1', sourceKind: 'faq', sourceRef: 'x', title: 'A', text: 'first', shipped: true });
    corpus.publish('t1', a.id, 'admin');
    expect(corpus.version('t1')).toBe(1);
    const b = corpus.ingest({ tenantId: 't1', sourceKind: 'faq', sourceRef: 'y', title: 'B', text: 'second', shipped: true });
    corpus.publish('t1', b.id, 'admin');
    expect(corpus.version('t1')).toBe(2);
  });

  it('flags an invented figure as unsupported', () => {
    const chunks = [{
      chunk: {
        id: 'kc1', tenantId: 't1', corpusVersion: 1, state: 'PUBLISHED' as const,
        sourceKind: 'faq' as const, sourceRef: 'x', title: 'Pricing',
        text: 'Contract review is £4500 per engagement.', shipped: true, createdAt: 'now',
      },
      score: 1,
    }];
    expect(checkGrounding('It is £4500 per engagement.', chunks).grounded).toBe(true);
    const invented = checkGrounding('It is £3200 and we can start on 1 October.', chunks);
    expect(invented.grounded).toBe(false);
    expect(invented.unsupportedClaims.length).toBeGreaterThan(0);
  });

  it('says plainly that it does not know rather than falling back to general knowledge', async () => {
    const harness = await buildHarness();
    const config = harness.platform.effectiveConfig(harness.config.tenantId);
    const session = await harness.platform.openSession(config.tenantId, 'UK');

    const result = await harness.platform.executor.execute(session, config, buildToolCatalogue(config.serviceCatalogue), {
      tool: 'knowledge_lookup',
      args: { query: 'what is your policy on cryptocurrency payments' },
    });
    expect(result.modelVisible['found']).toBe(false);
    expect(result.modelVisible['guidance']).toBe(NO_KNOWLEDGE_RESPONSE);
  });
});

describe('tool schema validation', () => {
  const catalogue = buildToolCatalogue(['contract-review']);
  const capture = catalogue.find((t) => t.name === 'capture_contact')!.parameters;

  it('rejects a malformed email', () => {
    expect(validate({ work_email: 'not-an-email', full_name: 'Alex Warner', service_interest: 'contract-review', confirmed_fields: ['work_email'] }, capture).valid).toBe(false);
  });

  it('rejects a service outside the tenant catalogue', () => {
    const outcome = validate({ work_email: 'a@acme.co.uk', full_name: 'Alex Warner', service_interest: 'something-else', confirmed_fields: ['work_email'] }, capture);
    expect(outcome.valid).toBe(false);
    expect(outcome.issues[0]!.message).toContain('must be one of');
  });

  it('rejects a phone that is not E.164', () => {
    expect(validate({ work_email: 'a@acme.co.uk', full_name: 'Alex Warner', service_interest: 'contract-review', phone_e164: '07700900123', confirmed_fields: ['work_email'] }, capture).valid).toBe(false);
    expect(validate({ work_email: 'a@acme.co.uk', full_name: 'Alex Warner', service_interest: 'contract-review', phone_e164: '+447700900123', confirmed_fields: ['work_email', 'phone_e164'] }, capture).valid).toBe(true);
  });

  it('rejects an unknown property', () => {
    expect(validate({ work_email: 'a@acme.co.uk', full_name: 'Alex Warner', service_interest: 'contract-review', confirmed_fields: ['work_email'], owner: 'x' }, capture).valid).toBe(false);
  });

  it('requires the confirmed_fields control array', () => {
    expect(validate({ work_email: 'a@acme.co.uk', full_name: 'Alex Warner', service_interest: 'contract-review' }, capture).valid).toBe(false);
  });
});

describe('field confirmation control', () => {
  it('rejects a capture whose values were never read back to the visitor', async () => {
    const harness = await buildHarness();
    const config = harness.platform.effectiveConfig(harness.config.tenantId);
    const session = await harness.platform.openSession(config.tenantId, 'UK');

    const decision = await harness.platform.policy.evaluate({
      tenantConfig: config, tool: 'capture_contact',
      args: {
        work_email: 'alex@acme.co.uk',
        full_name: 'Alex Warner',
        phone_e164: '+447700900123',
        service_interest: 'contract-review',
        // The phone was transcribed but never confirmed.
        confirmed_fields: ['work_email', 'full_name'],
      },
      correlationId: session.correlationId, sessionId: session.id,
      subjectRef: session.subjectRef, connectionState: 'CONNECTED',
    });

    expect(decision.effect).toBe('DENY');
    expect(decision.reasons.join(' ')).toContain('phone_e164');
  });

  it('allows a capture where every supplied field was confirmed', async () => {
    const harness = await buildHarness();
    const config = harness.platform.effectiveConfig(harness.config.tenantId);
    const session = await harness.platform.openSession(config.tenantId, 'UK');

    const decision = await harness.platform.policy.evaluate({
      tenantConfig: config, tool: 'capture_contact',
      args: {
        work_email: 'alex@acme.co.uk', full_name: 'Alex Warner',
        service_interest: 'contract-review',
        confirmed_fields: ['work_email', 'full_name'],
      },
      correlationId: session.correlationId, sessionId: session.id,
      subjectRef: session.subjectRef, connectionState: 'CONNECTED',
    });
    expect(decision.effect).toBe('ALLOW');
  });
});
