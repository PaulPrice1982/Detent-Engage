/**
 * A zero-dependency test runner implementing the Vitest subset this suite uses.
 *
 * Why this exists: the suite previously could not run at all if a single
 * package — vitest — was unavailable. Locked-down registries and package
 * firewalls block individual versions routinely, and a test suite that cannot
 * run in a restricted environment is a test suite that stops being evidence
 * exactly where evidence matters most.
 *
 * Vitest remains the primary runner. `pnpm test` uses it when it is installed,
 * and falls back here when it is not. Both run the same test files unmodified,
 * because this implements the same API rather than a variant of it.
 *
 * Scope is deliberately the surface the suite actually uses, verified by
 * grepping the tests. It is not a general-purpose framework and should not
 * grow into one: anything it does not support should be a compile error in the
 * test, not a silently passing assertion.
 */
import { relative } from 'node:path';

// --------------------------------------------------------------------------
// Assertion errors
// --------------------------------------------------------------------------

export class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

const show = (value: unknown, depth = 0): string => {
  if (depth > 3) return '…';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value !== 'object') return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (Array.isArray(value)) {
    const head = value.slice(0, 8).map((v) => show(v, depth + 1)).join(', ');
    return `[${head}${value.length > 8 ? `, …${value.length - 8} more` : ''}]`;
  }
  try {
    const json = JSON.stringify(value);
    return json.length > 400 ? `${json.slice(0, 400)}…` : json;
  } catch {
    return '[unserialisable]';
  }
};

// --------------------------------------------------------------------------
// Structural equality
// --------------------------------------------------------------------------

/** Marker produced by `expect.arrayContaining`. */
const ARRAY_CONTAINING = Symbol('arrayContaining');
interface ArrayContaining { readonly [ARRAY_CONTAINING]: readonly unknown[] }

const isArrayContaining = (value: unknown): value is ArrayContaining =>
  typeof value === 'object' && value !== null && ARRAY_CONTAINING in value;

export function deepEqual(actual: unknown, expected: unknown): boolean {
  if (isArrayContaining(expected)) {
    if (!Array.isArray(actual)) return false;
    return expected[ARRAY_CONTAINING].every((wanted) =>
      actual.some((item) => deepEqual(item, wanted)),
    );
  }
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== typeof expected) return false;
  if (actual === null || expected === null) return false;
  if (typeof actual !== 'object') return false;

  if (Array.isArray(actual) !== Array.isArray(expected)) return false;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((item, i) => deepEqual(item, expected[i]));
  }
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  if (actual instanceof Set && expected instanceof Set) {
    if (actual.size !== expected.size) return false;
    for (const item of actual) if (!expected.has(item)) return false;
    return true;
  }
  if (actual instanceof Map && expected instanceof Map) {
    if (actual.size !== expected.size) return false;
    for (const [key, value] of actual) {
      if (!expected.has(key) || !deepEqual(value, expected.get(key))) return false;
    }
    return true;
  }

  // Vitest's toEqual ignores properties that are undefined on both sides.
  const a = actual as Record<string, unknown>;
  const b = expected as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] === undefined && b[key] === undefined) continue;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/** `toMatchObject`: every expected key matches; extra actual keys are fine. */
function matchesObject(actual: unknown, expected: unknown): boolean {
  if (isArrayContaining(expected)) return deepEqual(actual, expected);
  if (typeof expected !== 'object' || expected === null) return deepEqual(actual, expected);
  if (typeof actual !== 'object' || actual === null) return false;

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((item, i) => matchesObject(actual[i], item));
  }

  const a = actual as Record<string, unknown>;
  const b = expected as Record<string, unknown>;
  return Object.keys(b).every((key) => matchesObject(a[key], b[key]));
}

function containsValue(actual: unknown, needle: unknown): boolean {
  if (typeof actual === 'string') return actual.includes(String(needle));
  if (Array.isArray(actual)) return actual.some((item) => Object.is(item, needle) || item === needle);
  if (actual instanceof Set) return actual.has(needle);
  throw new AssertionError(`toContain requires a string, array or Set, received ${show(actual)}`);
}

