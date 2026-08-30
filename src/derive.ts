import type { MutationAnalysis } from "./analyze.js";
import {
  castTo,
  castToText,
  columnRef,
  deparseCount,
  deparseSelect,
  intLiteral,
  type PgNode,
  resTarget,
  starRef,
  typeName,
} from "./ast.js";
import { UnsupportedStatementError } from "./errors.js";

/**
 * Output aliases for the derived read. Prefixed and positional, so they cannot
 * collide with a real column and odd column names never have to survive a round
 * trip through an identifier.
 */
export const VERSION_ALIAS = "pgp_v";
export const LABEL_ALIAS = "pgp_l";
export const keyAlias = (i: number): string => `pgp_k${i}`;
export const beforeAlias = (i: number): string => `pgp_b${i}`;
export const afterAlias = (i: number): string => `pgp_a${i}`;

export interface DerivedRead {
  readonly sql: string;
  /** Assigned columns in alias order, so results map back positionally. */
  readonly assignedColumns: readonly string[];
}

export interface DeriveInput {
  readonly analysis: MutationAnalysis;
  readonly keyColumns: readonly string[];
  readonly labelColumn: string | undefined;
  readonly columnTypes: ReadonlyMap<string, string>;
  /** One more than the enumeration limit, so overflow is detectable. */
  readonly limit: number;
}

/**
 * Turn the mutation into a SELECT that computes the same diff.
 *
 * The target relation becomes the FROM, the predicate is copied across
 * untouched, and each assignment becomes a before/after pair. Every value is
 * rendered as `text`, and each assigned expression is first cast to the
 * column's real type, so `$1` is interpreted exactly as the UPDATE would have
 * interpreted it and the text output round-trips on apply.
 */
export async function deriveRead(input: DeriveInput): Promise<DerivedRead> {
  const { analysis, keyColumns, labelColumn, columnTypes, limit } = input;

  const targetList: PgNode[] = keyColumns.map((column, i) =>
    resTarget(castToText(columnRef(column)), keyAlias(i)),
  );

  // xmin is a system column: the transaction that last wrote this row version.
  targetList.push(resTarget(castToText(columnRef("xmin")), VERSION_ALIAS));

  if (labelColumn !== undefined) {
    targetList.push(resTarget(castToText(columnRef(labelColumn)), LABEL_ALIAS));
  }

  const assignedColumns: string[] = [];
  for (const [i, assignment] of analysis.assignments.entries()) {
    const type = columnTypes.get(assignment.column);
    if (type === undefined) {
      throw new UnsupportedStatementError(
        "unresolvable_assignment",
        `Column "${assignment.column}" does not exist on the target relation.`,
      );
    }
    assignedColumns.push(assignment.column);
    targetList.push(
      resTarget(castToText(columnRef(assignment.column)), beforeAlias(i)),
      resTarget(
        castToText(castTo(assignment.value, await typeName(type))),
        afterAlias(i),
      ),
    );
  }

  if (analysis.kind === "delete") targetList.push(resTarget(starRef()));

  const sql = await deparseSelect({
    targetList,
    relation: analysis.relation,
    where: analysis.where,
    limit: await intLiteral(limit),
  });

  return { sql, assignedColumns };
}

/**
 * The same predicate as a plain count, used only to report an exact number when
 * a statement exceeds the enumeration limit.
 */
export async function deriveCount(analysis: MutationAnalysis): Promise<string> {
  return await deparseCount(analysis.relation, analysis.where);
}
