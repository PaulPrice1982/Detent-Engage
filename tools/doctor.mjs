/**
 * Preflight check. Prints what this machine can and cannot do, and exits
 * non-zero if the app cannot start.
 *
 * Exists because every startup failure so far has been environmental, not a
 * code fault, and has surfaced to the operator only as "the app is not
 * running", a message that names no cause. This names the cause.
 *
 *   node tools/doctor.mjs
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runtimeArgs } from './runtime.mjs';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));
const rows = [];
let fatal = false;

/**
 * `required` distinguishes a real failure from an absent optional. Labelling an
 * optional as FAIL is worse than saying nothing: it sends the reader chasing a
 * healthy row while the actual fault sits further down the list.
 */
const check = (label, ok, detail, required = false) => {
  rows.push({ label, ok, detail, required });
  if (!ok && required) fatal = true;
};

// Node version. 22.6 is the floor for --experimental-transform-types, which is
// the fallback when tsx is unavailable.
const [major = 0, minor = 0] = process.version.replace(/^v/, '').split('.').map(Number);
const modernNode = major > 22 || (major === 22 && minor >= 6);
check('Node', major >= 20, process.version, true);
check('Node has built-in TypeScript', modernNode,
  modernNode ? 'yes (22.6+)' : `no, ${process.version} is below 22.6`);

// tsx is the preferred runner but must never be required.
let tsx = false;
try { require.resolve('tsx'); tsx = true; } catch { /* optional */ }
check('tsx installed', tsx, tsx ? 'yes' : 'no (optional)');

check('node_modules present', existsSync(new URL('../node_modules', import.meta.url)),
  'optional, the app runs without it');

// The only thing that actually matters: can we run TypeScript at all?
let canRun = true;
let runDetail = '';
try {
  const args = runtimeArgs('packages/server/src/main.ts');
  runDetail = args[0] === '--import' ? 'via tsx' : 'via Node built-in transform';
} catch (error) {
  canRun = false;
  runDetail = error instanceof Error ? error.message.split('\n')[0] : String(error);
}
check('Can run TypeScript', canRun, runDetail, true);

// A package manager is a convenience here, not a requirement.
const pm = ['pnpm', 'npm'].find((name) =>
  spawnSync(name, ['--version'], { stdio: 'ignore', shell: true, timeout: 20_000 }).status === 0);
check('Package manager', Boolean(pm), pm ?? 'none found (not required to run)');

// Static assets the status page needs.
check('Status page present', existsSync(new URL('../packages/server/public/index.html', import.meta.url)), '/');
check('Widget assets present', existsSync(new URL('../packages/widget/public/panel.html', import.meta.url)), '/widget');

const port = process.env['PORT'] ?? '8787';
const host = process.env['HOST'] ?? '0.0.0.0';
check('Bind address', host === '0.0.0.0', `${host}:${port}`);

/** Can we actually bind the port, or is something already holding it? */
const portFree = await new Promise((done) => {
  const probe = createServer();
  probe.once('error', () => done(false));
  probe.once('listening', () => probe.close(() => done(true)));
  probe.listen(Number(port), host);
});

/** If the port is taken, is the occupant this app, or a stale process? */
let occupant = '';
if (!portFree) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const body = await response.json().catch(() => ({}));
    occupant = body && body.status
      ? 'an instance of this app is already running and answering'
      : 'something else is listening';
  } catch {
    occupant = 'something is listening but not answering /health, probably a stale process';
  }
}

// A port already held is the single most common reason a start fails, and the
// error Node raises for it (an unhandled EADDRINUSE 'error' event) is a stack
// trace, not an explanation. Catch it here, before the server is even asked to
// start, and say what to do about it.
check(`Port ${port} available`, portFree, portFree ? 'yes' : occupant, true);

const width = Math.max(...rows.map((row) => row.label.length));
console.log(`\nDetent Agentic Website Assistant, preflight\n${'-'.repeat(width + 30)}`);
for (const row of rows) {
  const status = row.ok ? 'ok  ' : row.required ? 'FAIL' : '--  ';
  console.log(`${status}  ${row.label.padEnd(width)}  ${row.detail}`);
}
console.log(`${'-'.repeat(width + 30)}`);
console.log(`root: ${root}`);

if (fatal) {
  console.error('\nThe app cannot start. Fix the FAIL rows above. Rows marked -- are optional.');
  if (!portFree) {
    console.error(
      [
        '',
        `Port ${port} is already held, so a new server cannot bind to it.`,
        'This is almost always a previous run that did not shut down. Free it with:',
        '',
        `  npx --yes kill-port ${port}     # or:`,
        `  pkill -f 'packages/server/src/main.ts'`,
        '',
        'Then start again. To run alongside the existing process instead, pick',
        `another port:  PORT=8788 node tools/serve.mjs`,
      ].join('\n'),
    );
  }
  process.exit(1);
}
if (host !== '0.0.0.0') {
  console.error(`\nHOST is ${host}. A preview proxy cannot reach a loopback bind; use 0.0.0.0.`);
  process.exit(1);
}
console.log('\nReady. Start with:  node tools/serve.mjs\n');
