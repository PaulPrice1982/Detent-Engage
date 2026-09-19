/**
 * Run a TypeScript entry point with whatever is available: tsx where it is
 * installed, Node's own TypeScript transform where it is not.
 *
 * Used by the demo and serve scripts so neither depends on a package a
 * registry might refuse to serve.
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const local = (name) => fileURLToPath(new URL(name, import.meta.url));
const [entry, ...rest] = process.argv.slice(2);

if (!entry) {
  console.error('Usage: node tools/run.mjs <entry.ts> [args…]');
  process.exit(1);
}

let tsx;
try { tsx = require.resolve('tsx'); } catch { /* fall through to Node */ }

const nodeArgs = tsx
  ? ['--import', tsx, entry, ...rest]
  : ['--experimental-transform-types', '--disable-warning=ExperimentalWarning',
     '--import', local('register-ts.mjs'), entry, ...rest];

process.exit(spawnSync(process.execPath, nodeArgs, { stdio: 'inherit' }).status ?? 1);
