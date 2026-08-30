/**
 * Public data shapes.
 *
 * A `Proposal` is plain JSON. It has to be: the statement is previewed in one
 * place, reviewed by a human somewhere else, and applied later by a third
 * process. Nothing here holds a connection, a function, or a class instance,
 * and every value crosses as its Postgres text representation so a round trip
 * through `JSON.stringify` is lossless.
 */

export type StatementKind = "insert" | "update" | "delete";

export interface TableRef {
  readonly schema: string;
  readonly name: string;
}

/** One column's before and after, as Postgres text output. `null` is SQL NULL. */
export interface FieldChange {
  readonly column: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface RowChange {
  /**
   * Primary-key values, as text, keyed by column name. Empty or partial for an
   * `insert` whose key the database assigns: that value does not exist yet.
   */
  readonly key: Readonly<Record<string, string>>;
  /**
   * The row's `xmin` at preview time. Changes on every write to the row.
   * `null` for an `insert`, where there is no row to have a version.
   */
  readonly version: string | null;
  /** A human-recognisable value (email, name, slug) when the table has one. */
  readonly label: string | null;
  /**
   * Per-column diff. Always empty for `delete`, where the whole row goes. For
   * an `insert`, `before` is always `null` and a column the database fills at
   * apply time is absent rather than shown as null.
   */
  readonly fields: readonly FieldChange[];
}

export type ReferentialAction =
  | "cascade"
  | "set null"
  | "set default"
  | "restrict"
  | "no action";

/** A foreign key reachable from the target, discovered from the catalog. */
export interface CascadeNode {
  /** 0 = a direct child of the target table. */
  readonly depth: number;
  readonly table: TableRef;
  /** Referencing column on `table`. */
  readonly via: string;
  readonly action: ReferentialAction;
  /**
   * Rows referencing the target through this constraint. What happens to them
   * is `action`: `cascade` deletes them, `set null`/`set default` rewrites the
   * referencing column, and `restrict`/`no action` makes the delete fail.
   */
  readonly rowCount: number;
}

export type WarningCode =
  | "trigger"
  | "rule"
  | "generated_column"
  | "unique_column_touched"
  | "restrict_blocks_delete"
  | "cascade_depth_truncated"
  | "deferred_default"
  | "default_evaluated"
  | "missing_required_column";

/**
 * Something the derived read cannot see, or a hazard it can see but not
 * prevent. Warnings never block; they exist so a preview never implies
 * completeness it does not have.
 */
export interface Warning {
  readonly code: WarningCode;
  readonly message: string;
}

/**
 * The mechanical detail `apply` needs, carried on the proposal so apply works
 * in a process that never saw the original statement. Opaque to callers.
 */
export interface ApplyPlan {
  /** Empty only for an `insert` into a table with no primary key. */
  readonly keyColumns: readonly string[];
  /**
   * Columns the apply writes, with their catalog types, used to cast text back:
   * the assigned columns of an `update`, and the written columns of an
   * `insert`. Empty for a `delete`.
   */
  readonly assignments: readonly {
    readonly column: string;
    readonly type: string;
  }[];
}

export interface Proposal {
  readonly id: string;
  readonly kind: StatementKind;
  readonly table: TableRef;
  readonly rowCount: number;
  readonly changes: readonly RowChange[];
  readonly cascades: readonly CascadeNode[];
  readonly warnings: readonly Warning[];
  /** The read-only SELECT that produced this preview, for transparency. */
  readonly derivedSql: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly plan: ApplyPlan;
}

export interface Receipt {
  readonly proposalId: string;
  readonly rowsAffected: number;
  readonly appliedAt: string;
  /**
   * Primary keys of the rows the apply touched, as text. The only way to learn
   * a key the database generated during an `insert`. Empty when the table has
   * no primary key.
   */
  readonly keys: readonly Readonly<Record<string, string>>[];
}

/** A row that moved between preview and apply. */
export interface DriftedRow {
  readonly key: Readonly<Record<string, string>>;
  readonly reason: "modified" | "missing";
  /** Current `xmin`, or `null` when the row no longer exists. */
  readonly currentVersion: string | null;
}