// --------------------------------------------------------------------------
// expect
// --------------------------------------------------------------------------

interface Matchers {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toStrictEqual(expected: unknown): void;
  toMatchObject(expected: unknown): void;
  toContain(expected: unknown): void;
  toContainEqual(expected: unknown): void;
  toHaveLength(expected: number): void;
  toHaveProperty(key: string, value?: unknown): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toBeNull(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeGreaterThan(expected: number): void;
  toBeGreaterThanOrEqual(expected: number): void;
  toBeLessThan(expected: number): void;
  toBeLessThanOrEqual(expected: number): void;
  toBeCloseTo(expected: number, digits?: number): void;
  toMatch(expected: RegExp | string): void;
  toThrow(expected?: ThrowMatcher): void;
  toThrowError(expected?: ThrowMatcher): void;
  toBeInstanceOf(expected: Function): void;
}

/** What `toThrow` accepts: nothing, a message fragment, a pattern, or a class. */
export type ThrowMatcher = RegExp | string | (new (...args: never[]) => Error);

interface AsyncMatchers {
  toMatchObject(expected: unknown): Promise<void>;
  toThrow(expected?: ThrowMatcher): Promise<void>;
  toThrowError(expected?: ThrowMatcher): Promise<void>;
  toBe(expected: unknown): Promise<void>;
  toEqual(expected: unknown): Promise<void>;
  toBeUndefined(): Promise<void>;
  toBeDefined(): Promise<void>;
  toBeTruthy(): Promise<void>;
  toBeFalsy(): Promise<void>;
}

export interface Expectation extends Matchers {
  readonly not: Matchers;
  readonly rejects: AsyncMatchers;
  readonly resolves: AsyncMatchers;
}

function buildMatchers(actual: unknown, negated: boolean): Matchers {
  const fail = (message: string): never => {
    throw new AssertionError(negated ? `expected NOT: ${message}` : message);
  };
  // A matcher passes when `condition` is true and we are not negated, or when
  // it is false and we are. One place to get the polarity right.
  const assert = (condition: boolean, message: string): void => {
    if (condition === negated) fail(message);
  };

  const asNumber = (): number => {
    if (typeof actual !== 'number') fail(`expected a number, received ${show(actual)}`);
    return actual as number;
  };

  const captureThrow = (): unknown => {
    if (typeof actual !== 'function') fail(`toThrow requires a function, received ${show(actual)}`);
    try {
      (actual as () => unknown)();
      return undefined;
    } catch (error) {
      return error ?? new Error('thrown falsy value');
    }
  };

  const matchesThrown = (thrown: unknown, expected?: ThrowMatcher): boolean => {
    if (thrown === undefined) return false;
    if (expected === undefined) return true;
    if (typeof expected === 'function') {
      // An error class, which is how a test asserts the *kind* of failure
      // rather than its wording. Matching on the class name as well covers the
      // case where a bundler has produced a distinct constructor identity for
      // the same class.
      return thrown instanceof expected ||
        (thrown instanceof Error && thrown.name === expected.name);
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return expected instanceof RegExp ? expected.test(message) : message.includes(expected);
  };

  return {
    toBe(expected) {
      assert(Object.is(actual, expected), `expected ${show(actual)} to be ${show(expected)}`);
    },
    toEqual(expected) {
      assert(deepEqual(actual, expected), `expected ${show(actual)} to equal ${show(expected)}`);
    },
    toStrictEqual(expected) {
      assert(deepEqual(actual, expected), `expected ${show(actual)} to strictly equal ${show(expected)}`);
    },
    toMatchObject(expected) {
      assert(matchesObject(actual, expected), `expected ${show(actual)} to match object ${show(expected)}`);
    },
    toContain(expected) {
      assert(containsValue(actual, expected), `expected ${show(actual)} to contain ${show(expected)}`);
    },
    toContainEqual(expected) {
      const found = Array.isArray(actual) && actual.some((item) => deepEqual(item, expected));
      assert(found, `expected ${show(actual)} to contain an item equal to ${show(expected)}`);
    },
    toHaveLength(expected) {
      const length = (actual as { length?: number } | null)?.length;
      assert(length === expected, `expected length ${expected}, received ${show(length)}`);
    },
    toHaveProperty(key, value) {
      const target = actual as Record<string, unknown> | null;
      const present = target !== null && typeof target === 'object' && key in target;
      if (value === undefined) {
        assert(present, `expected ${show(actual)} to have property ${key}`);
        return;
      }
      assert(present && deepEqual(target![key], value), `expected property ${key} to equal ${show(value)}`);
    },
    toBeDefined() {
      assert(actual !== undefined, `expected ${show(actual)} to be defined`);
    },
    toBeUndefined() {
      assert(actual === undefined, `expected ${show(actual)} to be undefined`);
    },
    toBeNull() {
      assert(actual === null, `expected ${show(actual)} to be null`);
    },
    toBeTruthy() {
      assert(Boolean(actual), `expected ${show(actual)} to be truthy`);
    },
    toBeFalsy() {
      assert(!actual, `expected ${show(actual)} to be falsy`);
    },
    toBeGreaterThan(expected) {
      assert(asNumber() > expected, `expected ${show(actual)} to be greater than ${expected}`);
    },
    toBeGreaterThanOrEqual(expected) {
      assert(asNumber() >= expected, `expected ${show(actual)} to be at least ${expected}`);
    },
    toBeLessThan(expected) {
      assert(asNumber() < expected, `expected ${show(actual)} to be less than ${expected}`);
    },
    toBeLessThanOrEqual(expected) {
      assert(asNumber() <= expected, `expected ${show(actual)} to be at most ${expected}`);
    },
    toBeCloseTo(expected, digits = 2) {
      // Vitest's rule: the difference must be below half a unit in the last
      // requested decimal place.
      const tolerance = 10 ** -digits / 2;
      assert(
        Math.abs(asNumber() - expected) < tolerance,
        `expected ${show(actual)} to be within ${tolerance} of ${expected}`,
      );
    },
    toMatch(expected) {
      if (typeof actual !== 'string') fail(`toMatch requires a string, received ${show(actual)}`);
      const text = actual as string;
      const matched = expected instanceof RegExp ? expected.test(text) : text.includes(expected);
      assert(matched, `expected ${show(actual)} to match ${expected}`);
    },
    toThrow(expected) {
      assert(matchesThrown(captureThrow(), expected), `expected the function to throw${describeMatcher(expected)}`);
    },
    toThrowError(expected) {
      assert(matchesThrown(captureThrow(), expected), `expected the function to throw${describeMatcher(expected)}`);
    },
    toBeInstanceOf(expected) {
      assert(actual instanceof (expected as new (...args: never[]) => unknown), `expected ${show(actual)} to be an instance of ${expected.name}`);
    },
  };
}

function buildAsyncMatchers(promise: unknown, wantRejection: boolean): AsyncMatchers {
  const settle = async (): Promise<{ rejected: boolean; value: unknown }> => {
    try {
      return { rejected: false, value: await (promise as Promise<unknown>) };
    } catch (error) {
      return { rejected: true, value: error };
    }
  };

  const resolveValue = async (): Promise<unknown> => {
    const outcome = await settle();
    if (outcome.rejected !== wantRejection) {
      throw new AssertionError(
        wantRejection
          ? `expected the promise to reject, but it resolved with ${show(outcome.value)}`
          : `expected the promise to resolve, but it rejected with ${show(outcome.value)}`,
      );
    }
    return outcome.value;
  };

  const delegate = <K extends keyof Matchers>(name: K) =>
    async (...args: Parameters<Matchers[K]>): Promise<void> => {
      const value = await resolveValue();
      (buildMatchers(value, false)[name] as (...a: unknown[]) => void)(...args);
    };

  const throwLike = async (expected?: ThrowMatcher): Promise<void> => {
    const error = await resolveValue();
    if (expected === undefined) return;
    const matched = typeof expected === 'function'
      ? error instanceof expected || (error instanceof Error && error.name === expected.name)
      : expected instanceof RegExp
        ? expected.test(error instanceof Error ? error.message : String(error))
        : (error instanceof Error ? error.message : String(error)).includes(expected);
    if (!matched) {
      throw new AssertionError(`expected rejection ${show(error)} to match${describeMatcher(expected)}`);
    }
  };

  return {
    toMatchObject: delegate('toMatchObject'),
    toBe: delegate('toBe'),
    toEqual: delegate('toEqual'),
    toBeUndefined: delegate('toBeUndefined'),
    toBeDefined: delegate('toBeDefined'),
    toBeTruthy: delegate('toBeTruthy'),
    toBeFalsy: delegate('toBeFalsy'),
    toThrow: throwLike,
    toThrowError: throwLike,
  };
}

export interface ExpectStatic {
  /** The second argument is Vitest's per-assertion label. Accepted and ignored:
   *  the runner reports the test name, which is what a failure needs. */
  (actual: unknown, label?: string): Expectation;
  arrayContaining(items: readonly unknown[]): unknown;
}

export const expect: ExpectStatic = Object.assign(
  (actual: unknown): Expectation => ({
    ...buildMatchers(actual, false),
    not: buildMatchers(actual, true),
    rejects: buildAsyncMatchers(actual, true),
    resolves: buildAsyncMatchers(actual, false),
  }),
  {
    arrayContaining(items: readonly unknown[]): unknown {
      return { [ARRAY_CONTAINING]: items };
    },
  },
);

/** Readable matcher description, so a failure never prints a class body. */
function describeMatcher(expected?: ThrowMatcher): string {
  if (expected === undefined) return '';
  if (typeof expected === 'function') return ` an instance of ${expected.name}`;
  return ` matching ${expected instanceof RegExp ? String(expected) : JSON.stringify(expected)}`;
}

// --------------------------------------------------------------------------
// describe / it
// --------------------------------------------------------------------------

interface TestCase {
  readonly name: string;
  readonly fn: () => void | Promise<void>;
  readonly skip: boolean;
}

interface Suite {
  readonly name: string;
  readonly tests: TestCase[];
  readonly children: Suite[];
  readonly parent?: Suite;
}

const rootSuites: Suite[] = [];
let currentSuite: Suite | undefined;
/** Queued async describe bodies, awaited before the run starts. */
const pendingSuiteBodies: Promise<unknown>[] = [];

export function describe(name: string, body: () => void | Promise<void>): void {
  const suite: Suite = { name, tests: [], children: [], parent: currentSuite };
  if (currentSuite) currentSuite.children.push(suite);
  else rootSuites.push(suite);

  const previous = currentSuite;
  currentSuite = suite;
  const result = body();
  if (result instanceof Promise) {
    // An async describe registers its tests after the body resolves, so the
    // suite context must be restored inside the continuation, not outside it.
    pendingSuiteBodies.push(
      (async () => {
        const outer = currentSuite;
        currentSuite = suite;
        try { await result; } finally { currentSuite = outer; }
      })(),
    );
  }
  currentSuite = previous;
}

describe.each = <T>(cases: readonly T[]) =>
  (name: string, body: (value: T) => void | Promise<void>): void => {
    for (const value of cases) describe(interpolate(name, value), () => body(value));
  };

function register(name: string, fn: () => void | Promise<void>, skip: boolean): void {
  const suite = currentSuite ?? (rootSuites.find((s) => s.name === '') ?? (() => {
    const implicit: Suite = { name: '', tests: [], children: [] };
    rootSuites.push(implicit);
    return implicit;
  })());
  suite.tests.push({ name, fn, skip });
}

export function it(name: string, fn: () => void | Promise<void>): void {
  register(name, fn, false);
}

it.skip = (name: string, fn: () => void | Promise<void>): void => register(name, fn, true);
it.each = <T>(cases: readonly T[]) =>
  (name: string, body: (value: T) => void | Promise<void>): void => {
    for (const value of cases) it(interpolate(name, value), () => body(value));
  };

export const test = it;

/** Vitest's `%s` placeholder, which is all the suite uses. */
function interpolate(name: string, value: unknown): string {
  const rendered = typeof value === 'string' ? value : show(value);
  return name.includes('%s') ? name.replace('%s', rendered) : `${name} ${rendered}`;
}

// --------------------------------------------------------------------------
// Runner
// --------------------------------------------------------------------------

export interface RunResult {
  readonly files: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly failures: readonly { readonly path: string; readonly error: unknown }[];
}

const colour = process.stdout.isTTY && !process.env['NO_COLOR'];
const green = (s: string) => (colour ? `\x1b[32m${s}\x1b[0m` : s);
const red = (s: string) => (colour ? `\x1b[31m${s}\x1b[0m` : s);
const dim = (s: string) => (colour ? `\x1b[90m${s}\x1b[0m` : s);
const bold = (s: string) => (colour ? `\x1b[1m${s}\x1b[0m` : s);

export async function runFiles(files: readonly string[]): Promise<RunResult> {
  const failures: { path: string; error: unknown }[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const file of files) {
    rootSuites.length = 0;
    pendingSuiteBodies.length = 0;
    currentSuite = undefined;

    const label = relative(process.cwd(), file);
    try {
      await import(`${file}?t=${Date.now()}`);
    } catch (error) {
      failed++;
      failures.push({ path: label, error });
      console.log(`${red('✗')} ${label} ${dim('(failed to load)')}`);
      continue;
    }

    // Async describe bodies register their tests after import resolves.
    await Promise.all(pendingSuiteBodies);

    const before = failed;
    for (const suite of rootSuites) {
      const outcome = await runSuite(suite, [], label);
      passed += outcome.passed;
      failed += outcome.failed;
      skipped += outcome.skipped;
      failures.push(...outcome.failures);
    }
    const mark = failed === before ? green('✓') : red('✗');
    console.log(`${mark} ${label}`);
  }

  return { files: files.length, passed, failed, skipped, failures };
}

async function runSuite(suite: Suite, path: string[], file: string): Promise<RunResult> {
  const trail = suite.name ? [...path, suite.name] : path;
  const failures: { path: string; error: unknown }[] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const testCase of suite.tests) {
    const label = `${file} > ${[...trail, testCase.name].join(' > ')}`;
    if (testCase.skip) {
      skipped++;
      continue;
    }
    try {
      await testCase.fn();
      passed++;
    } catch (error) {
      failed++;
      failures.push({ path: label, error });
    }
  }

  for (const child of suite.children) {
    const outcome = await runSuite(child, trail, file);
    passed += outcome.passed;
    failed += outcome.failed;
    skipped += outcome.skipped;
    failures.push(...outcome.failures);
  }

  return { files: 1, passed, failed, skipped, failures };
}

export function report(result: RunResult): void {
  if (result.failures.length > 0) {
    console.log('');
    for (const failure of result.failures) {
      console.log(red(`FAIL  ${failure.path}`));
      const error = failure.error;
      console.log(`      ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`);
      if (error instanceof Error && error.stack && !(error instanceof AssertionError)) {
        const frame = error.stack.split('\n').find((line) => line.includes('/tests/') || line.includes('/packages/'));
        if (frame) console.log(dim(`      ${frame.trim()}`));
      }
      console.log('');
    }
  }

  const summary = [
    `${bold(String(result.passed))} passed`,
    result.failed > 0 ? red(`${result.failed} failed`) : undefined,
    result.skipped > 0 ? dim(`${result.skipped} skipped`) : undefined,
  ].filter(Boolean).join(', ');

  console.log('');
  console.log(`  Test files  ${result.files}`);
  console.log(`  Tests       ${summary}`);
  console.log('');
}
