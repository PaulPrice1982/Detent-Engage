import { AwaError } from '@detent/awa-core';
import type { SpeechSynthesiser, SpokenAudio } from './speech-synthesiser.js';

/**
 * An ElevenLabs adapter for the speech synthesis port.
 *
 * Why this vendor, when `openai-realtime.ts` sits next to it: the realtime
 * adapter needs a socket the HTTP server does not hold open, and it bills a
 * live session. This one is a request and a reply, which is the shape a
 * browser panel over HTTP can actually use, and it is what makes a spoken
 * assistant demonstrable today rather than after a transport rewrite.
 *
 * On the voice itself, two constraints that pull against each other and the
 * order they were resolved in.
 *
 * It must be **English**. This product is sold to British companies and it
 * speaks to their visitors; an American assistant on a Midlands haulier's
 * website is the first thing a caller notices and the last thing anyone
 * intended to say about the brand.
 *
 * It must be in the **register of the OpenAI Realtime assistant voices**:
 * clear, warm, unhurried, no performance. Those are what this
 * product expects to run on in production and
 * `GOVERNED_SESSION_DEFAULTS.voice` is already `alloy`. A vendor voice with a
 * distinctive character would make the eventual switch sound like a different
 * assistant, and customers notice that far more than they notice the vendor.
 *
 * So: that register, in an English accent. It is also deliberately not the
 * narrator's voice and not the visitor's in the demonstration films, because
 * three parties in one conversation need three voices a listener can tell
 * apart without being told.
 *
 * Nothing about governance changes here. This class is handed validated text
 * and it utters it. It is given no history, no question and no tools.
 */

/** Ophelia, Clear British Customer Support. English, in the OpenAI register. */
export const DEFAULT_VOICE_ID = 'YCMgeo2Dvws6xwm7kQNN';

/** Multilingual, because a tenant's locale list is not a promise about English. */
export const DEFAULT_MODEL_ID = 'eleven_multilingual_v2';

const ENDPOINT = 'https://api.elevenlabs.io/v1/text-to-speech';

/**
 * The longest utterance that will be synthesised.
 *
 * A governed reply is already bounded, but this is the last gate before an
 * outbound call is billed per character, and a bound enforced here cannot be
 * lifted by a tenant's configuration. Roughly ninety seconds of speech.
 */
export const MAX_SPOKEN_CHARS = 1_800;

export interface ElevenLabsSpeechOptions {
  /** From the environment. Never logged, never written to an audit payload. */
  readonly apiKey: string;
  readonly voiceId?: string;
  readonly modelId?: string;
  /** Injected in tests. Defaults to the global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

interface TimestampedResponse {
  readonly audio_base64?: string;
  readonly alignment?: { readonly character_end_times_seconds?: readonly number[] };
}

export class ElevenLabsSpeech implements SpeechSynthesiser {
  readonly name = 'elevenlabs';
  readonly available = true;
  readonly voiceId: string;

  private readonly apiKey: string;
  private readonly modelId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: ElevenLabsSpeechOptions) {
    if (options.apiKey.trim().length === 0) {
      throw new Error('ElevenLabsSpeech needs an API key. Construct VoiceNotConfigured instead.');
    }
    this.apiKey = options.apiKey;
    this.voiceId = options.voiceId?.trim() || DEFAULT_VOICE_ID;
    this.modelId = options.modelId?.trim() || DEFAULT_MODEL_ID;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async speak(text: string): Promise<SpokenAudio> {
    const words = text.trim();
    if (words.length === 0) {
      throw new Error('Refusing to synthesise an empty utterance.');
    }
    if (words.length > MAX_SPOKEN_CHARS) {
      throw new AwaError({
        kind: 'SCHEMA_INVALID',
        message:
          `A spoken reply of ${words.length} characters exceeds the ${MAX_SPOKEN_CHARS} `
          + 'character limit. Shorten the reply rather than raising the limit: this bound '
          + 'is what stops one turn billing a minute of synthesis.',
      });
    }

    // The timestamped endpoint, not the plain one, because it returns the
    // alignment and therefore the exact playing time. Voice minutes are billed
    // from that number, and a duration inferred from an mp3 byte count is a
    // duration the customer is entitled to dispute.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${ENDPOINT}/${encodeURIComponent(this.voiceId)}/with-timestamps`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': this.apiKey,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            text: words,
            model_id: this.modelId,
            output_format: 'mp3_44100_128',
          }),
          signal: controller.signal,
        },
      );
    } catch (cause) {
      throw new AwaError({
        kind: 'UPSTREAM_UNAVAILABLE',
        // The vendor's own message, never the key, and never the request body:
        // the body is the visitor-facing answer and belongs in the transcript
        // rather than in an error a log aggregator will keep.
        message: `The speech vendor did not answer: ${describe(cause)}`,
        visitorMessage: 'The spoken reply did not arrive. The text is on screen.',
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new AwaError({
        kind: response.status === 401 || response.status === 403
          ? 'POLICY_DENIED' : 'UPSTREAM_UNAVAILABLE',
        message: `The speech vendor refused the request with ${response.status}.`,
        visitorMessage: 'The spoken reply did not arrive. The text is on screen.',
      });
    }

    const payload = await response.json() as TimestampedResponse;
    const encoded = payload.audio_base64;
    if (typeof encoded !== 'string' || encoded.length === 0) {
      throw new AwaError({
        kind: 'UPSTREAM_UNAVAILABLE',
        message: 'The speech vendor returned no audio.',
        visitorMessage: 'The spoken reply did not arrive. The text is on screen.',
      });
    }

    const ends = payload.alignment?.character_end_times_seconds ?? [];
    const lastEnd = ends.length > 0 ? ends[ends.length - 1] ?? 0 : 0;
    return {
      audio: Uint8Array.from(Buffer.from(encoded, 'base64')),
      mediaType: 'audio/mpeg',
      // Fall back to a reading-speed estimate only when the vendor sent no
      // alignment, and round up: a part second of speech is a part minute of
      // billing either way, and under-reporting is the error that costs us.
      durationMs: lastEnd > 0 ? Math.round(lastEnd * 1000) : estimateMs(words),
      voice: this.voiceId,
    };
  }
}

/** Roughly 150 words a minute, which is a measured conversational pace. */
function estimateMs(text: string): number {
  const words = text.split(/\s+/u).filter(Boolean).length;
  return Math.max(1_000, Math.ceil((words / 150) * 60_000));
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.name === 'AbortError' ? 'it timed out' : cause.message;
  }
  return 'an unknown transport failure';
}
