import type { InsertAnalysis } from "./analyze.js";
import {
  castTo,
  castToText,
  deparseTargets,
  parseExpression,
  type PgNode,
  resTarget,
  typeName,
} from "./ast.js";
import {
  assertTypeName,
  type ColumnMeta,
  columnMeta,
  labelColumn,
  optionalPrimaryKeyColumns,
  qualify,
  quoteIdent,
  type Relation,
} from "./catalog.js";
import { keyAlias } from "./derive.js";
import type { Row, Sql } from "./driver.js";
import {
  PgDryRunError,
  TooManyRowsError,
  UnsupportedStatementError,
} from "./errors.js";
import { optionalText } from "./row.js";
import type { ApplyPlan, Proposal, RowChange, Warning } from "./types.js";
import { insertWarnings } from "./warnings.js";

/**
 * The insert half of the package, where the mechanism is the mirror image of
 * the other two.
 *
 * An UPDATE or DELETE hides its rows behind a predicate, so the preview has to
 * find them and the apply has to pin them. An INSERT has the opposite problem:
 * the rows are named literally and cannot be found anywhere, because they do
 * not exist yet. What is hidden is the other half of each row, the half the
 * table supplies. `status` defaults to `'pending'`, `role` defaults to
 * `'admin'`, `created_at` defaults to `now()`, and none of it appears in the
 * statement an approver reads.
 *
 * So the preview resolves the whole row rather than echoing the statement.
 * Every value a row will carry is evaluated during the read-only preview,
 * whether it was written in the VALUES list or came from a column default, and
 * the apply writes exactly those values back. Two consequences worth stating:
 *
 * - **What was approved is what lands.** A default is evaluated once, at
 *   preview time, and pinned. `created_at` is the moment the preview ran, not
 *   the moment a human got round to approving it. This is the same position the
 *   package already takes on `SET token = gen_random_uuid()`, and it is
 *   reported as a warning so it is never a surprise.
 * - **Some values cannot be pinned.** A sequence default is `nextval()`, which
 *   is a write, so it cannot run inside the read-only preview. Those columns
 *   are left to the database, omitted from the diff rather than guessed at, and
 *   named in a warning. The receipt reports the keys the insert actually
 *   produced.
 */

/** Output alias for the value of one row's one column in the derived read. */
const cellAlias = (row: number, column: number): string =>
  `pgp_a${row}_${column}`;

/** What the preview resolved for one column, across every row. */
interface ColumnCells {
  readonly meta: ColumnMeta;
  /**
   * One entry per row: the expression to evaluate, or `undefined` when the row
   * leaves the value to the database (`DEFAULT`, or a column the statement
   * never named and the table cannot fill during a read).
   */
  readonly nodes: readonly (PgNode | undefined)[];
  /** At least one row takes its value from the table's default expression. */
  readonly fromDefault: boolean;
  /** At least one row takes its value from the statement itself. */
  readonly fromStatement: boolean;
}

export interface InsertPreviewOptions {
  readonly relation: Relation;
  /** The caller's bound parameters, passed through to the derived read. */
  readonly params: readonly unknown[];
  readonly labelColumns: readonly string[];
  readonly maxRows: number;
}

export interface InsertPreview {
  readonly changes: readonly RowChange[];
  readonly warnings: readonly Warning[];
  readonly derivedSql: string;
  readonly plan: ApplyPlan;
}

function refuse(message: string): never {
  throw new UnsupportedStatementError("unresolvable_assignment", message);
}

