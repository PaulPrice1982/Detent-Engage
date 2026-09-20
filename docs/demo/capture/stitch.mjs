/**
 * Stitches the recordings, the slides and the narration into one MP4.
 *
 * Timing is the whole problem. A scene lasts as long as its narration, not as
 * long as its recording: the clips were filmed at the pace somebody uses the
 * product, and the narration over them is longer. So each scene is padded to
 * the length of its audio by holding on the recording's last frame rather
 * than by looping it, because a loop restarts a form that was just submitted
 * and reads as a glitch.
 *
 * Without the narration in audio/, the film is still produced: every scene
 * takes an estimated duration from its word count at a measured reading pace,
 * and the MP4 comes out silent with the captions burned in. Dropping the
 * clips in and running this again is the only step between the two.
 *
 * The manifest names its scenes, its frames directory and its output, so a
 * second scene-based film is a second manifest rather than a second copy of
 * this script.
 *
 *   node docs/demo/capture/stitch.mjs [manifest.json] [--out FILE] [--height 1080]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const DEMO = resolve(here, '..');
const WORK = resolve(DEMO, '.stitch');
const require_ = createRequire(import.meta.url);

/** The static build, because the bundled Playwright encoder has only VP8. */
function findFfmpeg() {
  for (const spec of ['ffmpeg-static', '@ffmpeg-installer/ffmpeg']) {
    try {
      const m = require_(spec);
      const p = typeof m === 'string' ? m : m.path;
      if (p && existsSync(p)) return p;
    } catch { /* try the next one */ }
  }
  if (process.env['FFMPEG']) return process.env['FFMPEG'];
  throw new Error(
    'No ffmpeg with H.264. Run `npm install ffmpeg-static` in this directory, ' +
    'or set FFMPEG to a build that has libx264.',
  );
}

const FFMPEG = findFfmpeg();

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
/** The manifest: the first bare argument, or the C-suite walkthrough. */
const MANIFEST = args.find((a) => a.endsWith('.json')) ?? 'scenes.json';
const film = JSON.parse(readFileSync(resolve(DEMO, MANIFEST), 'utf8'));
/** Named in the manifest so two films cannot overwrite each other's frames. */
const FRAMES = resolve(DEMO, film.frames ?? 'frames');
const OUT = resolve(flag('--out', resolve(DEMO, film.out ?? 'detent-engage-demo.mp4')));
/**
 * Constant rate factor, from the manifest.
 *
 * 21 is the default and is right for an eight-minute film. A fifteen-minute
 * one at the same setting came out at 32 MB, which is over the limit of
 * every channel this gets sent through, and the content is mostly flat
 * slides and a screen recording: exactly what a higher CRF costs nothing on.
 * Named in the manifest rather than guessed here, so the number that
 * produced a file is recorded beside the film that needed it.
 */
const CRF = String(film.crf ?? 21);
const H = Number(flag('--height', '1080'));
const W = Math.round(H * 16 / 9 / 2) * 2;
/** The window the recording plays in, between the title bar and the caption. */
const BAR_TOP = Math.round(H * 96 / 1080);
const BAR_BOTTOM = Math.round(H * 80 / 1080);
const WIN_H = H - BAR_TOP - BAR_BOTTOM;

const run = (list) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...list],
  { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26 });

/**
 * How long a file runs, read from ffmpeg itself.
 *
 * Deliberately not ffprobe: the static ffmpeg build ships without it, and
 * calling a binary that is not there returns zero rather than failing. Zero
 * is the worst possible answer here, because every scene would be cut to its
 * minimum and the film would look deliberate while being wrong.
 */
