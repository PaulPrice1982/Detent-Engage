/**
 * Cuts a single-read film: the promotional cut, the partner cut, any other.
 *
 * Different from stitch.mjs in the one way that matters: a walkthrough gives
 * each scene its own narration and lets the scene last as long as that
 * narration does. A single-read cut has one continuous read, and the pictures
 * are cut to it. So the beats are laid out at their authored lengths, then
 * scaled together to land exactly on the end of the voice.
 *
 * The manifest names its own frames directory and output files, so a second
 * film is a second manifest rather than a second copy of this script.
 *
 *   node docs/demo/capture/promo.mjs [manifest.json]
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const DEMO = resolve(here, '..');
const WORK = resolve(DEMO, '.promo');
const require_ = createRequire(import.meta.url);

function findFfmpeg() {
  for (const spec of ['ffmpeg-static', '@ffmpeg-installer/ffmpeg']) {
    try {
      const m = require_(spec);
      const p = typeof m === 'string' ? m : m.path;
      if (p && existsSync(p)) return p;
    } catch { /* next */ }
  }
  if (process.env['FFMPEG']) return process.env['FFMPEG'];
  throw new Error('No ffmpeg with H.264. `npm install ffmpeg-static` in this directory.');
}
const FFMPEG = findFfmpeg();
const run = (a) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...a],
  { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 26 });

/** Read from ffmpeg, because the static build ships no ffprobe. */
function duration(file) {
  let text = '';
  try { execFileSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { text = String(e.stderr ?? ''); }
  const m = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
  if (!m) throw new Error(`Could not read the duration of ${file}.`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const W = 1920, H = 1080;
const MANIFEST = process.argv[2] ?? 'promo.json';
const promo = JSON.parse(readFileSync(resolve(DEMO, MANIFEST), 'utf8'));
// Named in the manifest so two films cannot overwrite each other's frames.
const FRAMES = resolve(DEMO, promo.frames ?? 'frames/promo');
const voice = resolve(DEMO, promo.audio);
const hasVoice = existsSync(voice);

const authored = promo.beats.reduce((n, b) => n + b.seconds, 0);
// The read is the clock. Everything else stretches or shrinks onto it, so a
// re-recorded line never leaves the pictures running past the last word.
const target = hasVoice ? duration(voice) + 0.9 : authored;
const scale = target / authored;
if (!hasVoice) console.log(`No ${promo.audio}; cutting silent at the authored length.`);

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

const segments = [];
promo.beats.forEach((beat, i) => {
  const n = String(i).padStart(2, '0');
  const seconds = (beat.seconds * scale).toFixed(2);
  const frame = resolve(FRAMES, `beat-${n}.png`);
  const out = resolve(WORK, `beat-${n}.mp4`);
  const still = beat.shot ?? beat.slide;

  if (beat.clip) {
    const clip = resolve(DEMO, beat.clip);
    const have = duration(clip);
    if ((beat.from ?? 0) >= have) {
      throw new Error(
        `Beat ${n} starts at ${beat.from}s of ${beat.clip}, which runs ${have.toFixed(1)}s. ` +
        'A cue past the end yields an empty beat and the film ends before the narration does.',
      );
    }
    // `from` picks the moment worth showing; a promotional beat has no time
    // to wait for a page to settle.
    const filters =
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0B1622,` +
      `tpad=stop_mode=clone:stop_duration=${seconds},trim=duration=${seconds},fps=25[v]`;
    run(['-ss', String(beat.from ?? 0), '-i', clip, '-i', frame,
      '-filter_complex', `${filters};[1:v]scale=${W}:${H}[o];[v][o]overlay=0:0,format=yuv420p[out]`,
      '-map', '[out]', '-an', '-t', seconds,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', out]);
  } else if (still) {
    const src = resolve(DEMO, still);
    run(['-loop', '1', '-i', src, '-i', frame,
      '-filter_complex',
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0B1622,fps=25[v];` +
      `[1:v]scale=${W}:${H}[o];[v][o]overlay=0:0,format=yuv420p[out]`,
      '-map', '[out]', '-an', '-t', seconds,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', out]);
  } else {
    run(['-loop', '1', '-i', frame, '-t', seconds,
      '-vf', `scale=${W}:${H},fps=25,format=yuv420p`, '-an',
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', out]);
  }
  segments.push(out);
  process.stdout.write(`  beat ${n}  ${seconds}s\n`);
});

const list = resolve(WORK, 'beats.txt');
writeFileSync(list, segments.map((f) => `file '${f}'`).join('\n') + '\n');
const silent = resolve(WORK, 'video.mp4');
run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);

const OUT = resolve(DEMO, promo.out ?? 'detent-engage-promo.mp4');
if (hasVoice) {
  /**
   * Padded to the video, and bounded by `-t` rather than by `-shortest`.
   *
   * Two faults, one after the other. Without a pad, the read ends before
   * the pictures do and `-shortest` cuts the film on the last word, losing
   * the beat of air the beats were laid out with. With a bare `apad`, the
   * audio never ends, and `-shortest` does not reliably terminate against a
   * filtered stream that has no end: the encode ran for two hours on a
   * fifty-eight second film before it was killed.
   *
   * So: pad, and state the length. `-t` is the one instruction ffmpeg
   * cannot misread.
   */
  const silentSeconds = duration(silent);
  run(['-i', silent, '-i', voice,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,'
      + 'aformat=channel_layouts=stereo:sample_rates=48000,apad',
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
    '-t', silentSeconds.toFixed(2), '-movflags', '+faststart', OUT]);
} else {
  run(['-i', silent, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', OUT]);
}

console.log(`\n${OUT}\n  ${duration(OUT).toFixed(1)}s`);

// A vertical version for a feed, from the same cut rather than a second edit.
//
// Fitted and padded, never centre-cropped. A 9:16 crop of a 16:9 frame keeps
// the middle 607 pixels, and the cards set their type left-aligned across the
// full width: the crop took the first and last word off every headline. A
// letterboxed band is less dramatic and is the whole sentence.
if (promo.vertical) {
  const VERT = resolve(DEMO, promo.vertical);
  run(['-i', OUT, '-vf',
    'scale=1080:1920:force_original_aspect_ratio=decrease,' +
    'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x0B1622',
    '-c:a', 'copy',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-movflags', '+faststart', VERT]);
  console.log(`${VERT}\n  1080x1920, for a feed`);
}
rmSync(WORK, { recursive: true, force: true });
