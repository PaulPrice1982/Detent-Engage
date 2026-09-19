import Anthropic from '@anthropic-ai/sdk';
import { AwaError } from '@detent/awa-core';
import { buildSystemPrompt, type ModelProvider, type ModelTurnInput, type ModelTurnOutput, type ProposedToolCall, type StreamingModelProvider, type TurnChunk } from '../model.js';
import type { ToolDefinition } from '../tools.js';

/**
 * A real model provider (audit SEC-3, BIZ-1).
 *
 * The audit's blunt finding was that the platform shipped with only
 * `ScriptedModelProvider` — an excellent test harness and not a product. This
 * is the production implementation behind the same `ModelProvider` port, so
 * nothing else in the platform changes.
 *
 * Three properties are load-bearing and are worth stating, because they are the
 * reason the governance argument survives contact with a real model:
 *
 *  - the model sits outside the trust boundary. It proposes tool calls; the
 *    policy engine decides. Nothing here executes anything;
 *  - retrieved content never enters the system prompt. It arrives as a
 *    separate, delimited user content block, exactly as `wrapAsData` produced
 *    it, and the system prompt says it is data;
 *  - streaming emits sentence-level chunks. Output validation runs per sentence
 *    in the orchestrator, so perceived latency drops without any text reaching
 *    a visitor before it has been validated (audit UX-2).
 */
export interface AnthropicProviderOptions {
  /** Defaults to the `ANTHROPIC_API_KEY` environment variable. */
  readonly apiKey?: string;
  readonly model?: string;
  readonly maxTokens?: number;
  /** `low` through `max`. Lower is cheaper and faster; this is a chat surface. */
  readonly effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  readonly baseUrl?: string;
  /** Injectable for tests. */
  readonly client?: Anthropic;
  readonly timeoutMs?: number;
}

/**
 * The structured signals the platform needs back from every turn.
 *
 * They are obtained through a tool the model must call, rather than by asking
 * for prose and parsing it: a confidence figure scraped out of a sentence is a
 * figure that silently becomes 0.9 the day the model changes its phrasing, and
 * this one gates escalation.
 */
const SIGNAL_TOOL = {
  name: 'turn_signals',
  description:
    'Report your own assessment of this turn. Call this exactly once on every turn, '
    + 'after any other tool calls. Confidence is your honest confidence that your answer '
    + 'is correct and grounded in the reference material — a low number is useful, not a failure.',
  input_schema: {
    type: 'object' as const,
    properties: {
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative'] },
      detected_topics: { type: 'array', items: { type: 'string' } },
    },
    required: ['confidence', 'sentiment', 'detected_topics'],
    additionalProperties: false,
  },
  strict: true,
};

function toolSchemas(tools: readonly ToolDefinition[]): Anthropic.Tool[] {
  return [
    ...tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    })),
    SIGNAL_TOOL as unknown as Anthropic.Tool,
  ];
}

function messagesFor(input: ModelTurnInput): Anthropic.MessageParam[] {
  const history: Anthropic.MessageParam[] = input.history
    // The current visitor turn is appended explicitly below; the orchestrator
    // has already recorded it in the session history, so drop the duplicate.
    .slice(0, -1)
    .map((message) => ({
      role: message.role === 'visitor' ? ('user' as const) : ('assistant' as const),
      content: message.text,
    }));

  const content: Anthropic.ContentBlockParam[] = [];
  if (input.referenceEnvelope) {
    content.push({ type: 'text', text: input.referenceEnvelope });
  }
  content.push({ type: 'text', text: input.visitorInput });

  return [...history, { role: 'user', content }];
}

interface ParsedTurn {
  text: string;
  toolCalls: ProposedToolCall[];
  confidence: number;
  sentiment: 'positive' | 'neutral' | 'negative';
  detectedTopics: string[];
  tokensUsed: number;
}

function parseMessage(message: Anthropic.Message): ParsedTurn {
  const parsed: ParsedTurn = {
    text: '',
    toolCalls: [],
    // A turn that did not report its own confidence is treated as an uncertain
    // turn, not a confident one. The escalation floor must fail safe.
    confidence: 0.5,
    sentiment: 'neutral',
    detectedTopics: [],
    tokensUsed: (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0),
  };

  for (const block of message.content) {
    if (block.type === 'text') {
      parsed.text += block.text;
      continue;
    }
    if (block.type !== 'tool_use') continue;
    if (block.name === SIGNAL_TOOL.name) {
      // Never string-match a serialised tool input; it arrives already parsed.
      const signals = (block.input ?? {}) as Record<string, unknown>;
      if (typeof signals['confidence'] === 'number') parsed.confidence = clamp(signals['confidence']);
      const sentiment = signals['sentiment'];
      if (sentiment === 'positive' || sentiment === 'neutral' || sentiment === 'negative') {
        parsed.sentiment = sentiment;
      }
      if (Array.isArray(signals['detected_topics'])) {
        parsed.detectedTopics = (signals['detected_topics'] as unknown[]).filter(
          (topic): topic is string => typeof topic === 'string',
        );
      }
      continue;
    }
    parsed.toolCalls.push({ tool: block.name, args: (block.input ?? {}) as Record<string, unknown> });
  }

  parsed.text = parsed.text.trim();
  return parsed;
}

