#!/usr/bin/env node
/**
 * Nothing a person should not read reaches a log.
 *
 * Two rules, both of which have been broken in this tree before:
 *
 *  1. `console.log` in library code. A log line written by a package is
 *     written wherever that package runs, which in a deployment is a log
 *     aggregator somebody else administers and retains. The entry points are
 *     allowed to print, because a developer running the server locally is the
 *     audience; nothing else is.
 *  2. A credential written as a literal. A key committed to a repository is a
 *     key in every clone and every fork of it, and rotating it is the only
 *     remedy once it is there.
 *
 * Deliberately a grep rather than a type. A type can be satisfied by a value
 * that was never checked; this reads what is actually written.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOTS = ['packages', 'tools'];
const SKIP = new Set(['node_modules', 'dist', '.git', 'dist-zip', 'coverage', 'public']);

/** Entry points and developer tooling, whose audience is a person at a terminal. */
const MAY_PRINT = [
  join('packages', 'server', 'src', 'main.ts'),
  join('packages', 'server', 'src', 'not-configured-server.ts'),
];

const SECRETS = [
  [/\bsk-ant-[A-Za-z0-9_-]{10,}/, 'an Anthropic API key'],
  [/\bsk_live_[A-Za-z0-9]{10,}/, 'a live Stripe secret key'],
  [/\bwhsec_[A-Za-z0-9]{10,}/, 'a Stripe webhook secret'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key id'],
  [/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/, 'a private key'],
  [/\bghp_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  // A connection string with a password in it, as opposed to one without.
  [/\bpostgres(?:ql)?:\/\/[^\s:'"`]+:[^\s@'"`]{3,}@/, 'a database password'],
];

/** Placeholders that exist to be obviously not a secret. */
const OBVIOUSLY_FAKE = /example|placeholder|redacted|your-|xxx|test|fake|dummy|sample/i;

function walk(directory, found = []) {
  let entries;
  try { entries = readdirSync(directory); } catch { return found; }
  for (const entry of entries) {
    if (SKIP.has(entry)) continue;
    const full = join(directory, entry);
    let stats;
    try { stats = statSync(full); } catch { continue; }
    if (stats.isDirectory()) walk(full, found);
    else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry)) found.push(full);
  }
  return found;
}

const problems = [];
for (const file of ROOTS.flatMap((root) => walk(root))) {
  const path = relative('.', file);
  const source = readFileSync(file, 'utf8');
  const lines = source.split('\n');

  const mayPrint = MAY_PRINT.includes(path) || path.startsWith(join('tools', ''));

  lines.forEach((line, index) => {
    const where = `${path}:${index + 1}`;
    if (!mayPrint && /\bconsole\.(log|info|debug)\s*\(/.test(line)) {
      problems.push(
        `${where} console.log in library code. Use the injected logger, which a `
        + 'deployment can route and redact.',
      );
    }
    for (const [pattern, what] of SECRETS) {
      if (!pattern.test(line)) continue;
      if (OBVIOUSLY_FAKE.test(line)) continue;
      problems.push(`${where} looks like ${what} written as a literal.`);
    }
  });
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join('\n')}\n\n${problems.length} problem(s).\n`);
  process.exit(1);
}
process.stdout.write('secret-lint: clean\n');
