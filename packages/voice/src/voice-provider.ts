/**
 * The voice provider port.
 *
 * Voice is bought, not built, but it is bought behind an interface, for the
 * same reason the CRM connectors are. A realtime speech vendor is the fastest
 * moving part of this system and the one most likely to be replaced, repriced
 * or made unavailable in a jurisdiction. Nothing above this line knows which
 * vendor is in use.
 *
 * The critical design rule, and the reason this port looks the way it does:
 *
 *   **The provider never decides what to say.**
 *
 * It hears audio and produces a transcript; it is given text and produces
 * speech. The words in between come from the governed turn pipeline. A provider
 * capable of speech-to-speech is configured so that it cannot answer on its own
 *, see `RealtimeSessionConfig.autoRespond`, which exists only so it can be
 * asserted false.
 */

export type AudioEncoding = 'pcm16' | 'g711_ulaw' | 'g711_alaw';

export interface AudioFormat {
  readonly encoding: AudioEncoding;
  readonly sampleRateHz: number;
}

export const DEFAULT_AUDIO_FORMAT: AudioFormat = { encoding: 'pcm16', sampleRateHz: 24_000 };

/** Telephony formats are 8kHz; browsers are 24kHz. */
export const TELEPHONY_AUDIO_FORMAT: AudioFormat = { encoding: 'g711_ulaw', sampleRateHz: 8_000 };

export interface RealtimeSessionConfig {
  /** Vendor voice identifier. Cosmetic; no governance meaning. */
  readonly voice: string;
  readonly inputFormat: AudioFormat;
  readonly outputFormat: AudioFormat;
  /**
   * Whether the provider may generate a reply of its own accord.
   *
   * **Always false in this system.** It exists as a field so that it is
   * explicit, assertable and visible in an audit record, rather than being an
   * implicit property of how the adapter happens to be configured. A provider
   * that answers on its own has bypassed output validation, injection
   * suppression, grounding checks and the permitted-behaviours gate: every
   * safety control lives in the gap between a proposed answer and a spoken one.
   */
  readonly autoRespond: false;
  /** Detect speech start and end, for barge-in. Detection only, never reply. */
  readonly detectTurns: boolean;
  /**
   * Silence in milliseconds that ends a caller's turn. Longer is more patient
   * and feels slower; shorter interrupts people who pause to think.
   */
  readonly endOfTurnSilenceMs: number;
  /** Language hint for transcription, as a BCP 47 tag. */
  readonly language?: string;
}

export const GOVERNED_SESSION_DEFAULTS: RealtimeSessionConfig = {
  voice: 'alloy',
  inputFormat: DEFAULT_AUDIO_FORMAT,
  outputFormat: DEFAULT_AUDIO_FORMAT,
  autoRespond: false,
  detectTurns: true,
  endOfTurnSilenceMs: 600,
};

/** What the provider tells us. Nothing here is trusted; a transcript is input. */
export type VoiceEvent =
  | { readonly type: 'ready' }
  /** The caller started speaking. The cue to stop talking over them. */
  | { readonly type: 'speech_started' }
  | { readonly type: 'speech_stopped' }
  /** A complete caller utterance, transcribed. Untrusted, exactly like typed text. */
  | { readonly type: 'transcript'; readonly text: string; readonly itemId: string }
  | { readonly type: 'transcript_failed'; readonly reason: string; readonly itemId: string }
  /** A chunk of synthesised audio to play. */
  | { readonly type: 'audio'; readonly chunk: Uint8Array }
  /** Synthesis of the current utterance finished. */
  | { readonly type: 'audio_done' }
  | { readonly type: 'error'; readonly code: string; readonly message: string }
  | { readonly type: 'closed'; readonly reason: string };

export type VoiceEventHandler = (event: VoiceEvent) => void | Promise<void>;

/**
 * A live voice session with the provider.
 *
 * Note what is absent: there is no `respond()` that hands the provider a
 * question. There is only `speak(text)`, which utters words already decided.
 */
export interface VoiceSession {
  readonly id: string;
  /** Push caller audio to the provider. */
  sendAudio(chunk: Uint8Array): Promise<void>;
  /** Speak exactly this text. The provider composes nothing. */
  speak(text: string): Promise<void>;
  /** Stop speaking immediately. Used for barge-in. */
  cancelSpeech(): Promise<void>;
  /** Record a caller utterance in provider context without answering it. */
  noteCallerUtterance(text: string): Promise<void>;
  close(reason: string): Promise<void>;
  readonly closed: boolean;
}

export interface VoiceProvider {
  readonly name: string;
  open(config: RealtimeSessionConfig, onEvent: VoiceEventHandler): Promise<VoiceSession>;
}

/**
 * Guard applied before a session opens.
 *
 * Placed in the port rather than the adapter so that a future provider cannot
 * be added that quietly permits autonomous replies. It is one line of code and
 * it is the whole safety argument for using a speech-to-speech vendor at all.
 */
export function assertGoverned(config: RealtimeSessionConfig): void {
  if (config.autoRespond !== false) {
    throw new Error(
      'Refusing to open a voice session that lets the provider answer on its own. ' +
      'Every spoken word must come from the governed turn pipeline.',
    );
  }
}
