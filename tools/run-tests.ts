/**
 * Fallback test entry point.
 *
 * Discovers `tests/**\/*.test.ts` and runs them through the local runner in
 * `mini-test.ts`. Used by `pnpm test:fallback`, and automatically by
 * `pnpm test` when vitest is not installed.
 */
import { readdir } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { report, runFiles } from './mini-test.js';

async function discover(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await discover(path));
    else if (entry.name.endsWith('.test.ts')) files.push(path);
  }
  return files;
}

const root = resolvePath(process.cwd(), process.argv[2] ?? 'tests');
const files = (await discover(root)).map((path) => pathToFileURL(path).href);

if (files.length === 0) {
  console.error(`No test files found under ${root}`);
  process.exit(1);
}

console.log(`Running ${files.length} test files with the built-in runner (no vitest required)\n`);
const result = await runFiles(files);
report(result);
process.exit(result.failed > 0 ? 1 : 0);
