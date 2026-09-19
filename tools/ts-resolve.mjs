/**
 * Resolve hook for running this workspace with no build step and, if need be,
 * with nothing installed at all.
 *
 * It does two things Node does not do on its own:
 *
 *   1. maps TypeScript ESM `./foo.js` specifiers onto the `./foo.ts` on disk.
 *      TypeScript requires the emitted extension in the specifier; bundlers and
 *      tsx remap it, Node's own type stripping does not;
 *   2. maps `@detent/awa-<name>` onto `packages/<name>/src/index.ts`, which is
 *      what pnpm's workspace symlinks would otherwise provide.
 *
 * Together those mean Node 22 runs the entire product from a bare checkout with
 * **no npm dependencies and no install**. That is not a party trick: this
 * platform's argument is that its controls are demonstrable, and a control you
 * cannot run because a registry refused a tarball is not demonstrable.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKSPACE_PREFIX = '@detent/awa-';

export async function resolve(specifier, context, nextResolve) {
  // 1. Workspace packages, resolved from source.
  if (specifier.startsWith(WORKSPACE_PREFIX)) {
    const name = specifier.slice(WORKSPACE_PREFIX.length);
    // Reject anything that could climb out of packages/. A specifier is
    // attacker-influenced in principle, and a resolve hook is a poor place to
    // learn that lesson.
    if (/^[a-z0-9-]+$/.test(name)) {
      const entry = join(repoRoot, 'packages', name, 'src', 'index.ts');
      if (existsSync(entry)) {
        return { url: pathToFileURL(entry).href, format: 'module-typescript', shortCircuit: true };
      }
    }
  }

  // 2. TypeScript ESM's `.js` specifier pointing at a `.ts` file.
  const relative = specifier.startsWith('./') || specifier.startsWith('../');
  if (relative && specifier.endsWith('.js')) {
    try {
      const resolved = await nextResolve(specifier.slice(0, -3) + '.ts', context);
      if (resolved?.url?.startsWith('file:') && existsSync(fileURLToPath(resolved.url))) {
        return { ...resolved, format: 'module-typescript', shortCircuit: true };
      }
    } catch {
      // No sibling .ts. Fall through, which is correct for a genuine .js file.
    }
  }

  return nextResolve(specifier, context);
}