function duration(file) {
  let text = '';
  try {
    execFileSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    text = String(error.stderr ?? '');
  }
  const m = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
  if (!m) throw new Error(`Could not read the duration of ${file}. Is it a media file?`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const scenes = film.scenes;
const pad2 = (n) => String(n).padStart(2, '0');

/**
 * A measured corporate read is about 150 words a minute. Used only when the
 * narration is not there yet, so the silent cut still has honest pacing.
 */
const WORDS_PER_SECOND = 2.45;

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const segments = [];
let haveAudio = 0;

for (const s of scenes) {
  const n = pad2(s.n);
  const audioFile = s.audio ? resolve(DEMO, s.audio) : '';
  const audioExists = audioFile && existsSync(audioFile);
  if (audioExists) haveAudio += 1;

  const spoken = audioExists
    ? duration(audioFile)
    : s.text.split(/\s+/).filter(Boolean).length / WORDS_PER_SECOND;
  // A beat at each end, so a cut never lands on the first or last syllable.
  const target = Math.max(6, spoken + 1.4);

  const slide = resolve(FRAMES, `slide-${n}.png`);
  const overlay = resolve(FRAMES, `overlay-${n}.png`);
  const clip = s.clip ? resolve(DEMO, s.clip) : '';
  const segment = resolve(WORK, `seg-${n}.mp4`);

  if (clip && existsSync(clip) && existsSync(overlay)) {
    const clipLength = duration(clip);
    // `tpad` holds the final frame rather than looping. A loop would replay a
    // form being submitted, which reads as the recording having broken.
    const hold = Math.max(0, target - clipLength);
    run([
      '-i', clip, '-i', overlay,
      '-filter_complex',
      `[0:v]scale=${W}:${WIN_H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${WIN_H}:(ow-iw)/2:(oh-ih)/2:color=0x050C14,` +
      `tpad=stop_mode=clone:stop_duration=${hold.toFixed(2)},` +
      `pad=${W}:${H}:0:${BAR_TOP}:color=0x0B1622[v];` +
      `[1:v]scale=${W}:${H}[o];[v][o]overlay=0:0,trim=duration=${target.toFixed(2)},` +
      `fps=25,format=yuv420p[out]`,
      '-map', '[out]', '-an',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', CRF,
      '-profile:v', 'high', '-level', '4.1', segment,
    ]);
  } else {
    const still = existsSync(slide) ? slide : resolve(FRAMES, 'card-open.png');
    run([
      '-loop', '1', '-i', still, '-t', target.toFixed(2),
      '-vf', `scale=${W}:${H},fps=25,format=yuv420p`,
      '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', CRF,
      '-profile:v', 'high', '-level', '4.1', segment,
    ]);
  }

  segments.push({ file: segment, audio: audioExists ? audioFile : '', target });
  process.stdout.write(`  scene ${n}  ${target.toFixed(1)}s  ${audioExists ? 'voiced' : 'silent'}\n`);
}

/** Opening and closing cards, which carry no narration of their own. */
const card = (name, seconds) => {
  const file = resolve(WORK, `card-${name}.mp4`);
  // FRAMES, not a hard-coded `frames/`: a second film with its own manifest
  // was silently opening and closing on the first film's cards.
  run(['-loop', '1', '-i', resolve(FRAMES, `card-${name}.png`), '-t', String(seconds),
    '-vf', `scale=${W}:${H},fps=25,format=yuv420p`, '-an',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', CRF,
    '-profile:v', 'high', '-level', '4.1', file]);
  return { file, audio: '', target: seconds };
};

const all = [card('open', 6), ...segments, card('close', 12)];

// --- the video, end to end ------------------------------------------------
const listFile = resolve(WORK, 'segments.txt');
writeFileSync(listFile, all.map((s) => `file '${s.file}'`).join('\n') + '\n');
const silentVideo = resolve(WORK, 'video.mp4');
run(['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', silentVideo]);

// --- the narration, laid against it ---------------------------------------
if (haveAudio === 0) {
  run(['-i', silentVideo, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
    '-shortest', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k',
    '-movflags', '+faststart', OUT]);
  console.log(`\n${OUT}`);
  console.log(`  ${duration(OUT).toFixed(0)}s, silent. No narration in ${resolve(DEMO, 'audio')}.`);
  console.log('  Drop the clips in and run this again; nothing else changes.');
} else {
  // One track, each clip starting where its scene does, so a missing clip
  // leaves silence over its scene rather than shifting every scene after it.
  const inputs = [];
  const filters = [];
  let at = all[0].target;
  let k = 0;
  for (const s of segments) {
    if (s.audio) {
      inputs.push('-i', s.audio);
      filters.push(`[${k + 1}:a]adelay=${Math.round(at * 1000)}|${Math.round(at * 1000)}[a${k}]`);
      k += 1;
    }
    at += s.target;
  }
  /**
   * Stereo and levelled, at the end of the chain.
   *
   * The narration arrives as mono files at whatever level the voice model
   * produced, and amix preserves both. A mono track plays out of one side on
   * some setups, and a film that needs the volume turned up is a film that
   * gets talked over. loudnorm to broadcast-ish -16 LUFS with 1.5 dB of
   * headroom, then two channels.
   */
  const join = filters.length > 1
    ? `${filters.map((_, i) => `[a${i}]`).join('')}amix=inputs=${filters.length}:normalize=0[raw]`
    : `[a0]anull[raw]`;
  /**
   * `apad` at the end, and the output bounded by `-t`.
   *
   * The mixed narration ends on the last word of the last scene, and
   * `-shortest` then cuts the video there. That silently truncated the
   * closing card to about a second: the film ended mid-card, on whichever
   * frame the last syllable happened to land on. Padding the audio past the
   * end of the video lets `-shortest` cut on the video instead, which is the
   * length the film was laid out to be.
   */
  const mixed = `${filters.join(';')};${join};` +
    `[raw]loudnorm=I=-16:TP=-1.5:LRA=11,` +
    `aformat=channel_layouts=stereo:sample_rates=48000,apad[mix]`;
  // Bounded by `-t`, not by `-shortest`: `apad` makes the audio endless and
  // `-shortest` does not reliably stop against a filtered stream with no
  // end. The video's own length is the answer and it is already known.
  const videoSeconds = duration(silentVideo);
  run(['-i', silentVideo, ...inputs, '-filter_complex', mixed,
    '-map', '0:v', '-map', '[mix]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    '-t', videoSeconds.toFixed(2), '-movflags', '+faststart', OUT]);
  console.log(`\n${OUT}`);
  console.log(`  ${duration(OUT).toFixed(0)}s, ${haveAudio} of ${scenes.length} scenes voiced.`);
}

rmSync(WORK, { recursive: true, force: true });
