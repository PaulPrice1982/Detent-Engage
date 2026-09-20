/**
 * Films the spoken assistant.
 *
 * The panel is the shipping one, the server is the running build, the audio
 * is the product's own synthesised reply fetched over HTTP, and the pacing is
 * whatever the real recordings take to play. Two things are supplied by this
 * script because a headless container has neither:
 *
 *   1. A microphone. There is no person and no sound card, so the browser's
 *      speech recogniser is stubbed and fed the visitor's lines as
 *      transcripts. That is exactly what the recogniser would hand the panel
 *      after hearing them, and it is the same substitution the rest of the
 *      capture makes for the cursor: the person is simulated, the product is
 *      not.
 *   2. A soundtrack. A recorded page has no audio track, so this writes a
 *      cue sheet of what was spoken and when, and the mix is laid on in post
 *      from the same files the panel played.
 *
 *   node docs/demo/capture/voice.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CHROME = process.env.CHROME
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const BASE = process.env.BASE || 'http://127.0.0.1:8901';
const OUT = path.resolve(__dirname, '../clips');
const SIZE = { width: 1920, height: 904 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The visitor's side, as the recogniser would hand it over, with the
 * recording of each line and how long it runs.
 *
 * The take is paced to these: the panel is given a transcript only once the
 * visitor's recording would have finished, so in the finished film the two
 * people take turns rather than talking over each other. Written by
 * docs/demo/capture/README.md's one-off step and read, never guessed.
 */
const SAID = require('../audio/voice/visitor.json');

/**
 * A recogniser that hears what it is told to hear.
 *
 * Installed before the panel's script runs, so the panel picks it up exactly
 * as it would the browser's own. It implements only what the panel uses;
 * anything the panel started relying on beyond this would fail loudly here
 * rather than quietly in a visitor's browser.
 */
const RECOGNISER = () => {
  const listeners = new Map();
  class FakeRecognition {
    constructor() {
      this.lang = 'en-GB';
      this.interimResults = false;
      this.continuous = false;
      window.__recogniser = this;
    }
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    }
    start() { this.running = true; window.__mark('microphone armed'); }
    stop() { this.running = false; }
    /** Called from the capture script, never by the panel. */
    __hear(text) {
      const result = [{ transcript: text }];
      result.length = 1;
      const event = { resultIndex: 0, results: [result] };
      for (const handler of listeners.get('result') ?? []) handler(event);
    }
  }
  window.SpeechRecognition = FakeRecognition;

  // One clock for the whole take, so the cue sheet and the video agree.
  const t0 = performance.now();
  window.__marks = [];
  window.__mark = (what, extra) => {
    window.__marks.push({ at: Math.round(performance.now() - t0), what, ...extra });
  };

  // Every utterance the panel plays, timed. Wrapping Audio rather than
  // inspecting the network, because what matters for the mix is the moment
  // playback started and the moment it ended, which only the element knows.
  const NativeAudio = window.Audio;
  window.Audio = function (src) {
    const element = new NativeAudio(src);
    element.addEventListener('play', () => window.__mark('speech starts'));
    element.addEventListener('ended', () => window.__mark('speech ends'));
    return element;
  };
};

/** Content-addressed, exactly as the server addresses the same recording. */
const keyFor = (text) => crypto.createHash('sha256')
  .update(String(text).trim().replace(/\s+/gu, ' ')).digest('hex').slice(0, 16);

const VOICE_DIR = path.resolve(__dirname, '../audio/voice');

/**
 * How long a line plays.
 *
 * Throws rather than guessing. A guess here desynchronises the mix from the
 * picture by a second or two, which reads as a badly dubbed film and is the
 * single thing most likely to make a viewer stop believing the demonstration.
 */
