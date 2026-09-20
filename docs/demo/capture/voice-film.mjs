/**
 * Cuts the film of the assistant speaking.
 *
 * Its own script rather than another manifest for promo.mjs, because it is a
 * different shape: the promotional and partner cuts have one continuous read
 * with pictures cut to it, and this one has to go quiet in the middle and let
 * the product talk. Bending the single-read assembler to leave a hole in its
 * own narration would make both harder to read.
 *
 * The middle is not a re-enactment. It is the take from voice.cjs, and the
 * soundtrack is assembled from the same recordings the panel fetched and
 * played, laid at the moments the panel played them. Those moments come from
 * the cue sheet the take wrote, so the mix cannot drift from the picture:
 * change the pacing and the cues change with it.
 *
 *   node docs/demo/capture/voice-film.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const DEMO = resolve(here, '..');
const WORK = resolve(DEMO, '.voice');
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

/** From ffmpeg, because the static build ships no ffprobe. */
function duration(file) {
  let text = '';
  try { execFileSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { text = String(e.stderr ?? ''); }
  const m = /Duration:\s*(\d+):(\d\d):(\d\d(?:\.\d+)?)/.exec(text);
  if (!m) throw new Error(`Could not read the duration of ${file}.`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

const W = 1920, H = 1080;
const VOICE_DIR = resolve(DEMO, 'audio/voice');
const cues = JSON.parse(readFileSync(resolve(DEMO, 'voice-cues.json'), 'utf8'));
const clip = resolve(DEMO, cues.clip);
const clipSeconds = duration(clip);

/**
 * Which recording each spoken moment was.
 *
 * The cue sheet records how long each utterance ran but not which file it
 * was, so the file is found by its own recorded length. Every line in this
 * conversation is a different length, and an ambiguity throws rather than
 * picking one: a mix that plays the wrong answer under the right picture is
 * worse than no mix at all.
 */
const byDuration = new Map();
for (const key of readFileSync(resolve(VOICE_DIR, 'index.txt'), 'utf8').trim().split('\n')) {
  const ms = Number(readFileSync(resolve(VOICE_DIR, `${key}.mp3.ms`), 'utf8').trim());
  if (byDuration.has(ms)) {
    throw new Error(`Two recordings are both ${ms}ms long, so a cue cannot be resolved by length.`);
  }
  byDuration.set(ms, resolve(VOICE_DIR, `${key}.mp3`));
}

/** Every utterance in the take: what plays, and when it starts. */
const utterances = [];
let visitorIndex = 0;
for (const mark of cues.marks) {
  if (mark.what === 'visitor starts') {
    const line = cues.said[visitorIndex];
    visitorIndex += 1;
    if (!line) throw new Error('The take heard more from the visitor than the cue sheet holds.');
    utterances.push({ file: resolve(DEMO, line.file), atMs: mark.at, who: 'visitor' });
  }
  if (mark.what === 'reply playing') {
    const file = byDuration.get(mark.ms);
    if (!file) throw new Error(`No recording is ${mark.ms}ms long, so this reply cannot be laid.`);
    utterances.push({ file, atMs: mark.at, who: 'assistant' });
  }
}
// The disclosure is the first thing spoken and is the one utterance the
// panel plays before any turn, so it is cued off the arming of the
// microphone rather than off a reply.
const armed = cues.marks.find((m) => m.what === 'speech starts');
if (!armed) throw new Error('The take never played the disclosure, so it is not a voice take.');
utterances.unshift({
  file: byDuration.get(7198) ?? resolve(VOICE_DIR, 'disclosure.mp3'),
  atMs: armed.at, who: 'assistant',
});

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });

// --- the conversation's soundtrack, laid on the take's own clock ----------
const inputs = utterances.flatMap((u) => ['-i', u.file]);
// Each utterance is levelled before it is laid, not after the mix.
// The three voices come from three separate generations and sat about six
// decibels apart: normalising only the finished track keeps that gap, and a
// visitor who is audibly quieter than the assistant reads as a recording of
// somebody on speakerphone rather than as a conversation.
const LEVEL = 'loudnorm=I=-16:TP=-1.5:LRA=11';
const delays = utterances
  .map((u, i) => `[${i}:a]${LEVEL},adelay=${u.atMs}|${u.atMs}[u${i}]`)
  .join(';');
const mixIn = utterances.map((_, i) => `[u${i}]`).join('');
const scene = resolve(WORK, 'scene.mp3');
run([...inputs, '-filter_complex',
  `${delays};${mixIn}amix=inputs=${utterances.length}:dropout_transition=0:normalize=0,`
  + `apad,atrim=0:${clipSeconds.toFixed(2)},`
  + 'aformat=channel_layouts=stereo:sample_rates=48000[out]',
  '-map', '[out]', '-c:a', 'libmp3lame', '-q:a', '2', scene]);

// --- the three pieces -----------------------------------------------------
/**
 * One piece: a picture and the audio that runs under it.
 *
 * `-vf` is an output option and lands on whichever file follows it, so the
 * filter is given as a `-filter_complex` instead. Written out because the
 * first version put `-vf` between the two inputs and ffmpeg applied it to the
 * mp3, which fails with a message about input and output options that does
 * not mention the filter at all.
 */
const piece = (name, videoInput, filter, audio, seconds) => {
  const out = resolve(WORK, `${name}.mp4`);
  run([...videoInput, '-i', audio,
    '-filter_complex', `[0:v]${filter}[v];[1:a]${LEVEL}[a]`,
    '-map', '[v]', '-map', '[a]', '-t', seconds.toFixed(2),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2',
    '-pix_fmt', 'yuv420p', out]);
  return out;
};

const intro = resolve(DEMO, 'audio/voice-intro.mp3');
const outro = resolve(DEMO, 'audio/voice-outro.mp3');
for (const file of [intro, outro]) {
  if (!existsSync(file)) throw new Error(`Missing narration: ${file}`);
}
const introSeconds = duration(intro) + 0.6;
const outroSeconds = duration(outro) + 0.9;

const FIT = `scale=${W}:${H}:force_original_aspect_ratio=decrease,`
  + `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x0B1622,fps=25,format=yuv420p`;

const pieces = [
  piece('01-open', ['-loop', '1', '-i', resolve(DEMO, 'frames/voice/open.png')],
    `scale=${W}:${H},fps=25,format=yuv420p`, intro, introSeconds),
  piece('02-talk', ['-i', clip], FIT, scene, clipSeconds),
  piece('03-close', ['-loop', '1', '-i', resolve(DEMO, 'frames/voice/close.png')],
    `scale=${W}:${H},fps=25,format=yuv420p`, outro, outroSeconds),
];

const list = resolve(WORK, 'pieces.txt');
writeFileSync(list, `${pieces.map((f) => `file '${f}'`).join('\n')}\n`);
const OUT = resolve(DEMO, 'detent-engage-voice.mp4');
run(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', OUT]);

console.log(`\n${OUT}\n  ${duration(OUT).toFixed(1)}s`);
for (const u of utterances) {
  console.log(`  ${String(u.atMs).padStart(6)}ms  ${u.who.padEnd(9)} ${u.file.split('/').pop()}`);
}
rmSync(WORK, { recursive: true, force: true });
