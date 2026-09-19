/** Registers the TypeScript `.js` → `.ts` resolve hook. Loaded via `--import`. */
import { register } from 'node:module';
register('./ts-resolve.mjs', import.meta.url);