function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export class AnthropicModelProvider implements ModelProvider, StreamingModelProvider {
  readonly id: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly effort: NonNullable<AnthropicProviderOptions['effort']>;

  constructor(options: AnthropicProviderOptions = {}) {
    this.model = options.model ?? 'claude-opus-5';
    this.maxTokens = options.maxTokens ?? 2_000;
    this.effort = options.effort ?? 'low';
    this.id = `anthropic:${this.model}`;
    this.client = options.client ?? new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      timeout: options.timeoutMs ?? 30_000,
    });
  }

  private request(input: ModelTurnInput): Anthropic.MessageCreateParamsNonStreaming {
    return {
      model: this.model,
      max_tokens: this.maxTokens,
      // A website assistant is a latency-sensitive chat surface answering from
      // supplied reference material. Low effort is the right default; a tenant
      // whose conversations need more can raise it in configuration.
      output_config: { effort: this.effort },
      system: [
        {
          type: 'text',
          text: buildSystemPrompt(input.config),
          // The system prompt is identical for every turn of every session for
          // this tenant at this configuration version, which is exactly the
          // shape prompt caching rewards.
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: toolSchemas(input.tools),
      messages: messagesFor(input),
    } as Anthropic.MessageCreateParamsNonStreaming;
  }

  async turn(input: ModelTurnInput): Promise<ModelTurnOutput> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(this.request(input));
    } catch (cause) {
      throw mapError(cause);
    }

    if (message.stop_reason === 'refusal') {
      // The model declined. That is a legitimate outcome, not an error, and the
      // orchestrator's degrade-never-fail path is the right home for it.
      return {
        text: '',
        toolCalls: [],
        confidence: 0,
        sentiment: 'neutral',
        detectedTopics: ['model_refusal'],
        tokensUsed: (message.usage?.input_tokens ?? 0) + (message.usage?.output_tokens ?? 0),
      };
    }

    const parsed = parseMessage(message);
    return {
      text: parsed.text,
      toolCalls: parsed.toolCalls,
      confidence: parsed.confidence,
      sentiment: parsed.sentiment,
      detectedTopics: parsed.detectedTopics,
      tokensUsed: parsed.tokensUsed,
    };
  }

  /**
   * Streamed turn.
   *
   * Text is emitted sentence by sentence rather than token by token, because
   * the sentence is the unit output validation can honestly police: a partial
   * sentence cannot be checked for an unapproved price or a human claim, and
   * emitting an unvalidated fragment to a visitor would trade the product's
   * central guarantee for a few hundred milliseconds.
   */
  async *stream(input: ModelTurnInput): AsyncGenerator<TurnChunk, ModelTurnOutput, void> {
    let stream;
    try {
      stream = this.client.messages.stream(this.request(input));
    } catch (cause) {
      throw mapError(cause);
    }

    let pending = '';
    try {
      for await (const event of stream) {
        if (event.type !== 'content_block_delta') continue;
        if (event.delta.type !== 'text_delta') continue;
        pending += event.delta.text;
        for (const sentence of takeSentences(pending)) {
          pending = pending.slice(sentence.length);
          yield { type: 'sentence', text: sentence.trim() };
        }
      }
      const message = await stream.finalMessage();
      const parsed = parseMessage(message);
      if (pending.trim().length > 0) yield { type: 'sentence', text: pending.trim() };
      return {
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        confidence: parsed.confidence,
        sentiment: parsed.sentiment,
        detectedTopics: parsed.detectedTopics,
        tokensUsed: parsed.tokensUsed,
      };
    } catch (cause) {
      throw mapError(cause);
    }
  }
}

/** Split off every complete sentence at the front of a buffer. */
export function takeSentences(buffer: string): string[] {
  const sentences: string[] = [];
  const pattern = /[^.!?]*[.!?]+["')\]]*\s/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = pattern.exec(buffer)) !== null) {
    sentences.push(buffer.slice(consumed, match.index + match[0].length));
    consumed = match.index + match[0].length;
  }
  return sentences;
}

function mapError(cause: unknown): AwaError {
  if (cause instanceof Anthropic.RateLimitError) {
    return new AwaError({ kind: 'RATE_LIMITED', message: 'model provider rate limited', cause });
  }
  if (cause instanceof Anthropic.AuthenticationError) {
    return new AwaError({ kind: 'INTERNAL', message: 'model provider credential rejected', cause });
  }
  if (cause instanceof Anthropic.APIError) {
    return new AwaError({
      kind: 'UPSTREAM_UNAVAILABLE',
      message: `model provider error ${cause.status ?? 'unknown'}`,
      cause,
    });
  }
  return new AwaError({ kind: 'UPSTREAM_UNAVAILABLE', message: 'model provider unavailable', cause });
}