function playsFor(text) {
  const sidecar = path.join(VOICE_DIR, `${keyFor(text)}.mp3.ms`);
  if (!fs.existsSync(sidecar)) {
    throw new Error(
      `No recording for a line the panel just rendered, so the take cannot be timed:\n  ${text}`,
    );
  }
  return Number(fs.readFileSync(sidecar, 'utf8').trim());
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const widgetKey = fs.readFileSync(path.join(__dirname, 'wk.txt'), 'utf8').trim();
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });

  const dir = path.join(OUT, '.raw', '12-voice');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ viewport: SIZE, recordVideo: { dir, size: SIZE } });
  await ctx.addInitScript(RECOGNISER);
  const page = await ctx.newPage();

  const panel = `/widget/panel.html?key=${encodeURIComponent(widgetKey)}`
    + `&api=${encodeURIComponent(BASE)}&jurisdiction=UK`;
  await page.goto(`${BASE}${panel}`, { waitUntil: 'networkidle' });
  await sleep(1600);

  const mic = page.locator('#mic');
  if (await mic.count() === 0 || await mic.isHidden()) {
    throw new Error(
      'The panel is not offering a microphone. Boot with AWA_FEATURE_SPOKEN_VOICE=1 '
      + 'and a synthesiser, or this films a text conversation and calls it voice.',
    );
  }

  await page.evaluate(() => window.__mark('microphone pressed'));
  await mic.click();
  await page.waitForFunction(
    () => (document.getElementById('disclosure')?.textContent ?? '').includes('speaking with'),
    undefined, { timeout: 15_000 },
  );
  const disclosureText = await page.locator('#disclosure').innerText();

  // The disclosure plays before the panel arms capture. Waiting for the
  // button rather than for a fixed delay, because the whole claim being
  // filmed is that the order is enforced and not merely usual.
  await page.waitForFunction(
    () => document.getElementById('mic')?.getAttribute('aria-pressed') === 'true',
    undefined, { timeout: 30_000 },
  );

  // A headless container has no audio sink, so `ended` never fires however
  // long you wait for it: the first take ran three minutes, almost all of it
  // silence. The pacing therefore comes from how long each recording actually
  // plays, which is the number the product itself reports and bills on, read
  // from the sidecar written when the line was synthesised.
  await sleep(playsFor(disclosureText) + 500);

  let answered = 0;
  for (const line of SAID) {
    // The visitor is speaking for this long. Marked at the start so the mix
    // can lay their recording over exactly the silence left for it.
    await page.evaluate((ms) => window.__mark('visitor starts', { ms }), line.durationMs);
    await sleep(line.durationMs + 500);
    await page.evaluate((text) => {
      window.__mark('visitor speaks', { text });
      window.__recogniser.__hear(text);
    }, line.text);

    answered += 1;
    await page.waitForFunction(
      (count) => document.querySelectorAll('.turn.assistant').length >= count,
      answered, { timeout: 30_000 },
    );
    // The first span is the message. The second is the "Assistant · 11:26"
    // stamp, and including it changes the hash and loses the recording.
    const reply = await page.locator('.turn.assistant').nth(answered - 1)
      .locator('span').first().innerText();
    const spoken = playsFor(reply);
    await page.evaluate((ms) => window.__mark('reply playing', { ms }), spoken);
    await sleep(spoken + 400);
  }

  await sleep(1200);
  const marks = await page.evaluate(() => window.__marks);
  await page.close();
  await ctx.close();
  await browser.close();

  const file = fs.readdirSync(dir).find((f) => f.endsWith('.webm'));
  if (!file) throw new Error('no video was recorded');
  fs.renameSync(path.join(dir, file), path.join(OUT, '12-voice.webm'));

  // The cue sheet. Each spoken moment gets the file that was played, found
  // the same way the server finds it, so the mix cannot drift from the take.
  fs.writeFileSync(
    path.resolve(__dirname, '../voice-cues.json'),
    `${JSON.stringify({ clip: 'clips/12-voice.webm', said: SAID.map((one) => ({ ...one, key: keyFor(one.text) })), marks }, null, 2)}\n`,
  );

  console.log(`  12-voice.webm  ${Math.round(fs.statSync(path.join(OUT, '12-voice.webm')).size / 1024)} KB`);
  for (const mark of marks) console.log(`  ${String(mark.at).padStart(6)}ms  ${mark.what}`);
})();
