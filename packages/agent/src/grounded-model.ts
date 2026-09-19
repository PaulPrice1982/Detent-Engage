import type { ModelProvider, ModelTurnInput, ModelTurnOutput } from './model.js';

/**
 * A model provider that answers only from what was retrieved.
 *
 * It exists so the product works truthfully with no language model configured.
 * Where a language model is available it phrases the same approved material;
 * this one returns it as written and nothing else. That is a reduced
 * experience, not a dishonest one: the discipline the product sells is that
 * the assistant never states anything it was not given, and a provider that
 * can only quote cannot break it.
 *
 * It is also the honest default for a demonstration. A scripted stub that
 * answers every question with "what are you trying to solve?" demonstrates the
 * opposite of what is being claimed.
 */
export class GroundedModelProvider implements ModelProvider {
  readonly id = 'grounded';

  constructor(
    /** Said when nothing was retrieved. Never a guess at the answer. */
    private readonly noAnswer =
      'I do not have that written down, so I would rather not guess at it. '
      + 'Shall I put you through to someone who can answer properly?',
  ) {}

  async turn(input: ModelTurnInput): Promise<ModelTurnOutput> {
    // First turn: nothing has been retrieved yet, so ask for it. Retrieval
    // runs as a tool so it passes the same policy gate as everything else,
    // which means the model has to request it rather than reach for it.
    if (input.referenceEnvelope === undefined) {
      const canLookUp = input.tools.some((tool) => tool.name === 'knowledge_lookup');
      if (canLookUp) {
        return {
          text: '',
          toolCalls: [{ tool: 'knowledge_lookup', args: { query: input.visitorInput } }],
          // Not an answer yet, and it must not read as one: a confident empty
          // turn would satisfy the escalation check and end the conversation
          // with silence.
          confidence: 0.2,
          sentiment: 'neutral',
          detectedTopics: [],
          tokensUsed: 0,
        };
      }
    }

    const references = parseReferences(input.referenceEnvelope);
    const best = bestFor(input.visitorInput, references);

    if (!best) {
      return {
        text: this.noAnswer,
        toolCalls: [],
        // Low confidence is the escalation signal. Saying "I don't know"
        // confidently would stop the platform offering a person.
        confidence: 0.2,
        sentiment: 'neutral',
        detectedTopics: [],
        tokensUsed: 0,
      };
    }

    return {
      text: best.text,
      toolCalls: [],
      confidence: 0.85,
      sentiment: 'neutral',
      detectedTopics: [best.title],
      tokensUsed: 0,
    };
  }
}

interface Reference {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

/**
 * Reads the reference envelope back into its entries.
 *
 * The envelope is delimited with a per-call random string precisely so that
 * retrieved content cannot forge its own boundary. Parsing takes the first and
 * last lines as the delimiter rather than searching for a known marker, so
 * content that contains something delimiter-shaped changes nothing.
 */
function parseReferences(envelope: string | undefined): Reference[] {
  if (!envelope) return [];
  const lines = envelope.split('\n');
  const delimiter = lines[0]?.trim();
  if (!delimiter) return [];

  const closing = lines.lastIndexOf(delimiter);
  const body = lines.slice(1, closing > 0 ? closing : undefined).join('\n');

  const references: Reference[] = [];
  // Entries look like: [1] id=kc_… title="…"\n<text>
  const pattern = /^\[\d+\] id=(\S+) title=("(?:[^"\\]|\\.)*")$/gm;
  const heads = [...body.matchAll(pattern)];
  for (let index = 0; index < heads.length; index += 1) {
    const head = heads[index]!;
    const start = head.index! + head[0].length;
    const end = index + 1 < heads.length ? heads[index + 1]!.index! : body.length;
    let title = head[2]!;
    try {
      title = JSON.parse(title) as string;
    } catch {
      title = title.replace(/^"|"$/g, '');
    }
    references.push({ id: head[1]!, title, text: body.slice(start, end).trim() });
  }
  return references;
}

const NOISE = new Set([
  'the', 'a', 'an', 'and', 'or', 'is', 'are', 'was', 'to', 'of', 'in', 'on',
  'for', 'with', 'at', 'by', 'from', 'as', 'it', 'this', 'that', 'we', 'our',
  'you', 'your', 'i', 'do', 'does', 'did', 'can', 'could', 'have', 'has', 'be',
  'my', 'me', 'us', 'if', 'not', 'any', 'what', 'how', 'when', 'where', 'why',
  'who', 'will', 'would', 'should', 'there', 'they',
]);

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9£$€%+-]+/)
    .filter((word) => word.length > 1 && !NOISE.has(word));
}

/**
 * The reference that best answers the question.
 *
 * Retrieval has already decided these are relevant and ordered them, so this
 * only picks between them, weighting the title, because a reference's title
 * is the question it answers and matching it is a stronger signal than
 * matching a word buried in its body.
 */
function bestFor(question: string, references: readonly Reference[]): Reference | undefined {
  if (references.length === 0) return undefined;
  const asked = new Set(words(question));
  if (asked.size === 0) return undefined;

  let best: { reference: Reference; score: number } | undefined;
  for (const reference of references) {
    const inTitle = new Set(words(reference.title));
    const inText = new Set(words(reference.text));
    let score = 0;
    for (const word of asked) {
      if (inTitle.has(word)) score += 3;
      else if (inText.has(word)) score += 1;
    }
    if (!best || score > best.score) best = { reference, score };
  }

  // A reference the question shares no word with does not answer it, whatever
  // retrieval's ranking said. Retrieval always returns a best result, and the
  // best result for a question the corpus says nothing about is still a
  // result: "what is the capital of Peru" came back with the setup guide and
  // was read out as though it were the answer. Returning nothing here is what
  // makes the assistant say it does not know, which is the whole promise.
  return best && best.score > 0 ? best.reference : undefined;
}
