/** Starts the API server, preferring tsx and falling back to Node alone. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));
const entry = fileURLToPath(new URL('../packages/server/src/main.ts', import.meta.url));
process.exit(spawnSync(process.execPath, [runner, entry], { stdio: 'inherit' }).status ?? 1);
