import {
  child,
  childList,
  nodeKind,
  parseStatements,
  type PgNode,
  present,
  str,
} from "./ast.js";
import { type UnsupportedReason, UnsupportedStatementError } from "./errors.js";

export interface Assignment {
  readonly column: string;
  /** The assigned expression, carried verbatim. Never inspected. */
  readonly value: PgNode;
}

interface Target {
  /** Schema as written, or undefined when the statement left it to search_path. */
  readonly schema: string | undefined;
  readonly table: string;
  /** The target relation, reused verbatim in the derived read. */
  readonly relation: PgNode;
}

/** An UPDATE or DELETE: a predicate over rows that already exist. */
export interface MutationAnalysis extends Target {
  readonly kind: "update" | "delete";
  /** The predicate, reused verbatim. Never inspected. */
  readonly where: PgNode;
  /** Empty for deletes. */
  readonly assignments: readonly Assignment[];
}

/**
 * An INSERT: literal rows, so there is no predicate and nothing to match. One
 * entry per VALUES tuple, each holding one expression per named column, and
 * `undefined` where the statement wrote the `DEFAULT` keyword.
 */
export interface InsertAnalysis extends Target {
  readonly kind: "insert";
  /** Column names as written, or undefined when the statement gave no list. */
  readonly columns: readonly string[] | undefined;
  readonly rows: readonly (readonly (PgNode | undefined)[])[];
}

export type Analysis = MutationAnalysis | InsertAnalysis;

function refuse(reason: UnsupportedReason, message: string): never {
  throw new UnsupportedStatementError(reason, message);
}

/**
 * Classify the statement and pull out the pieces the derived read needs.
 *
 * Nothing here interprets an expression. The predicate, each assigned value,
 * and each inserted value are carried across as opaque subtrees, which is why
 * any expression PostgreSQL can parse is supported without this file knowing
 * about it.
 */
export async function analyze(statement: string): Promise<Analysis> {
  const stmts = await parseStatements(statement);
  if (stmts.length !== 1) {
    refuse(
      "not_a_single_statement",
      `Expected exactly one statement, found ${stmts.length}.`,
    );
  }

  const stmt = stmts[0];
  const kind = stmt === undefined ? undefined : nodeKind(stmt);

  if (kind === "UpdateStmt") return update(child(stmt, "UpdateStmt"));
  if (kind === "DeleteStmt") return remove(child(stmt, "DeleteStmt"));
  if (kind === "InsertStmt") return add(child(stmt, "InsertStmt"));

  refuse(
    "unsupported_statement",
    `Only INSERT, UPDATE and DELETE can be previewed by rewrite (found ` +
      `${label(kind)}). Data-modifying CTEs and DDL are out of scope.`,
  );
}

function label(kind: string | undefined): string {
  return kind === undefined
    ? "an empty statement"
    : kind.replace(/Stmt$/, "").toUpperCase();
}

function update(node: PgNode | undefined): MutationAnalysis {
  const target = common(node, "UPDATE");
  const where = requireWhere(node, "UPDATE");
  if (present(node, "fromClause")) {
    refuse("multi_table", "UPDATE ... FROM is not supported.");
  }

  const assignments = childList(node, "targetList").map((entry): Assignment => {
    const assigned = child(entry, "ResTarget");
    const column = str(assigned, "name");
    if (column === undefined) {
      refuse(
        "unresolvable_assignment",
        "Could not resolve an assignment to a single column.",
      );
    }
    if (present(assigned, "indirection")) {
      refuse(
        "unresolvable_assignment",
        `Assignment to a subfield or element of "${column}" is not supported.`,
      );
    }
    const value = child(assigned, "val");
    if (!value) {
      refuse(
        "unresolvable_assignment",
        `Could not resolve the value assigned to "${column}".`,
      );
    }
    return { column, value };
  });

  if (assignments.length === 0) {
    refuse("unresolvable_assignment", "UPDATE has no assignments.");
  }

  return { kind: "update", ...target, where, assignments };
}

function remove(node: PgNode | undefined): MutationAnalysis {
  const target = common(node, "DELETE");
  const where = requireWhere(node, "DELETE");
  if (present(node, "usingClause")) {
    refuse("multi_table", "DELETE ... USING is not supported.");
  }
  return { kind: "delete", ...target, where, assignments: [] };
}

/**
 * An INSERT is previewable only when its rows are literal. `INSERT ... SELECT`
 * is refused rather than executed to find out what it would produce, and an
 * upsert is refused because its real effect on a conflicting row is an UPDATE
 * this rewrite never sees.
 */
function add(node: PgNode | undefined): InsertAnalysis {
  const target = common(node, "INSERT");

  if (present(node, "onConflictClause")) {
    refuse(
      "unsupported_clause",
      "INSERT ... ON CONFLICT is not supported: whether a row conflicts, and " +
        "what the conflict does to it, is not visible until the insert runs.",
    );
  }
  const override = str(node, "override");
  if (override !== undefined && override !== "OVERRIDING_NOT_SET") {
    refuse(
      "unsupported_clause",
      "INSERT ... OVERRIDING is not supported: it writes columns the database " +
        "is meant to own.",
    );
  }

  const columns = present(node, "cols")
    ? childList(node, "cols").map((entry) => {
        const column = str(child(entry, "ResTarget"), "name");
        if (column === undefined) {
          refuse(
            "unresolvable_assignment",
            "Could not resolve an inserted column to a single name.",
          );
        }
        return column;
      })
    : undefined;

  return { kind: "insert", ...target, columns, rows: valueRows(node) };
}

/**
 * The VALUES tuples, or the single all-defaults row of `DEFAULT VALUES`.
 * `undefined` marks a `DEFAULT` keyword, which resolves against the catalog
 * rather than against anything in the statement.
 */
function valueRows(
  node: PgNode | undefined,
): readonly (readonly (PgNode | undefined)[])[] {
  const select = child(child(node, "selectStmt"), "SelectStmt");
  // No select at all is `INSERT ... DEFAULT VALUES`: one row, every column
  // taking whatever the table says it should.
  if (select === undefined) return [[]];

  if (!present(select, "valuesLists")) {
    refuse(
      "unsupported_clause",
      "INSERT ... SELECT is not supported: the rows come from a query, so the " +
        "preview could not name them without running the insert.",
    );
  }

  return childList(select, "valuesLists").map((entry) =>
    childList(child(entry, "List"), "items").map((item) =>
      nodeKind(item) === "SetToDefault" ? undefined : item,
    ),
  );
}

function common(node: PgNode | undefined, keyword: string): Target {
  const relation = child(node, "relation");
  const table = str(relation, "relname");
  if (!relation || table === undefined) {
    refuse("multi_table", `${keyword} has no single target relation.`);
  }
  if (present(node, "withClause")) {
    refuse(
      "multi_table",
      `${keyword} with a WITH clause is not supported; the preview could not ` +
        `resolve the CTE.`,
    );
  }
  return { schema: str(relation, "schemaname"), table, relation };
}

function requireWhere(node: PgNode | undefined, keyword: string): PgNode {
  const where = child(node, "whereClause");
  if (!where) {
    refuse(
      "missing_where",
      `${keyword} without a WHERE clause is refused: it would name every row in ` +
        `the table.`,
    );
  }
  return where;
}
