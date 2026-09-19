#!/usr/bin/env node
/**
 * No dependency published in the last seven days.
 *
 * A package released hours ago has been read by nobody. The compromised
 * releases that reach real build systems are almost always caught within days,
 * and a week of latency costs nothing and removes most of that window.
 *
 * This is not hypothetical here: the delivered lockfile pinned an SDK
 * published the day before the archive was cut, which newer pnpm refuses
 * outright under its default supply-chain policy, so the repository would not
 * install at all on a current toolchain.
 *
 * Network failures are reported and do not fail the build. A registry outage
 * is not a supply-chain problem, and a check that fails the build when the
 * registry is slow is a check somebody will remove.
 */
import { readFileSync } from 'node:fs';

const MINIMUM_AGE_DAYS = 7;

const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const direct = {
  ...(manifest.dependencies ?? {}),
  ...(manifest.devDependencies ?? {}),
  ...(manifest.optionalDependencies ?? {}),
};

const versioned = Object.entries(direct)
  // Workspace links are this repository's own code, which has no publish date.
  .filter(([, range]) => typeof range === 'string' && !range.startsWith('workspace:'))
  .map(([name, range]) => [name, String(range).replace(/^[\^~>=<\s]+/, '')]);

const tooNew = [];
const unchecked = [];

for (const [name, version] of versioned) {
  let times;
  try {
    // The full document, not the abbreviated install metadata: the
    // abbreviated form omits `time`, which is the only field this needs and
    // whose absence made an earlier version of this check pass everything.
    const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) { unchecked.push(`${name} (registry answered ${response.status})`); continue; }
    times = (await response.json()).time ?? {};
  } catch (error) {
    unchecked.push(`${name} (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  const published = times[version];
  if (!published) { unchecked.push(`${name}@${version} (no publish date)`); continue; }
  const ageDays = (Date.now() - Date.parse(published)) / 86_400_000;
  if (ageDays < MINIMUM_AGE_DAYS) {
    tooNew.push(`${name}@${version} was published ${ageDays.toFixed(1)} days ago`);
  }
}

if (unchecked.length > 0) {
  process.stdout.write(`Could not check:\n  ${unchecked.join('\n  ')}\n`);
}
if (tooNew.length > 0) {
  process.stderr.write(
    `\nThese are newer than ${MINIMUM_AGE_DAYS} days:\n  ${tooNew.join('\n  ')}\n\n`
    + 'Pin the most recent release that is older than that, or state in the pull '
    + 'request why this one cannot wait.\n',
  );
  process.exit(1);
}
process.stdout.write(`dependency age: every direct dependency is at least ${MINIMUM_AGE_DAYS} days old\n`);
