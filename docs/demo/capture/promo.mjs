/**
 * Cuts the promotional film.
 *
 * Different from stitch.mjs in the one way that matters: a walkthrough gives
 * each scene its own narration and lets the scene last as long as that
 * narration does. A promotional cut has a single continuous read, and the
 * pictures are cut to it. So the beats are laid out at their authored
 * lengths, then scaled together to land exactly on the end of the voice.
 *
 *   node docs/demo/capture/promo.mjs
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
const promo = JSON.parse(readFileSync(resolve(DEMO, 'promo.json'), 'utf8'));
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
  const frame = resolve(DEMO, `frames/promo/beat-${n}.png`);
  const out = resolve(WORK, `beat-${n}.mp4`);
  const still = beat.shot ?? beat.slide;

  if (beat.clip) {
    const clip = resolve(DEMO, beat.clip);
    // `from` picks the moment worth showing; a promotional beat has no time
    // to wait for a page to settle.
    const filters =
      `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},` +
      `tpad=stop_mode=clone:stop_duration=${seconds},trim=duration=${seconds},fps=25[v]`;
    run(['-ss', String(beat.from ?? 0), '-i', clip, '-i', frame,
      '-filter_complex', `${filters};[1:v]scale=${W}:${H}[o];[v][o]overlay=0:0,format=yuv420p[out]`,
      '-map', '[out]', '-an', '-t', seconds,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', out]);
  } else if (still) {
    // A slow push on a still, so a static frame does not read as a freeze.
    const src = resolve(DEMO, still);
    const zoom = `zoompan=z='min(zoom+0.0006,1.09)':d=${Math.round(Number(seconds) * 25)}:` +
      `x='iw/2-(iw/zoom/2)':y='${beat.focus === 'bottom' ? 'ih-(ih/zoom)' : 'ih/2-(ih/zoom/2)'}':s=${W}x${H}:fps=25`;
    run(['-loop', '1', '-i', src, '-i', frame,
      '-filter_complex',
      `[0:v]scale=${W * 1.06}:-2,crop=${W}:${H}:(iw-${W})/2:${beat.focus === 'bottom' ? `ih-${H}` : `(ih-${H})/2`},${zoom}[v];` +
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

const OUT = resolve(DEMO, 'detent-engage-promo.mp4');
if (hasVoice) {
  run(['-i', silent, '-i', voice,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aformat=channel_layouts=stereo:sample_rates=48000',
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
    '-shortest', '-movflags', '+faststart', OUT]);
} else {
  run(['-i', silent, '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-shortest',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', OUT]);
}

// A vertical crop for a feed, from the same cut rather than a second edit.
const VERT = resolve(DEMO, 'detent-engage-promo-vertical.mp4');
run(['-i', OUT, '-vf', 'crop=ih*9/16:ih,scale=1080:1920', '-c:a', 'copy',
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '21', '-movflags', '+faststart', VERT]);

console.log(`\n${OUT}\n  ${duration(OUT).toFixed(1)}s`);
console.log(`${VERT}\n  1080x1920, for a feed`);
rmSync(WORK, { recursive: true, force: true });
