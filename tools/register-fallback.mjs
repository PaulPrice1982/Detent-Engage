/**
 * Registers both hooks for the dependency-free path: the `vitest` shim and the
 * TypeScript `.js` → `.ts` resolver. Loaded via `--import`.
 */
import { register } from 'node:module';
register('./ts-resolve.mjs', import.meta.url);
register('./vitest-shim.mjs', import.meta.url);
