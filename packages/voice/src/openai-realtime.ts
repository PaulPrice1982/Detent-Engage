import {
  assertGoverned, type RealtimeSessionConfig, type VoiceEventHandler,
  type VoiceProvider, type VoiceSession,
} from './voice-provider.js';

/**
 * OpenAI Realtime adapter.
 *
 * Realtime is used here as transport, transcription and speech, not as the
 * answering model. `create_response: false` is the single setting that makes
 * this possible: voice activity detection still fires, so barge-in works, but
 * the model never replies of its own accord. Every utterance is inserted as a
 * pre-written assistant message and spoken.
 *
 * **For the developer wiring this to the live API:** every wire-level name and
 * payload shape is in `WIRE` below, in one block, deliberately. The Realtime
 * API's event schema has changed shape more than once (session fields moved
 * under `audio.input` / `audio.output`; `modalities` became `output_modalities`).
 * Check `WIRE` against the current reference and change it there; nothing
 * outside this file knows these names. The governed behaviour above this
 * adapter is covered by tests using a fake provider, so a wire change cannot
 * silently alter what the assistant is allowed to say.
 */

export const OPENAI_REALTIME_URL = 'wss://api.openai.com/v1/realtime';
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime';

/**
 * The wire protocol, in one place. Verify against the current API reference.
 */
export const WIRE = {
  client: {
    sessionUpdate: 'session.update',
    audioAppend: 'input_audio_buffer.append',
    audioCommit: 'input_audio_buffer.commit',
    audioClear: 'input_audio_buffer.clear',
    itemCreate: 'conversation.item.create',
    responseCreate: 'response.create',
    responseCancel: 'response.cancel',
  },
  server: {
    sessionCreated: 'session.created',
    sessionUpdated: 'session.updated',
    speechStarted: 'input_audio_buffer.speech_started',
    speechStopped: 'input_audio_buffer.speech_stopped',
    transcriptCompleted: 'conversation.item.input_audio_transcription.completed',
    transcriptFailed: 'conversation.item.input_audio_transcription.failed',
    audioDelta: 'response.output_audio.delta',
    audioDone: 'response.output_audio.done',
    responseDone: 'response.done',
    error: 'error',
  },
} as const;

/** Minimal socket contract, so this is testable without a network. */
export interface RealtimeSocket {
  send(data: string): void;
  close(): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  onError(handler: (error: Error) => void): void;
  readonly open: boolean;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => Promise<RealtimeSocket>;

export interface OpenAiRealtimeOptions {
  readonly apiKey: string;
  readonly model?: string;
  readonly url?: string;
  readonly socketFactory: SocketFactory;
  /** Instructions given to the model. Deliberately about *speech*, not content. */
  readonly speechInstructions?: string;
}

/**
 * What the model is told.
 *
 * Note that it contains no product knowledge, no persona and no selling
 * guidance. Those live in the governed pipeline, which composes the words. This
 * text exists only to stop the model improvising around the text it is given , 
 * the failure mode being a model that "helpfully" adds a sentence nobody
 * validated.
 */
export const VERBATIM_SPEECH_INSTRUCTIONS =
  'You are a text-to-speech voice. Speak the assistant message exactly as written, ' +
  'naturally and at a normal pace. Do not add, remove, summarise, translate or ' +
  'rephrase any words. Do not answer questions. Do not continue past the text given.';

export class OpenAiRealtimeProvider implements VoiceProvider {
  readonly name = 'openai_realtime';

  constructor(private readonly options: OpenAiRealtimeOptions) {}

  async open(config: RealtimeSessionConfig, onEvent: VoiceEventHandler): Promise<VoiceSession> {
    assertGoverned(config);

    const model = this.options.model ?? DEFAULT_REALTIME_MODEL;
    const url = `${this.options.url ?? OPENAI_REALTIME_URL}?model=${encodeURIComponent(model)}`;
    const socket = await this.options.socketFactory(url, {
      // The key is passed to the transport and never enters a prompt, a log or
      // an audit payload.
      authorization: `Bearer ${this.options.apiKey}`,
      'openai-beta': 'realtime=v1',
    });

    const session = new OpenAiRealtimeSession(socket, config, onEvent,
      this.options.speechInstructions ?? VERBATIM_SPEECH_INSTRUCTIONS);
    await session.configure();
    return session;
  }
}

class OpenAiRealtimeSession implements VoiceSession {
  readonly id = `voice_${Math.random().toString(36).slice(2, 12)}`;
  private isClosed = false;

  constructor(
    private readonly socket: RealtimeSocket,
    private readonly config: RealtimeSessionConfig,
    private readonly onEvent: VoiceEventHandler,
    private readonly speechInstructions: string,
  ) {
    socket.onMessage((data) => { void this.receive(data); });
    socket.onClose((reason) => {
      this.isClosed = true;
      void this.onEvent({ type: 'closed', reason });
    });
    socket.onError((error) => {
      void this.onEvent({ type: 'error', code: 'SOCKET', message: error.message });
    });
  }

