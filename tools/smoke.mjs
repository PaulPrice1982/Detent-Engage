#!/usr/bin/env node
/**
 * The runtime gate, as a command that cannot be mangled.
 *
 * The verification step was a multi-line curl with header arguments and quoted
 * JSON. Pasted into a shell it twice arrived malformed: once losing its line
 * continuations, once carrying a stray carriage return that the HTTP parser
 * refused with HPE_LF_EXPECTED. Both times a working release was reported as
 * broken, and both times the fault was the command rather than the server.
 *
 * So the request is made from here instead. No shell quoting, no headers to
 * retype, no line endings to mangle.
 *
 *   node tools/smoke.mjs                     # reads PORT, or 8787
 *   node tools/smoke.mjs --port 8787 --key awa_pub_...
 *
 * With no key it checks the pages and says the session check was skipped,
 * rather than failing over something it was not given. Exit 0 if everything it
 * could check passed, 1 otherwise.
 */
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
};

const port = Number(arg('port', process.env['PORT'] ?? '8787'));
const host = arg('host', '127.0.0.1');
const base = `http://${host}:${port}`;
const key = arg('key', process.env['AWA_WIDGET_KEY'] ?? '');
const origin = arg('origin', (process.env['AWA_ORIGINS'] ?? `http://localhost:${port}`).split(',')[0].trim());

let failed = 0;
let skipped = 0;
const pass = (what, detail = '') => console.log(`  PASS  ${what}${detail ? `  ${detail}` : ''}`);
const fail = (what, detail) => { failed += 1; console.log(`  FAIL  ${what}  ${detail}`); };
const skip = (what, why) => { skipped += 1; console.log(`  SKIP  ${what}  ${why}`); };

async function page(path) {
  try {
    const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 200) pass(path);
    else fail(path, `expected 200, got ${response.status}`);
  } catch (error) {
    fail(path, error instanceof Error ? error.message : String(error));
  }
}

console.log(`Checking ${base}`);
console.log('');
console.log('Pages');
for (const path of [
  '/', '/console/signin', '/app/signin', '/reseller/signin',
  '/console.html', '/trust.html', '/widget/panel.html',
]) {
  await page(path);
}

console.log('');
console.log('Session API');
if (!key) {
  skip('POST /v1/sessions', 'no widget key given. Pass --key, or set AWA_DEV_PRINT_KEYS=1 and read it from the boot output.');
} else {
  try {
    const response = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key.trim()}`,
        origin,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ jurisdiction: 'UK' }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }

    if (response.status === 201 && parsed?.session_id) {
      pass('POST /v1/sessions', `201, session ${String(parsed.session_id).slice(0, 16)}...`);
    } else if (parsed?.error === 'MALFORMED_REQUEST') {
      // Unreachable from here, which is the point: this path builds the
      // request itself. If it ever appears, the fault is upstream of the app.
      fail('POST /v1/sessions', `the parser refused a request this script built: ${parsed.code}`);
    } else if (response.status === 403) {
      fail('POST /v1/sessions', `403. The key or the origin was refused. Origin sent was "${origin}"; `
        + 'it must be one of AWA_ORIGINS, and the key must be the awa_pub_ one.');
    } else {
      fail('POST /v1/sessions', `expected 201, got ${response.status}: ${text.slice(0, 160)}`);
    }
  } catch (error) {
    fail('POST /v1/sessions', error instanceof Error ? error.message : String(error));
  }
}

console.log('');
if (failed > 0) {
  console.log(`${failed} check(s) failed.`);
  process.exit(1);
}
console.log(skipped > 0 ? `All checks passed, ${skipped} skipped.` : 'All checks passed.');