/** Resolve every value the insert would write, without writing anything. */
export async function previewInsert(
  sql: Sql,
  analysis: InsertAnalysis,
  options: InsertPreviewOptions,
): Promise<InsertPreview> {
  const { relation, maxRows } = options;
  const meta = await columnMeta(sql, relation);

  if (analysis.rows.length > maxRows) {
    throw new TooManyRowsError(analysis.rows.length, maxRows);
  }

  const targets = targetColumns(analysis, meta);
  for (const row of analysis.rows) {
    if (row.length !== targets.length) {
      refuse(
        `INSERT names ${targets.length} column(s) but a VALUES row supplies ` +
          `${row.length}.`,
      );
    }
  }

  const cells = await resolveCells(analysis, meta, targets);
  const written = cells.filter((cell) =>
    cell.nodes.some((node) => node !== undefined),
  );

  const keyColumns = await optionalPrimaryKeyColumns(sql, relation);
  const label = await labelColumn(sql, relation, options.labelColumns);

  const derived = await deriveInsertRead(written, analysis.rows.length);
  const values = await evaluate(sql, derived, options.params);

  const changes = analysis.rows.map((_, row): RowChange => {
    const fields = written.flatMap((cell, column) =>
      cell.nodes[row] === undefined
        ? []
        : [
            {
              column: cell.meta.name,
              before: null,
              after: optionalText(values, cellAlias(row, column)),
            },
          ],
    );
    const byColumn = new Map(
      fields.map((field) => [field.column, field.after]),
    );
    const key: Record<string, string> = {};
    for (const column of keyColumns) {
      const value = byColumn.get(column);
      // A key the database assigns has no value to name the row by yet.
      if (value !== undefined && value !== null) key[column] = value;
    }
    return {
      key,
      version: null,
      label: label === undefined ? null : (byColumn.get(label) ?? null),
      fields,
    };
  });

  return {
    changes,
    warnings: await insertWarnings(sql, relation, {
      supplied: written
        .filter((cell) => cell.fromStatement)
        .map((cell) => cell.meta.name),
      keyColumns,
      deferred: deferredColumns(cells),
      defaulted: written
        .filter((cell) => cell.fromDefault)
        .map((cell) => cell.meta.name),
      missing: missingColumns(cells),
    }),
    derivedSql:
      derived.sql ??
      "-- nothing to evaluate: every value comes from a database default",
    plan: {
      keyColumns,
      assignments: written.map((cell) => ({
        column: cell.meta.name,
        type: cell.meta.type,
      })),
    },
  };
}

/**
 * Run the derived read. One row comes back holding every cell of every row of
 * the insert, since the grid was flattened into one target list.
 */
async function evaluate(
  sql: Sql,
  derived: { readonly sql: string | undefined },
  params: readonly unknown[],
): Promise<Row> {
  if (derived.sql === undefined) return {};
  const row = (await sql(derived.sql, params))[0];
  if (row === undefined) {
    throw new PgDryRunError("The derived read returned no row.");
  }
  return row;
}

/**
 * The columns the statement names, or, when it names none, the leading columns
 * of the table as PostgreSQL would match them positionally.
 */
function targetColumns(
  analysis: InsertAnalysis,
  meta: readonly ColumnMeta[],
): readonly ColumnMeta[] {
  const named = analysis.columns;
  if (named === undefined) {
    const arity = analysis.rows[0]?.length ?? 0;
    if (arity > meta.length) {
      refuse(
        `INSERT supplies ${arity} value(s) but the table has ${meta.length} ` +
          `column(s).`,
      );
    }
    return meta.slice(0, arity).map(writable);
  }

  if (new Set(named).size !== named.length) {
    // PostgreSQL rejects this, and the resolver would silently keep only the
    // first value, so the preview would describe a statement that cannot run.
    refuse("INSERT names the same column more than once.");
  }

  return named.map((name) => {
    const column = meta.find((entry) => entry.name === name);
    if (column === undefined) {
      refuse(`Column "${name}" does not exist on the target relation.`);
    }
    return writable(column);
  });
}

/** A column the database owns cannot be given a value by the statement. */
function writable(column: ColumnMeta): ColumnMeta {
  if (column.generated) {
    refuse(
      `Column "${column.name}" is generated: the database computes it and ` +
        `refuses a value.`,
    );
  }
  if (column.identityAlways) {
    refuse(
      `Column "${column.name}" is GENERATED ALWAYS AS IDENTITY: the database ` +
        `assigns it and refuses a value.`,
    );
  }
  return column;
}

/**
 * One cell per column per row: what the statement wrote, or what the table
 * would fill in, or nothing when only the database can decide.
 */
async function resolveCells(
  analysis: InsertAnalysis,
  meta: readonly ColumnMeta[],
  targets: readonly ColumnMeta[],
): Promise<readonly ColumnCells[]> {
  const cells: ColumnCells[] = [];

  for (const column of meta) {
    if (column.generated) continue;

    const supplied = targets.findIndex((entry) => entry.name === column.name);
    const needsDefault =
      supplied === -1 ||
      analysis.rows.some((row) => row[supplied] === undefined);
    // Resolved once for the column, not once per row: a default expression is
    // the same expression however many rows fall through to it.
    const fallback = needsDefault ? await defaultNode(column) : undefined;

    // Columns nothing fills are kept rather than dropped: a key the database
    // assigns and a NOT NULL column about to fail both look like an empty row
    // of cells, and both have to be reported.
    const nodes = analysis.rows.map((row) =>
      supplied === -1 ? fallback : (row[supplied] ?? fallback),
    );

    const written = (row: number): boolean =>
      supplied !== -1 && analysis.rows[row]?.[supplied] !== undefined;

    cells.push({
      meta: column,
      nodes,
      fromDefault: nodes.some(
        (node, row) => node !== undefined && !written(row),
      ),
      fromStatement: nodes.some(
        (node, row) => node !== undefined && written(row),
      ),
    });
  }

  return cells;
}

