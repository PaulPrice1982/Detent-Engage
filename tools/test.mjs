/**
 * Test entry point, with three runners in order of preference.
 *
 *   1. vitest, where it is installed;
 *   2. the built-in runner under tsx;
 *   3. the built-in runner under Node's own TypeScript transform, which needs
 *      no npm dependencies at all.
 *
 * The ladder exists because a locked-down registry blocking one package must
 * not make the suite unrunnable. A test suite that cannot run in a restricted
 * environment stops being evidence exactly where evidence matters most, and
 * this product's entire argument is that its controls are demonstrable.
 *
 * All three run the same test files, unmodified.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const local = (name) => fileURLToPath(new URL(name, import.meta.url));

function resolveOptional(specifier) {
  try {
    return require.resolve(specifier);
  } catch {
    return undefined;
  }
}

const run = (nodeArgs) =>
  spawnSync(process.execPath, nodeArgs, { stdio: 'inherit' }).status ?? 1;

const vitest = resolveOptional('vitest/vitest.mjs');
if (vitest) {
  process.exit(run([vitest, 'run', ...args]));
}

const tsx = resolveOptional('tsx');
if (tsx) {
  console.log('vitest is not installed; using the built-in runner under tsx.\n');
  process.exit(run(['--import', tsx, '--import', local('register-shim.mjs'), local('run-tests.ts'), ...args]));
}

// Nothing installed at all. Node 22 can still do this on its own.
console.log('Neither vitest nor tsx is installed; using the built-in runner on Node alone.\n');
process.exit(run([
  '--experimental-transform-types',
  '--disable-warning=ExperimentalWarning',
  '--import', local('register-fallback.mjs'),
  local('run-tests.ts'),
  ...args,
]));
