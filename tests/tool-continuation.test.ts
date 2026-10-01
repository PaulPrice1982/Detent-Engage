import { describe, expect, it } from 'vitest';
import { AnthropicModelProvider, GroundedModelProvider, TurnOrchestrator } from '@detent/awa-agent';
import type { ModelTurnInput, ModelTurnOutput } from '../packages/agent/src/model.js';
import { buildHarness } from './fixtures/tenant.js';

const answer = (overrides: Partial<ModelTurnOutput> = {}): ModelTurnOutput => ({
  text: 'We audit commercial agreements.', toolCalls: [], confidence: 0.9,
  sentiment: 'neutral', detectedTopics: [], tokensUsed: 10, ...overrides,
});
const lookup = { tool: 'knowledge_lookup', args: { query: 'contract review' } };

describe('tool result continuation', () => {
  it('answers using actual retrieved knowledge, including on the streaming path', async () => {
    const h = await buildHarness();
    let calls = 0;
    const model = { id: 'result-reader', async turn(input: ModelTurnInput) {
      calls++;
      if (!input.toolRounds?.length) return answer({ text: 'Provisional answer.', toolCalls: [lookup] });
      const result = input.toolRounds[0]!.results[0]!.content;
      expect(result['found']).toBe(true);
      expect(String(result['reference'])).toContain('25');
      expect(JSON.stringify(input.toolRounds)).not.toContain('chunkIds');
      return answer({ text: 'A fixed-scope engagement covers 25 contracts.' });
    } };
    const orchestrator = new TurnOrchestrator({ ...h.platform, model });
    const session = await h.platform.openSession(h.config.tenantId, 'UK');
    const stream = orchestrator.runStreaming({ session, config: h.config, visitorInput: 'contract review' });
    const chunks: string[] = [];
    let next = await stream.next();
    while (!next.done) { chunks.push(next.value.text); next = await stream.next(); }
    expect(calls).toBe(2);
    const usage = await h.platform.metering.usage(h.config.tenantId);
    expect(usage.llmTokens).toBe(20);
    expect(usage.textMessages).toBe(1);
    expect(next.value.toolsExecuted).toEqual(['knowledge_lookup']);
    expect(chunks.join(' ')).toBe('A fixed-scope engagement covers 25 contracts.');
  });

  it('returns safe failures and pending outcomes without private executor details', async () => {
    const h = await buildHarness();
    const seen: unknown[] = [];
    const original = h.platform.executor.execute.bind(h.platform.executor);
    h.platform.executor.execute = async (...args) => {
      if (args[3].tool === 'pending') return { modelVisible: { status: 'awaiting_human_approval' }, internal: { secret: 'private-record' } };
      if (args[3].tool === 'failed') throw new Error('private-credential');
      return original(...args);
    };
    const model = { id: 'outcomes', async turn(input: ModelTurnInput) {
      if (!input.toolRounds?.length) return answer({ toolCalls: [{ tool: 'pending', args: {} }, { tool: 'failed', args: {} }] });
      seen.push(input.toolRounds);
      expect(input.toolRounds[0]!.results.map(r => r.content)).toEqual([
        { status: 'awaiting_human_approval' }, { status: 'failed', reason: 'INTERNAL' },
      ]);
      return answer({ text: 'The request is awaiting human approval.' });
    } };
    const orchestrator = new TurnOrchestrator({ ...h.platform, model });
    const session = await h.platform.openSession(h.config.tenantId, 'UK');
    const result = await orchestrator.run({ session, config: h.config, visitorInput: 'hello' });
    expect(result.text).toBe('The request is awaiting human approval.');
    expect(JSON.stringify(seen)).not.toContain('private-');
    expect(result.toolsDenied).toEqual([{ tool: 'failed', reason: 'INTERNAL' }]);
  });

  it('bounds model loops and executes repeated requests only once', async () => {
    const h = await buildHarness();
    let calls = 0;
    const model = { id: 'loop', async turn(input: ModelTurnInput) {
      calls++;
      if (calls === 4) expect(input.tools).toEqual([]);
      return answer({ toolCalls: [{ ...lookup, id: `call_${calls}` }] });
    } };
    const orchestrator = new TurnOrchestrator({ ...h.platform, model });
    const session = await h.platform.openSession(h.config.tenantId, 'UK');
    const result = await orchestrator.run({ session, config: h.config, visitorInput: 'hello' });
    expect(calls).toBe(4);
    expect(result.toolsExecuted.filter(t => t === 'knowledge_lookup')).toEqual(['knowledge_lookup']);
    expect(result.toolsDenied).toContainEqual({ tool: 'knowledge_lookup', reason: 'TOOL_LIMIT' });
    expect(result.text).toContain('guesswork');
  });

  it('preserves completed actions when synthesis fails', async () => {
    const h = await buildHarness();
    const model = { id: 'failure', async turn(input: ModelTurnInput) {
      if (input.toolRounds?.length) throw new Error('provider unavailable');
      return answer({ toolCalls: [lookup] });
    } };
    const orchestrator = new TurnOrchestrator({ ...h.platform, model });
    const session = await h.platform.openSession(h.config.tenantId, 'UK');
    const result = await orchestrator.run({ session, config: h.config, visitorInput: 'hello' });
    expect(result.toolsExecuted).toEqual(['knowledge_lookup']);
    expect(result.text).toContain('trouble');
  });

  it('supports dependent rounds and does not repeat a completed booking', async () => {
    const h = await buildHarness();
    let bookings = 0;
    const execute = h.platform.executor.execute.bind(h.platform.executor);
    h.platform.executor.execute = async (...args) => {
      if (args[3].tool === 'book') {
        bookings++;
        return { modelVisible: { booked: true }, internal: { bookingId: 'private-booking-id' } };
      }
      return execute(...args);
    };
    const model = { id: 'dependent', async turn(input: ModelTurnInput) {
      const rounds = input.toolRounds ?? [];
      if (rounds.length === 0) return answer({ toolCalls: [lookup] });
      if (rounds.length === 1) {
        expect(rounds[0]!.results[0]!.content['found']).toBe(true);
        return answer({ toolCalls: [{ tool: 'book', args: { slot: 'morning', name: 'Visitor' } }] });
      }
      if (rounds.length === 2) return answer({ toolCalls: [{ tool: 'book', args: { name: 'Visitor', slot: 'morning' } }] });
      expect(rounds[2]!.results[0]!.content).toEqual({ booked: true });
      expect(JSON.stringify(rounds)).not.toContain('private-booking-id');
      return answer({ text: 'Your booking is confirmed.' });
    } };
    const orchestrator = new TurnOrchestrator({ ...h.platform, model });
    const session = await h.platform.openSession(h.config.tenantId, 'UK');
    const result = await orchestrator.run({ session, config: h.config, visitorInput: 'book a consultation' });
    expect(bookings).toBe(1);
    expect(result.text).toBe('Your booking is confirmed.');
    expect(result.toolsExecuted).toEqual(['knowledge_lookup', 'book']);
  });

  it('checks spend caps before continuation and retains completed tools', async () => {
    const h = await buildHarness();
    let calls = 0;
    const model = { id: 'cap', async turn() {
      calls++;
      return answer({ toolCalls: [lookup] });
    } };
    const execute = h.platform.executor.execute.bind(h.platform.executor);
    h.platform.executor.execute = async (...args) => {
      const result = await execute(...args);
      h.platform.metering.check = async () => ({ state: 'BLOCKED', reason: 'spend_cap' });
      return result;
    };
    const orchestrator = new TurnOrchestrator({ ...h.platform, model });
    const session = await h.platform.openSession(h.config.tenantId, 'UK');
    const result = await orchestrator.run({ session, config: h.config, visitorInput: 'hello' });
    expect(calls).toBe(1);
    expect(result.degraded).toBe('spend_cap');
    expect(result.toolsExecuted).toEqual(['knowledge_lookup']);
  });

  it('lets the no-API grounded provider answer from the completed lookup', async () => {
    const h = await buildHarness();
    const orchestrator = new TurnOrchestrator({ ...h.platform, model: new GroundedModelProvider() });
    const session = await h.platform.openSession(h.config.tenantId, 'UK');
    const result = await orchestrator.run({ session, config: h.config, visitorInput: 'contract review' });
    expect(result.toolsExecuted).toEqual(['knowledge_lookup']);
    expect(result.text).toContain('25');
  });

  it('maps safe results to native tool_result blocks with matching IDs', async () => {
    const h = await buildHarness();
    let request: any;
    const client: any = { messages: { create: async (input: unknown) => {
      request = input;
      return { content: [{ type: 'text', text: 'Done.' }], usage: {} };
    } } };
    const provider = new AnthropicModelProvider({ client });
    await provider.turn({ systemPrompt: '', history: [], visitorInput: 'hello', tools: [], config: h.config,
      toolRounds: [{ text: 'Checking.', calls: [{ ...lookup, id: 'tool_123' }], results: [{ toolUseId: 'tool_123', content: { reference: 'reference-data-only' } }] }],
    });
    expect(request.messages[1].content[1]).toEqual({ type: 'tool_use', id: 'tool_123', name: lookup.tool, input: lookup.args });
    expect(request.messages[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tool_123', content: '{"reference":"reference-data-only"}', is_error: false });
    expect(JSON.stringify(request.system)).not.toContain('reference-data-only');
  });
});
