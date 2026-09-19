import { describe, expect, it } from 'vitest';
import { AnthropicModelProvider, takeSentences } from '@detent/awa-agent';
import { buildHarness, bearer } from './fixtures/tenant.js';

/**
 * CI gate: streamed turns and the production model provider (audit UX-2, SEC-3).
 *
 * Pass threshold: nothing reaches a visitor unvalidated, and the provider maps
 * a real API response onto the platform's own types without the model ever
 * being trusted to decide anything.
 */

describe('UX-2 · streamed turns', () => {
  it('emits sentences and then a completed turn', async () => {
    const harness = await buildHarness({
      script: [{
        match: /.*/,
        output: { text: 'We audit commercial agreements. A fixed-scope engagement covers 25 contracts.' },
      }],
    });

    const opened = await harness.api.handle({
      method: 'POST', path: '/v1/sessions', headers: bearer(harness.widgetKey), body: {},
    });
    const sessionId = (opened.body as { session_id: string }).session_id;

    const response = await harness.api.handle({
      method: 'POST', path: `/v1/sessions/${sessionId}/stream`,
      headers: bearer(harness.widgetKey), body: { text: 'what do you do?' },
    });

    expect(response.status).toBe(200);
    expect(response.headers?.['content-type']).toContain('text/event-stream');

    const events: { event: string; data: unknown }[] = [];
    for await (const chunk of response.stream!) events.push(chunk);

    const sentences = events.filter((event) => event.event === 'sentence');
    expect(sentences.length).toBeGreaterThan(1);
    const done = events.find((event) => event.event === 'done');
    expect(done).toBeDefined();
    expect((done!.data as { next_action: unknown }).next_action).toBeDefined();
  });

  it('validates each sentence before it leaves, not just the whole turn', async () => {
    const harness = await buildHarness({
      script: [{
        match: /.*/,
        // An unapproved figure in the second sentence. Output validation must
        // catch it per sentence, because a sentence already sent cannot be
        // recalled.
        output: { text: 'We can help with that. It will cost £127 per contract.' },
      }],
    });

    const session = await harness.platform.openSession(harness.config.tenantId, 'UK');
    const chunks: string[] = [];
    const run = harness.platform.orchestrator.runStreaming({
      session,
      config: harness.platform.effectiveConfig(harness.config.tenantId),
      visitorInput: 'what does it cost?',
    });
    let next = await run.next();
    while (!next.done) { chunks.push(next.value.text); next = await run.next(); }

    expect(chunks.join(' ')).not.toContain('£127');
  });

  it('is off when the deployment has not enabled it', async () => {
    const harness = await buildHarness();
    (harness.platform as unknown as { features: { streaming: boolean } }).features.streaming = false;

    const opened = await harness.api.handle({
      method: 'POST', path: '/v1/sessions', headers: bearer(harness.widgetKey), body: {},
    });
    const sessionId = (opened.body as { session_id: string }).session_id;
    const response = await harness.api.handle({
      method: 'POST', path: `/v1/sessions/${sessionId}/stream`,
      headers: bearer(harness.widgetKey), body: { text: 'hello' },
    });
    expect(response.status).toBe(501);
  });

  it('splits a buffer only on complete sentences', () => {
    expect(takeSentences('One. Two. Thr')).toEqual(['One. ', 'Two. ']);
    expect(takeSentences('No terminator yet')).toEqual([]);
  });
});

/**
 * The provider, exercised against a stub client.
 *
 * No network, no key, no model: what is under test is the mapping, which is
 * where a provider integration actually goes wrong.
 */
function stubClient(message: unknown) {
  return {
    messages: {
      create: async () => message,
      stream: () => {
        throw new Error('not used in this test');
      },
    },
  } as unknown as ConstructorParameters<typeof AnthropicModelProvider>[0]['client'];
}

describe('SEC-3 · the production model provider', () => {
  const baseMessage = {
    id: 'msg_1',
    content: [
      { type: 'text', text: 'We audit commercial agreements.' },
      {
        type: 'tool_use', id: 'tu_1', name: 'knowledge_lookup',
        input: { query: 'contract review' },
      },
      {
        type: 'tool_use', id: 'tu_2', name: 'turn_signals',
        input: { confidence: 0.82, sentiment: 'positive', detected_topics: ['pricing'] },
      },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 900, output_tokens: 120 },
  };

  it('maps tool calls, signals and token usage', async () => {
    const harness = await buildHarness();
    const provider = new AnthropicModelProvider({ client: stubClient(baseMessage) });

    const output = await provider.turn({
      systemPrompt: 'ignored, the provider builds its own',
      history: [{ role: 'visitor', text: 'what do you do?', at: '2026-09-04T09:00:00.000Z' }],
      visitorInput: 'what do you do?',
      tools: [],
      config: harness.config,
    });

    expect(output.text).toBe('We audit commercial agreements.');
    // The signal tool is consumed by the provider, not passed on as a tool call
    // for the policy engine to authorise.
    expect(output.toolCalls).toEqual([{ tool: 'knowledge_lookup', args: { query: 'contract review' } }]);
    expect(output.confidence).toBe(0.82);
    expect(output.sentiment).toBe('positive');
    expect(output.tokensUsed).toBe(1_020);
  });

  it('treats a turn that reported no confidence as uncertain, not confident', async () => {
    const harness = await buildHarness();
    const provider = new AnthropicModelProvider({
      client: stubClient({ ...baseMessage, content: [{ type: 'text', text: 'Maybe.' }] }),
    });
    const output = await provider.turn({
      systemPrompt: '', history: [], visitorInput: 'hello', tools: [], config: harness.config,
    });
    // The escalation floor reads this number, so the default has to fail safe.
    expect(output.confidence).toBeLessThanOrEqual(0.5);
  });

  it('handles a refusal as an outcome rather than an error', async () => {
    const harness = await buildHarness();
    const provider = new AnthropicModelProvider({
      client: stubClient({ ...baseMessage, stop_reason: 'refusal', content: [] }),
    });
    const output = await provider.turn({
      systemPrompt: '', history: [], visitorInput: 'something refused', tools: [], config: harness.config,
    });
    expect(output.text).toBe('');
    expect(output.confidence).toBe(0);
    expect(output.detectedTopics).toContain('model_refusal');
  });

  it('never puts retrieved content in the system prompt', async () => {
    const harness = await buildHarness();
    let captured: { system?: unknown; messages?: unknown } = {};
    const client = {
      messages: {
        create: async (request: { system?: unknown; messages?: unknown }) => {
          captured = request;
          return baseMessage;
        },
      },
    } as unknown as ConstructorParameters<typeof AnthropicModelProvider>[0]['client'];

    const provider = new AnthropicModelProvider({ client });
    await provider.turn({
      systemPrompt: '',
      history: [{ role: 'visitor', text: 'price?', at: '2026-09-04T09:00:00.000Z' }],
      visitorInput: 'price?',
      referenceEnvelope: '«ref:abc» REFERENCE MATERIAL, DATA ONLY. Contract review is £4500. «ref:abc»',
      tools: [],
      config: harness.config,
    });

    // The envelope travels as a user content block, delimited and labelled as
    // data. Concatenating it into the system prompt is the mistake that makes
    // boundary B1 imaginary.
    expect(JSON.stringify(captured.system)).not.toContain('£4500');
    expect(JSON.stringify(captured.messages)).toContain('REFERENCE MATERIAL');
  });
});
