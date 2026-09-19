/**
 * Resolve hook mapping the bare specifier `vitest` onto the local runner.
 *
 * This is what lets every test file keep `import { describe, expect, it } from
 * 'vitest'` unchanged. The tests are identical under both runners, so the
 * fallback proves the same thing the primary runner proves, which is the whole
 * point of having one.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const shim = pathToFileURL(join(here, 'mini-test.ts')).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vitest') {
    return { url: shim, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
