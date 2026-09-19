/**
 * Every package is in the build, and every module is in its barrel.
 *
 * This is the fault that made the delivered archive look finished and be
 * unbuildable. Nine packages (auth, cms, console, ingestion, payments,
 * persistence, reseller, support, voice) existed, were imported by the server
 * and by the suite, and appeared in no dependency list and no tsconfig
 * reference. Module resolution failed at both type and runtime, twenty-two
 * suites never loaded, and their tests were therefore never counted: the
 * reported total was 587 against a real total of over a thousand. A suite that
 * fails to load is not a failing test, and that is exactly why nobody saw it.
 *
 * Three invariants, each of which was broken:
 *
 *  1. A package that imports another declares it. Otherwise it resolves by
 *     accident through the workspace root and stops resolving the day it is
 *     built alone.
 *  2. A package's tsconfig references every workspace package it depends on,
 *     and the root project references every package. A package absent from the
 *     root is never typechecked at all.
 *  3. A barrel exports every module in its own src. A curated list is a second
 *     source of truth about what a package offers, and the one that is wrong is
 *     always the shorter one.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES = join('packages');
const names = readdirSync(PACKAGES)
  .filter((entry) => existsSync(join(PACKAGES, entry, 'package.json')));

interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifestOf = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(PACKAGES, dir, 'package.json'), 'utf8')) as Manifest;

const nameToDir = new Map(names.map((dir) => [manifestOf(dir).name, dir]));

/** Every module under a package's src, excluding barrels and entry points. */
function modulesOf(dir: string): string[] {
  const src = join(PACKAGES, dir, 'src');
  const found: string[] = [];
  const walk = (at: string, prefix: string): void => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) { walk(full, `${prefix}${entry}/`); continue; }
      if (!entry.endsWith('.ts')) continue;
      const base = entry.slice(0, -3);
      // `main.ts` is an entry point with boot side effects, not API.
      if (prefix === '' && (base === 'index' || base === 'main')) continue;
      found.push(`${prefix}${base}`);
    }
  };
  if (existsSync(src)) walk(src, '');
  return found.sort();
}

/** Imports of other workspace packages, read from the source rather than assumed. */
function workspaceImportsOf(dir: string): string[] {
  const src = join(PACKAGES, dir, 'src');
  if (!existsSync(src)) return [];
  const seen = new Set<string>();
  const walk = (at: string): void => {
    for (const entry of readdirSync(at)) {
      const full = join(at, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!entry.endsWith('.ts')) continue;
      for (const match of readFileSync(full, 'utf8').matchAll(/@detent\/awa-[a-z]+/g)) {
        seen.add(match[0]);
      }
    }
  };
  walk(src);
  return [...seen].filter((name) => nameToDir.has(name)).sort();
}

describe('every package is wired into the build', () => {
  it.each(names)('%s declares every workspace package it imports', (dir) => {
    const manifest = manifestOf(dir);
    const declared = new Set(Object.keys(manifest.dependencies ?? {}));
    const undeclared = workspaceImportsOf(dir)
      .filter((name) => name !== manifest.name && !declared.has(name));
    expect(undeclared, `${dir} imports but does not depend on: ${undeclared.join(', ')}`)
      .toEqual([]);
  });

  it.each(names)('%s references every workspace dependency in its tsconfig', (dir) => {
    const tsconfigPath = join(PACKAGES, dir, 'tsconfig.json');
    if (!existsSync(tsconfigPath)) return;
    const references = new Set(
      ((JSON.parse(readFileSync(tsconfigPath, 'utf8')) as { references?: { path: string }[] })
        .references ?? []).map((reference) => reference.path),
    );
    const manifest = manifestOf(dir);
    const missing = Object.keys(manifest.dependencies ?? {})
      .filter((name) => nameToDir.has(name) && name !== manifest.name)
      .map((name) => `../${nameToDir.get(name)!}`)
      .filter((path) => !references.has(path));
    expect(missing, `${dir} tsconfig is missing references: ${missing.join(', ')}`).toEqual([]);
  });

  it('the root project references every package', () => {
    const references = new Set(
      ((JSON.parse(readFileSync('tsconfig.json', 'utf8')) as { references?: { path: string }[] })
        .references ?? []).map((reference) => reference.path),
    );
    const missing = names
      .filter((dir) => existsSync(join(PACKAGES, dir, 'tsconfig.json')))
      .map((dir) => `packages/${dir}`)
      .filter((path) => !references.has(path));
    expect(missing, `absent from the root project, so never typechecked: ${missing.join(', ')}`)
      .toEqual([]);
  });
});

describe('every barrel exports the package it belongs to', () => {
  /**
   * Packages whose modules are loaded by a browser or by a subpath import
   * rather than through the barrel, listed so that adding a tenth is a
   * decision somebody makes rather than something that happens.
   */
  const NOT_BARRELLED = new Set(['widget', 'connectors', 'groups']);

  it.each(names.filter((dir) => !NOT_BARRELLED.has(dir)))('%s', (dir) => {
    const barrel = join(PACKAGES, dir, 'src', 'index.ts');
    if (!existsSync(barrel)) return;
    const source = readFileSync(barrel, 'utf8');
    const missing = modulesOf(dir).filter((module) => !source.includes(`'./${module}.js'`));
    expect(missing, `${dir}/src/index.ts does not export: ${missing.join(', ')}`).toEqual([]);
  });
});