  get closed(): boolean {
    return this.isClosed || !this.socket.open;
  }

  /**
   * Configures the session so the model cannot answer for itself.
   *
   * `create_response: false` with `interrupt_response: true` is the exact
   * combination wanted: the model never starts a reply on its own, but the
   * caller speaking still cuts off whatever is being spoken.
   */
  async configure(): Promise<void> {
    this.send({
      type: WIRE.client.sessionUpdate,
      session: {
        type: 'realtime',
        instructions: this.speechInstructions,
        audio: {
          input: {
            format: this.formatFor(this.config.inputFormat),
            transcription: this.config.language
              ? { model: 'gpt-4o-transcribe', language: this.config.language }
              : { model: 'gpt-4o-transcribe' },
            turn_detection: this.config.detectTurns
              ? {
                  type: 'server_vad',
                  silence_duration_ms: this.config.endOfTurnSilenceMs,
                  // The governance setting. Detection still fires, so barge-in
                  // works; the model never replies unprompted.
                  create_response: false,
                  interrupt_response: true,
                }
              : null,
          },
          output: {
            format: this.formatFor(this.config.outputFormat),
            voice: this.config.voice,
          },
        },
      },
    });
    await this.onEvent({ type: 'ready' });
  }

  private formatFor(format: { encoding: string; sampleRateHz: number }): Record<string, unknown> {
    return format.encoding === 'pcm16'
      ? { type: 'audio/pcm', rate: format.sampleRateHz }
      : { type: `audio/${format.encoding.replace('_', '-')}` };
  }

  async sendAudio(chunk: Uint8Array): Promise<void> {
    if (this.closed) return;
    this.send({ type: WIRE.client.audioAppend, audio: base64(chunk) });
  }

  /**
   * Speaks exactly the text given.
   *
   * The text is inserted as an assistant message and then rendered to audio.
   * The model is not asked a question and is given nothing to reason about: it
   * is reading out a line that the governed pipeline has already validated.
   */
  async speak(text: string): Promise<void> {
    if (this.closed || text.trim().length === 0) return;
    this.send({
      type: WIRE.client.itemCreate,
      item: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    });
    this.send({
      type: WIRE.client.responseCreate,
      response: {
        output_modalities: ['audio'],
        instructions: this.speechInstructions,
      },
    });
  }

  async cancelSpeech(): Promise<void> {
    if (this.closed) return;
    this.send({ type: WIRE.client.responseCancel });
  }

  /**
   * Puts a caller utterance into provider context without triggering a reply.
   *
   * Used when a turn was answered from the pipeline and the provider's own
   * conversation state would otherwise drift out of step with what was said.
   */
  async noteCallerUtterance(text: string): Promise<void> {
    if (this.closed) return;
    this.send({
      type: WIRE.client.itemCreate,
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
  }

  async close(reason: string): Promise<void> {
    if (this.isClosed) return;
    this.isClosed = true;
    this.socket.close();
    await this.onEvent({ type: 'closed', reason });
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket.open) return;
    this.socket.send(JSON.stringify(payload));
  }

  /** Translates provider events into the port's vocabulary. */
  private async receive(data: string): Promise<void> {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data) as Record<string, unknown>;
    } catch {
      await this.onEvent({ type: 'error', code: 'BAD_FRAME', message: 'Unparseable frame.' });
      return;
    }
    const type = typeof message['type'] === 'string' ? message['type'] : '';

    switch (type) {
      case WIRE.server.speechStarted:
        await this.onEvent({ type: 'speech_started' });
        return;
      case WIRE.server.speechStopped:
        await this.onEvent({ type: 'speech_stopped' });
        return;
      case WIRE.server.transcriptCompleted: {
        const text = typeof message['transcript'] === 'string' ? message['transcript'] : '';
        const itemId = typeof message['item_id'] === 'string' ? message['item_id'] : '';
        // An empty transcript is silence, not an utterance. Answering it makes
        // the assistant talk to itself.
        if (text.trim().length > 0) await this.onEvent({ type: 'transcript', text, itemId });
        return;
      }
      case WIRE.server.transcriptFailed: {
        const itemId = typeof message['item_id'] === 'string' ? message['item_id'] : '';
        await this.onEvent({ type: 'transcript_failed', reason: 'transcription_failed', itemId });
        return;
      }
      case WIRE.server.audioDelta: {
        const delta = typeof message['delta'] === 'string' ? message['delta'] : '';
        if (delta) await this.onEvent({ type: 'audio', chunk: fromBase64(delta) });
        return;
      }
      case WIRE.server.audioDone:
        await this.onEvent({ type: 'audio_done' });
        return;
      case WIRE.server.responseDone:
        return;
      case WIRE.server.error: {
        const error = (message['error'] ?? {}) as Record<string, unknown>;
        await this.onEvent({
          type: 'error',
          code: typeof error['code'] === 'string' ? error['code'] : 'PROVIDER',
          message: typeof error['message'] === 'string' ? error['message'] : 'Provider error.',
        });
        return;
      }
      default:
        return;
    }
  }
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
