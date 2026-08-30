import { PgDryRunError } from "./errors.js";

/**
 * Assert a value the surrounding code has already established, without a
 * non-null assertion. Reaching one of these is a bug in pg-dry-run, not bad
 * input, so it throws rather than degrading.
 */
export function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new PgDryRunError(`pg-dry-run internal error: ${what} was missing.`);
  }
  return value;
}
