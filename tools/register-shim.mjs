/** Registers the `vitest` resolve hook. Loaded via `--import`. */
import { register } from 'node:module';
register('./vitest-shim.mjs', import.meta.url);