/**
 * The column's DEFAULT as an expression node, or nothing when the preview must
 * leave it to the database. A sequence default is `nextval()`, which cannot run
 * in a read-only transaction; a column with no default takes SQL NULL, which
 * needs no expression because omitting the column produces it.
 */
async function defaultNode(column: ColumnMeta): Promise<PgNode | undefined> {
  if (column.sequenced) return undefined;
  if (column.defaultExpr === undefined) return undefined;

  const node = await parseExpression(column.defaultExpr);
  if (node === undefined) {
    throw new PgDryRunError(
      `Could not parse the default of "${column.name}": ${column.defaultExpr}`,
    );
  }
  return node;
}

/** Columns whose value the database assigns after the approval. */
function deferredColumns(cells: readonly ColumnCells[]): readonly string[] {
  return cells
    .filter(
      (cell) =>
        cell.meta.sequenced && cell.nodes.some((node) => node === undefined),
    )
    .map((cell) => cell.meta.name);
}

/**
 * NOT NULL columns that no row supplies and no default fills. The insert will
 * fail, and saying so before an approval is cheaper than after one.
 */
function missingColumns(cells: readonly ColumnCells[]): readonly string[] {
  return cells
    .filter(
      (cell) =>
        cell.meta.notNull &&
        !cell.meta.sequenced &&
        cell.meta.defaultExpr === undefined &&
        cell.nodes.some((node) => node === undefined),
    )
    .map((cell) => cell.meta.name);
}

/**
 * One read that evaluates every cell of every row: the target list is the whole
 * grid, so a hundred-row insert is still a single query and a single set of
 * bound parameters, numbered exactly as the caller wrote them.
 */
async function deriveInsertRead(
  written: readonly ColumnCells[],
  rowCount: number,
): Promise<{ readonly sql: string | undefined }> {
  const targetList: PgNode[] = [];

  for (let row = 0; row < rowCount; row += 1) {
    for (const [column, cell] of written.entries()) {
      const node = cell.nodes[row];
      if (node === undefined) continue;
      targetList.push(
        resTarget(
          // Cast to the column's own type first, so the value is interpreted
          // exactly as the insert would have interpreted it and its text form
          // round-trips on apply.
          castToText(castTo(node, await typeName(cell.meta.type))),
          cellAlias(row, column),
        ),
      );
    }
  }

  if (targetList.length === 0) return { sql: undefined };
  return { sql: await deparseTargets(targetList) };
}

/**
 * Write the previewed rows.
 *
 * Every value crosses as text and is cast back with the column's catalog type,
 * so PostgreSQL's own input function reconstructs it. A column the preview left
 * to the database is written as the `DEFAULT` keyword, per row, so one row
 * naming a key and another leaving it to a sequence stay in the same statement.
 */
export function buildInsertApply(proposal: Proposal): {
  text: string;
  params: readonly (string | null)[];
} {
  const columns = proposal.plan.assignments;
  const returning = returningClause(proposal.plan.keyColumns);

  if (columns.length === 0) {
    // Every value comes from a default, so there is nothing to write into. A
    // row per series entry is the one form that expresses that for any count.
    return {
      text:
        `INSERT INTO ${qualify(proposal.table)} ` +
        `SELECT FROM generate_series(1, ${proposal.changes.length}) ` +
        `RETURNING ${returning}`,
      params: [],
    };
  }

  const params: (string | null)[] = [];
  const tuples = proposal.changes.map((change) => {
    const slots = columns.map((column) => {
      const field = change.fields.find(
        (entry) => entry.column === column.column,
      );
      if (field === undefined) return "DEFAULT";
      params.push(field.after);
      return `$${params.length}::text::${assertTypeName(column.type)}`;
    });
    return `(${slots.join(", ")})`;
  });

  const names = columns.map((column) => quoteIdent(column.column)).join(", ");
  return {
    text:
      `INSERT INTO ${qualify(proposal.table)} (${names}) ` +
      `VALUES ${tuples.join(", ")} RETURNING ${returning}`,
    params,
  };
}

/** Keys name what was created; a keyless table still has to count its rows. */
function returningClause(keyColumns: readonly string[]): string {
  if (keyColumns.length === 0) return "1 AS pgp_ok";
  return keyColumns
    .map((key, i) => `${quoteIdent(key)}::text AS ${keyAlias(i)}`)
    .join(", ");
}
