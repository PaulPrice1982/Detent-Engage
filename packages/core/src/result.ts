import { AwaError } from './errors.js';

export type Result<T, E = AwaError> = { ok: true; value: T } | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}

export function mapResult<T, U>(result: Result<T>, fn: (value: T) => U): Result<U> {
  return result.ok ? ok(fn(result.value)) : result;
}

/** Run a promise, converting a throw into a typed Result rather than a rejection. */
export async function attempt<T>(
  fn: () => Promise<T>,
  onError: (cause: unknown) => AwaError,
): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (cause) {
    return err(onError(cause));
  }
}
