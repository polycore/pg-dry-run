import type { Row } from "./driver.js";
import { PgDryRunError } from "./errors.js";

/**
 * Narrowing readers for driver rows.
 *
 * A driver returns dynamic values, so each read states the type it expects
 * instead of the driver claiming to know. Every catalog query in this package
 * selects a known shape, so a miss is a bug here rather than bad input.
 */

export function optionalText(row: Row, column: string): string | null {
  const value = row[column];
  return typeof value === "string" ? value : null;
}

export function text(row: Row, column: string): string {
  const value = optionalText(row, column);
  if (value === null) {
    throw new PgDryRunError(`Expected text in column "${column}".`);
  }
  return value;
}

export function integer(row: Row, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new PgDryRunError(`Expected a number in column "${column}".`);
}

/**
 * A `text[]` column. Drivers disagree on array decoding: postgres.js hands back
 * a real array, while PGlite may hand back the literal `{a,b}`. Accept both.
 */
export function textArray(row: Row, column: string): readonly string[] {
  const value = row[column];
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value === "string") {
    const inner = value.replace(/^\{/, "").replace(/\}$/, "");
    if (inner === "") return [];
    return inner.split(",").map((entry) => entry.replace(/^"|"$/g, ""));
  }
  throw new PgDryRunError(`Expected a text array in column "${column}".`);
}

export function boolean(row: Row, column: string): boolean {
  const value = row[column];
  if (typeof value === "boolean") return value;
  if (value === "t" || value === "true") return true;
  if (value === "f" || value === "false") return false;
  throw new PgDryRunError(`Expected a boolean in column "${column}".`);
}
