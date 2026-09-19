import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * No em dashes, anywhere a person reads.
 *
 * A house style rule rather than a technical one, and enforced here because a
 * style rule nobody checks lasts exactly as long as the person who remembers
 * it. Replacing one with a hyphen is not the fix: an em dash usually wants a
 * comma, a colon or a full stop, and a hyphen in its place leaves a sentence
 * that reads as though something went wrong in a text editor.
 *
 * It walks a fixed list of directories rather than asking git what is tracked.
 * `git ls-files` describes the folder the code happens to be sitting in, which
 * on a hosting platform includes that platform's own files and every archive
 * anybody has ever uploaded next to it. This test failed a correct build twice
 * on files the release does not own, which is a worse fault than the one it
 * exists to catch: a gate that stops good releases gets switched off, and then
 * it is catching nothing.
 */

/** Directories this release owns. Anything else is somebody else's. */
const ROOTS = ['packages', 'tools', 'tests', 'db'];

/** Shipped documents at the root. Listed rather than globbed, for the same reason. */
const ROOT_FILES = ['CLAUDE.md', 'REPLIT-PROMPT.md', 'README.md'];

const EXTENSIONS = [
  '.ts', '.tsx', '.md', '.html', '.sql', '.css', '.svg',
  // Shipped to a browser or run by an operator, and therefore read by people.
  // Leaving these out is how five dashes sat in the widget for three releases.
  '.js', '.mjs', '.cjs',
];

/** Never walked: generated output, dependencies, and anything not ours. */
const SKIP_DIRECTORIES = new Set([
  'node_modules', 'dist', '.git', 'dist-zip', 'coverage',
  // A hosting platform's own files, and the archives it keeps beside them.
  'attached_assets', '.agents', '.replit', '.cache', '.config', '.upm',
]);

/**
 * The one file allowed to contain them, and why.
 *
 * The extraction regex matches a price range as a visitor typed it, and people
 * type ranges with whichever dash their keyboard produced. Dropping the em
 * dash there would stop a range written with one being read as a range at all,
 * which is a behaviour change dressed as a style fix.
 */
const ALLOWED = new Set([join('packages', 'onboarding', 'src', 'extraction.ts')]);

/**
 * Built from its code point rather than typed.
 *
 * A test that searches for a character would otherwise contain one, and would
 * have to exempt itself. One exemption in the rule is a decision; two is the
 * start of a list.
 */
const EM_DASH = String.fromCharCode(0x2014);

/**
 * Every way a dash reaches a reader.
 *
 * The first version of this test looked for one literal character, and 31
 * dashes went straight past it in three disguises: a JavaScript escape, an HTML
 * entity, and a numeric character reference. Twenty-three of them were in the
 * marketing copy, so the site carried dashes on every page while a green test
 * said there were none.
 *
 * A gate that checks the shape of a thing rather than the thing itself is worse
 * than no gate, because it is believed. Every pattern here is assembled from
 * code points at run time, so this file never contains what it searches for and
 * never has to exempt itself.
 */
const DASH_CHARACTERS: ReadonlyArray<readonly [string, string]> = [
  [String.fromCharCode(0x2014), 'em dash'],
  [String.fromCharCode(0x2013), 'en dash'],
  [String.fromCharCode(0x2012), 'figure dash'],
  [String.fromCharCode(0x2015), 'horizontal bar'],
  [String.fromCharCode(0x2212), 'minus sign'],
];

const BACKSLASH = String.fromCharCode(92);
const AMPERSAND = String.fromCharCode(38);
const HASH = String.fromCharCode(35);
const SEMICOLON = String.fromCharCode(59);

/** The same characters written as escapes and entities, which render the same. */
const DASH_SPELLINGS: ReadonlyArray<readonly [string, string]> = [
  [`${BACKSLASH}u2014`, 'an escaped em dash'],
  [`${BACKSLASH}u2013`, 'an escaped en dash'],
  [`${BACKSLASH}u2212`, 'an escaped minus sign'],
  [`${AMPERSAND}mdash${SEMICOLON}`, 'an em dash entity'],
  [`${AMPERSAND}ndash${SEMICOLON}`, 'an en dash entity'],
  [`${AMPERSAND}${HASH}8212${SEMICOLON}`, 'a numeric em dash'],
  [`${AMPERSAND}${HASH}8211${SEMICOLON}`, 'a numeric en dash'],
  [`${AMPERSAND}${HASH}x2014${SEMICOLON}`, 'a hex em dash'],
  [`${AMPERSAND}${HASH}x2013${SEMICOLON}`, 'a hex en dash'],
];

function walk(directory: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return found; // A root that does not exist in this checkout is not a failure.
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue; // A link to nowhere is not this test's business.
    }
    if (stats.isDirectory()) walk(full, found);
    else if (EXTENSIONS.some((extension) => entry.endsWith(extension))) found.push(full);
  }
  return found;
}

function ownedFiles(): string[] {
  const files = ROOTS.flatMap((root) => walk(root));
  for (const name of ROOT_FILES) {
    try {
      statSync(name);
      files.push(name);
    } catch {
      // Not every checkout has every document.
    }
  }
  return files.map((file) => relative('.', file));
}

describe('house style', () => {
  it('has no dash in anything this release ships, bar the one that is code', () => {
    const offenders: string[] = [];
    for (const file of ownedFiles()) {
      if (ALLOWED.has(file.split('/').join(sep))) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const [dash, name] of DASH_CHARACTERS) {
          if (line.includes(dash)) offenders.push(`${file}:${index + 1} ${name}`);
        }
      });
    }
    expect(
      offenders,
      `Dashes in files this release owns:\n${offenders.slice(0, 10).join('\n')}`,
    ).toEqual([]);
  });

  it('finds a dash written as an escape or an entity, which renders identically', () => {
    const offenders: string[] = [];
    for (const file of ownedFiles()) {
      if (ALLOWED.has(file.split('/').join(sep))) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        for (const [spelling, name] of DASH_SPELLINGS) {
          if (line.includes(spelling)) offenders.push(`${file}:${index + 1} ${name}`);
        }
      });
    }
    expect(
      offenders,
      `Dashes written as escapes or entities:\n${offenders.slice(0, 12).join('\n')}`,
    ).toEqual([]);
  });

  it('reads the files a browser is actually sent', () => {
    // The widget and the console ship plain JavaScript, and it was outside the
    // extension list while carrying eight dashes.
    const files = ownedFiles();
    expect(files.some((file) => file.endsWith('launcher.js'))).toBe(true);
    expect(files.some((file) => file.endsWith('.mjs'))).toBe(true);
  });

  it('looks at the source and not at whatever else shares the folder', () => {
    const files = ownedFiles();
    expect(files.length).toBeGreaterThan(50);
    // The faults that stopped two good builds: a platform's own memory file and
    // the archives of previous releases sitting beside the source.
    for (const stray of ['attached_assets', '.agents', 'node_modules', 'dist-zip']) {
      expect(files.some((file) => file.includes(stray)), stray).toBe(false);
    }
  });

  it('keeps the exemption honest', () => {
    // If the exempt file stops containing one, the exemption should go rather
    // than sit there licensing a future one.
    for (const file of ALLOWED) {
      expect(readFileSync(file, 'utf8'), file).toContain(EM_DASH);
    }
  });
});
