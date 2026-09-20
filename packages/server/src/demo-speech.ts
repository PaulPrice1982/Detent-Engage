import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SpeechSynthesiser, SpokenAudio } from '@detent/awa-voice';

/**
 * The demonstration's voice: real vendor audio, fetched in advance.
 *
 * Exactly the same arrangement as `ScriptedModelProvider`, and for the same
 * reason. A demonstration recorded without a vendor key is not a
 * demonstration of a broken product; it is a demonstration of a product
 * nobody paid the vendor for that afternoon. So the words the scripted
 * assistant says are synthesised once, by the configured voice, and served
 * from disk.
 *
 * What this changes about the demonstration, precisely: when the audio was
 * fetched. Everything else is the product. The disclosure gate, the governed
 * pipeline, `assertApprovedForSpeech`, the metering, the audit entries and
 * the panel are all the shipping ones, and the bytes are what the vendor
 * returned for those words in that voice.
 *
 * Refused in a deployment, in `main.ts`, beside the scripted model provider.
 * A deployment sets `DETENT_VOICE_API_KEY` and speaks live.
 *
 * A line with no recording throws and names the text. Falling back to silence
 * would make a changed script look like a working assistant that had stopped
 * talking, which is the hardest kind of demonstration failure to diagnose and
 * the easiest to ship.
 */
export class DemoSpeech implements SpeechSynthesiser {
  readonly name = 'demo-cache';
  readonly available = true;

  constructor(private readonly directory: string) {}

  /** The filename for a line. Content-addressed, so the script owns the map. */
  static keyFor(text: string): string {
    return createHash('sha256').update(normalise(text)).digest('hex').slice(0, 16);
  }

  static has(directory: string, text: string): boolean {
    return existsSync(resolve(directory, `${DemoSpeech.keyFor(text)}.mp3`));
  }

  async speak(text: string): Promise<SpokenAudio> {
    const key = DemoSpeech.keyFor(text);
    const path = resolve(this.directory, `${key}.mp3`);
    if (!existsSync(path)) {
      throw new Error(
        `No recording for this line, so the demonstration would have gone silent:\n  ${text}\n`
        + `Expected ${key}.mp3 in ${this.directory}. Regenerate with `
        + 'docs/demo/capture/voice-lines.mjs after changing the script.',
      );
    }
    const audio = await readFile(path);
    return {
      audio: Uint8Array.from(audio),
      mediaType: 'audio/mpeg',
      durationMs: await durationOf(path, audio),
      voice: 'demo-cache',
    };
  }
}

/** Whitespace and case only. The words have to match; the typography need not. */
function normalise(text: string): string {
  return text.trim().replace(/\s+/gu, ' ');
}

/**
 * How long the file plays, read from the recording rather than guessed.
 *
 * Written beside each mp3 when it was generated, because the alignment the
 * vendor returned is exact and parsing an mp3's frame headers here to
 * rediscover it would be a worse answer and more code. Voice minutes are
 * billed from this number in the demonstration exactly as they are in a
 * deployment, so it has to be the real one.
 */
async function durationOf(path: string, audio: Buffer): Promise<number> {
  const sidecar = `${path}.ms`;
  if (existsSync(sidecar)) {
    const value = Number((await readFile(sidecar, 'utf8')).trim());
    if (Number.isFinite(value) && value > 0) return Math.round(value);
  }
  // 128 kbit/s constant rate, which is what the generator asks the vendor for.
  return Math.max(1_000, Math.round((audio.byteLength * 8) / 128));
}
