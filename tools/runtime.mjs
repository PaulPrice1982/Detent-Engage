/**
 * Works out how to run TypeScript on *this* machine, by testing rather than
 * assuming.
 *
 * Three strategies, best first. Each is probed with a throwaway process before
 * it is trusted, because the failure modes are silent and fatal: an unsupported
 * `--experimental-*` flag makes Node exit immediately with "bad option", which
 * a host reports only as "the app is not running".
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const local = (name) => fileURLToPath(new URL(name, import.meta.url));

/** Node accepted the flags and ran a trivial program. */
function flagsWork(flags) {
  const probe = spawnSync(process.execPath, [...flags, '-e', 'process.exit(0)'], {
    stdio: 'ignore',
    timeout: 20_000,
  });
  return probe.status === 0;
}

function tsxPath() {
  try {
    return require.resolve('tsx');
  } catch {
    return undefined;
  }
}

/**
 * Returns the Node arguments that will run `entry`, or throws with an
 * actionable message if nothing on this machine can.
 */
export function runtimeArgs(entry, rest = [], { register = 'register-ts.mjs' } = {}) {
  const tsx = tsxPath();
  if (tsx) return ['--import', tsx, entry, ...rest];

  // Node 22.6+ transforms TypeScript itself. This handles parameter properties
  // (`constructor(private readonly x)`), which this codebase uses throughout;
  // --experimental-strip-types does not, so it is not an acceptable substitute.
  const transform = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning'];
  if (flagsWork(transform)) {
    return [...transform, '--import', local(register), entry, ...rest];
  }

  throw new Error(
    [
      'Cannot run TypeScript on this machine.',
      '',
      `  Node version:            ${process.version}`,
      '  tsx installed:           no',
      '  --experimental-transform-types supported: no (needs Node 22.6 or later)',
      '',
      'Fix either one:',
      '  1. Install dependencies so tsx is available:  pnpm install',
      '  2. Or upgrade Node to 22.6 or later.',
      '',
      'On Replit, set modules = ["nodejs-22"] in .replit and restart the repl.',
    ].join('\n'),
  );
}

/** Spawns `entry`, inheriting stdio. Returns the child's exit code. */
export function runTypeScript(entry, rest = [], options = {}) {
  let args;
  try {
    args = runtimeArgs(entry, rest, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  return spawnSync(process.execPath, args, { stdio: 'inherit' }).status ?? 1;
}
