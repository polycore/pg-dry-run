import {
  generatedColumns,
  type Relation,
  rules,
  triggers,
  uniqueColumns,
} from "./catalog.js";
import type { Sql } from "./driver.js";
import type { StatementKind, Warning } from "./types.js";

/**
 * What a derived read cannot see, or can see but cannot prevent.
 *
 * Warnings never block. They exist so a preview never implies completeness it
 * does not have: the alternative is an approver reading a diff as the whole
 * truth when a trigger is about to rewrite it.
 */

/** Hazards that belong to the table rather than to the statement. */
async function catalogWarnings(
  sql: Sql,
  relation: Relation,
  kind: StatementKind,
): Promise<readonly Warning[]> {
  const warnings: Warning[] = [];

  for (const trigger of await triggers(sql, relation, kind)) {
    if (!trigger.fires) continue;
    warnings.push({
      code: "trigger",
      message:
        trigger.timing === "BEFORE"
          ? `${trigger.timing} ${kind.toUpperCase()} trigger ${trigger.name} may ` +
            `change the values actually written, which this preview cannot see.`
          : `${trigger.timing} ${kind.toUpperCase()} trigger ${trigger.name} will ` +
            `run and may write elsewhere, which this preview cannot see.`,
    });
  }

  for (const rule of await rules(sql, relation)) {
    warnings.push({
      code: "rule",
      message: `Rewrite rule ${rule} may replace this statement entirely.`,
    });
  }

  return warnings;
}

/** Warnings for an UPDATE or DELETE. */
export async function mutationWarnings(
  sql: Sql,
  relation: Relation,
  kind: "update" | "delete",
  assigned: readonly string[],
): Promise<readonly Warning[]> {
  const warnings = [...(await catalogWarnings(sql, relation, kind))];
  if (kind === "delete") return warnings;

  const generated = await generatedColumns(sql, relation);
  if (generated.length > 0) {
    warnings.push({
      code: "generated_column",
      message:
        `Generated column(s) ${generated.join(", ")} will be recomputed and are ` +
        `not shown in this diff.`,
    });
  }

  const unique = await uniqueColumns(sql, relation);
  const touched = assigned.filter((column) => unique.has(column));
  if (touched.length > 0) {
    warnings.push({
      code: "unique_column_touched",
      message:
        `Assignment touches unique column(s) ${touched.join(", ")}. A preview ` +
        `cannot prove the write will not conflict; apply may fail.`,
    });
  }

  return warnings;
}

export interface InsertWarningInput {
  /**
   * Columns the statement itself supplies a value for. A unique column filled
   * from a table default (a `gen_random_uuid()` key) is not a collision anyone
   * needs warning about; one the caller chose is.
   */
  readonly supplied: readonly string[];
  /** Primary-key columns, which conflict as readily as any unique column. */
  readonly keyColumns: readonly string[];
  /** Columns the database fills at apply time, so the diff cannot show them. */
  readonly deferred: readonly string[];
  /** Columns whose value came from a table default, evaluated during preview. */
  readonly defaulted: readonly string[];
  /** NOT NULL columns no row supplies and no default fills. */
  readonly missing: readonly string[];
}

/**
 * Warnings for an INSERT. Three of these have no UPDATE equivalent, because an
 * insert's values are decided as much by the table as by the statement: a
 * column can be filled from a default this preview evaluated and pinned, filled
 * by the database after the approval, or left unfilled and about to fail.
 */
export async function insertWarnings(
  sql: Sql,
  relation: Relation,
  input: InsertWarningInput,
): Promise<readonly Warning[]> {
  const warnings = [...(await catalogWarnings(sql, relation, "insert"))];

  const generated = await generatedColumns(sql, relation);
  if (generated.length > 0) {
    warnings.push({
      code: "generated_column",
      message:
        `Generated column(s) ${generated.join(", ")} will be computed on insert ` +
        `and are not shown in this diff.`,
    });
  }

  const unique = await uniqueColumns(sql, relation);
  const touched = input.supplied.filter(
    (column) => unique.has(column) || input.keyColumns.includes(column),
  );
  if (touched.length > 0) {
    warnings.push({
      code: "unique_column_touched",
      message:
        `Insert supplies unique column(s) ${touched.join(", ")}. A preview ` +
        `cannot prove the row will not collide with an existing one; apply may ` +
        `fail.`,
    });
  }

  if (input.deferred.length > 0) {
    warnings.push({
      code: "deferred_default",
      message:
        `Column(s) ${input.deferred.join(", ")} are assigned by the database ` +
        `when the insert runs, so this preview cannot show their values.`,
    });
  }

  if (input.defaulted.length > 0) {
    warnings.push({
      code: "default_evaluated",
      message:
        `Column(s) ${input.defaulted.join(", ")} take a table default, ` +
        `evaluated now and written exactly as previewed rather than recomputed ` +
        `when the insert runs.`,
    });
  }

  if (input.missing.length > 0) {
    warnings.push({
      code: "missing_required_column",
      message:
        `Column(s) ${input.missing.join(", ")} are NOT NULL with no value and ` +
        `no default, so this insert will fail.`,
    });
  }

  return warnings;
}
