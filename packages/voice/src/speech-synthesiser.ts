import { AwaError } from '@detent/awa-core';

/**
 * The speech synthesis port: the assistant's mouth, on a turn-shaped surface.
 *
 * Separate from `VoiceProvider`, and the difference is the transport rather
 * than the governance. `VoiceProvider` is a live bidirectional session, which
 * is what telephony and a streaming microphone need. This port is one
 * request and one answer, which is what a browser panel over HTTP needs, and
 * it is the only voice surface this server can actually offer: the HTTP
 * server holds no sockets open.
 *
 * The rule from `voice-provider.ts` is unchanged and is restated here in code
 * rather than in a comment, because a second surface is exactly where a rule
 * gets quietly dropped:
 *
 *   **The synthesiser never decides what to say.**
 *
 * It is handed text that has already come out of the governed turn pipeline
 * and it utters that text. It is given no history, no question and no tools.
 * A synthesiser that could compose would bypass output validation, injection
 * suppression, grounding and the permitted-behaviours gate, all of which live
 * in the gap between a proposed answer and a delivered one.
 */

export interface SpokenAudio {
  readonly audio: Uint8Array;
  /** An IANA media type a browser can play without a codec of ours. */
  readonly mediaType: string;
  /**
   * How long it plays, in milliseconds.
   *
   * Reported by the synthesiser rather than measured here, because voice
   * minutes are billed from it and a duration this code guessed from a byte
   * count is a duration the customer can dispute. A synthesiser that does not
   * know returns the estimate it is willing to stand behind.
   */
  readonly durationMs: number;
  /** The vendor voice that spoke, for the audit record. Cosmetic otherwise. */
  readonly voice: string;
}

export interface SpeechSynthesiser {
  readonly name: string;
  /** Whether this deployment can actually speak. */
  readonly available: boolean;
  /**
   * Utter exactly this text.
   *
   * There is deliberately no second argument carrying context, a persona or a
   * conversation. Everything that decides wording happened upstream.
   */
  speak(text: string): Promise<SpokenAudio>;
}

/**
 * The guard every synthesiser call goes through.
 *
 * `approved` is not decoration. The only caller that may set it true is the
 * one holding a completed orchestrator result, which is the single place in
 * this system where text has been validated. Anything else that reaches for a
 * synthesiser gets an exception rather than a voice.
 */
export function assertApprovedForSpeech(approved: boolean, source: string): void {
  if (approved !== true) {
    throw new Error(
      `Refusing to synthesise speech for "${source}": the text has not been through the `
      + 'governed turn pipeline. Every spoken word is validated text or it is not spoken.',
    );
  }
}

/**
 * What a deployment without a configured voice does.
 *
 * It refuses, and says why, in the operator's words rather than the visitor's.
 * It does not fall back to a silent response that the panel would render as a
 * working voice call with nothing audible in it, which is the failure mode
 * that makes an operator think the browser is broken.
 */
export class VoiceNotConfigured implements SpeechSynthesiser {
  readonly name = 'not-configured';
  readonly available = false;

  async speak(): Promise<SpokenAudio> {
    throw new AwaError({
      kind: 'UPSTREAM_UNAVAILABLE',
      message:
        'No speech synthesiser is configured, so this deployment cannot speak. Set '
        + 'DETENT_VOICE_API_KEY and DETENT_VOICE_ID, or open sessions with modality '
        + '"text". The text route is always available and is never a degraded one.',
      visitorMessage:
        'The spoken assistant is not available here, but you can carry on by typing.',
    });
  }
}
