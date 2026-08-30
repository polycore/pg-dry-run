import type { Sql } from "./driver.js";
import { UnsupportedStatementError } from "./errors.js";
import { boolean, integer, optionalText, text } from "./row.js";
import type { ReferentialAction, StatementKind, TableRef } from "./types.js";

/** Double-quote an identifier for interpolation into generated SQL. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function qualify(table: TableRef): string {
  return `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
}

/**
 * `format_type` output is a valid type name by construction, but it is
 * interpolated into SQL, so it is checked rather than trusted. Covers names,
 * schema qualification, modifiers, and array suffixes.
 */
const TYPE_NAME = /^[a-zA-Z_][a-zA-Z0-9_. "]*(\(\d+(,\s*\d+)?\))?(\[\])*$/;

export function assertTypeName(type: string): string {
  if (!TYPE_NAME.test(type)) {
    throw new UnsupportedStatementError(
      "unsupported_type",
      `Refusing to build SQL with an unrecognised type name: ${type}`,
    );
  }
  return type;
}

export interface Relation {
  readonly oid: number;
  readonly ref: TableRef;
}

/**
 * Resolve the written name through `to_regclass`, so an unqualified name obeys
 * the session's `search_path` exactly as it would have in the original
 * statement.
 */
export async function resolveRelation(
  sql: Sql,
  schema: string | undefined,
  name: string,
): Promise<Relation> {
  const written =
    schema === undefined
      ? quoteIdent(name)
      : `${quoteIdent(schema)}.${quoteIdent(name)}`;

  const rows = await sql(
    `SELECT c.oid::int8::int AS oid, n.nspname AS schema, c.relname AS name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.oid = to_regclass($1)`,
    [written],
  );

  const row = rows[0];
  if (!row) {
    throw new UnsupportedStatementError(
      "no_primary_key",
      `Relation ${written} does not exist or is not visible.`,
    );
  }
  return {
    oid: integer(row, "oid"),
    ref: { schema: text(row, "schema"), name: text(row, "name") },
  };
}

/**
 * The primary key, or nothing. An INSERT can be previewed without one, since
 * there is no existing row to pin: the key is only how the receipt names what
 * was created.
 */
export async function optionalPrimaryKeyColumns(
  sql: Sql,
  relation: Relation,
): Promise<readonly string[]> {
  const rows = await sql(
    `SELECT a.attname
       FROM pg_index i
       JOIN unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
      WHERE i.indrelid = $1 AND i.indisprimary
      ORDER BY k.ord`,
    [relation.oid],
  );
  return rows.map((row) => text(row, "attname"));
}

export async function primaryKeyColumns(
  sql: Sql,
  relation: Relation,
): Promise<readonly string[]> {
  const columns = await optionalPrimaryKeyColumns(sql, relation);

  if (columns.length === 0) {
    throw new UnsupportedStatementError(
      "no_primary_key",
      `${qualify(relation.ref)} has no primary key, so previewed rows could not ` +
        `be pinned for apply. Add a primary key or use a named migration.`,
    );
  }
  return columns;
}

/** attname -> `format_type` output, for casting text back to the real type. */
export async function columnTypes(
  sql: Sql,
  relation: Relation,
): Promise<ReadonlyMap<string, string>> {
  const rows = await sql(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_attribute a
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped`,
    [relation.oid],
  );
  return new Map(
    rows.map((row) => [
      text(row, "attname"),
      assertTypeName(text(row, "type")),
    ]),
  );
}

/**
 * Everything an INSERT needs to know about one column, since what an insert
 * writes is decided as much by the table as by the statement.
 */
export interface ColumnMeta {
  readonly name: string;
  /** `format_type` output, for casting text back to the real type. */
  readonly type: string;
  readonly notNull: boolean;
  /** `GENERATED ... STORED`: the database computes it and refuses a value. */
  readonly generated: boolean;
  /** `GENERATED ALWAYS AS IDENTITY`: same, for the same reason. */
  readonly identityAlways: boolean;
  /** The DEFAULT expression as SQL text, when the column has one. */
  readonly defaultExpr: string | undefined;
  /**
   * The default draws from a sequence, so it cannot be evaluated during a
   * read-only preview: `nextval()` is a write. The database assigns it at apply
   * time instead, and the preview says so rather than inventing a value.
   */
  readonly sequenced: boolean;
}

/** Every column of the relation, in declared order. */
export async function columnMeta(
  sql: Sql,
  relation: Relation,
): Promise<readonly ColumnMeta[]> {
  const rows = await sql(
    `SELECT a.attname,
            format_type(a.atttypid, a.atttypmod)             AS type,
            a.attnotnull,
            a.attgenerated <> ''                             AS generated,
            a.attidentity = 'a'                              AS identity_always,
            pg_get_expr(d.adbin, d.adrelid)                  AS def,
            (pg_get_serial_sequence(a.attrelid::regclass::text, a.attname)
               IS NOT NULL
             OR coalesce(pg_get_expr(d.adbin, d.adrelid), '') ~ 'nextval\\('
             OR a.attidentity <> '')                         AS sequenced
       FROM pg_attribute a
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [relation.oid],
  );

  return rows.map((row) => {
    const def = optionalText(row, "def");
    return {
      name: text(row, "attname"),
      type: assertTypeName(text(row, "type")),
      notNull: boolean(row, "attnotnull"),
      generated: boolean(row, "generated"),
      identityAlways: boolean(row, "identity_always"),
      defaultExpr: def ?? undefined,
      sequenced: boolean(row, "sequenced"),
    };
  });
}

/**
 * A diff of opaque keys is unreadable, and recognising the row is the whole
 * point of a preview. Pick the first conventional human-facing column present.
 */
export async function labelColumn(
  sql: Sql,
  relation: Relation,
  candidates: readonly string[],
): Promise<string | undefined> {
  if (candidates.length === 0) return undefined;
  const rows = await sql(
    `SELECT a.attname
       FROM pg_attribute a
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attname = ANY($2::text[])
      ORDER BY array_position($2::text[], a.attname)
      LIMIT 1`,
    [relation.oid, [...candidates]],
  );
  const row = rows[0];
  return row === undefined ? undefined : text(row, "attname");
}

export type TriggerTiming = "BEFORE" | "AFTER" | "INSTEAD OF";

/** `tgtype` bit for the statement being previewed. */
const TRIGGER_BIT: Readonly<Record<StatementKind, number>> = {
  insert: 4,
  delete: 8,
  update: 16,
};

export interface TriggerInfo {
  readonly name: string;
  readonly timing: TriggerTiming;
  /** Whether it fires for the statement kind being previewed. */
  readonly fires: boolean;
}

/**
 * Triggers are the main thing a derived read cannot see: a BEFORE trigger can
 * change the values actually written, and any trigger can write elsewhere.
 */
export async function triggers(
  sql: Sql,
  relation: Relation,
  kind: StatementKind,
): Promise<readonly TriggerInfo[]> {
  // tgtype bits: 1 = ROW, 2 = BEFORE, 4 = INSERT, 8 = DELETE, 16 = UPDATE,
  // 32 = TRUNCATE, 64 = INSTEAD OF.
  const rows = await sql(
    `SELECT tgname AS name,
            CASE WHEN (tgtype & 64) <> 0 THEN 'INSTEAD OF'
                 WHEN (tgtype & 2) <> 0 THEN 'BEFORE'
                 ELSE 'AFTER' END AS timing,
            (tgtype & $2::int) <> 0 AS fires
       FROM pg_trigger
      WHERE tgrelid = $1 AND NOT tgisinternal AND tgenabled <> 'D'
      ORDER BY tgname`,
    [relation.oid, TRIGGER_BIT[kind]],
  );

  return rows.map((row) => ({
    name: text(row, "name"),
    timing: timingOf(text(row, "timing")),
    fires: boolean(row, "fires"),
  }));
}

function timingOf(value: string): TriggerTiming {
  if (value === "BEFORE" || value === "INSTEAD OF") return value;
  return "AFTER";
}

/** Rewrite rules can replace the statement wholesale. Rare, but reportable. */
export async function rules(
  sql: Sql,
  relation: Relation,
): Promise<readonly string[]> {
  const rows = await sql(
    `SELECT rulename FROM pg_rewrite
      WHERE ev_class = $1 AND rulename <> '_RETURN' ORDER BY rulename`,
    [relation.oid],
  );
  return rows.map((row) => text(row, "rulename"));
}

export async function generatedColumns(
  sql: Sql,
  relation: Relation,
): Promise<readonly string[]> {
  const rows = await sql(
    `SELECT a.attname FROM pg_attribute a
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
        AND a.attgenerated <> '' ORDER BY a.attnum`,
    [relation.oid],
  );
  return rows.map((row) => text(row, "attname"));
}

/** Columns under a unique constraint: an apply on these can fail on conflict. */
export async function uniqueColumns(
  sql: Sql,
  relation: Relation,
): Promise<ReadonlySet<string>> {
  const rows = await sql(
    `SELECT DISTINCT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1 AND i.indisunique AND NOT i.indisprimary`,
    [relation.oid],
  );
  return new Set(rows.map((row) => text(row, "attname")));
}

export interface ChildForeignKey {
  readonly constraint: string;
  readonly child: TableRef;
  readonly childOid: number;
  readonly column: string;
  readonly parentColumn: string;
  readonly action: ReferentialAction;
}

const ACTIONS: Readonly<Record<string, ReferentialAction>> = {
  c: "cascade",
  n: "set null",
  d: "set default",
  r: "restrict",
  a: "no action",
};

/** Single-column foreign keys pointing at this relation. */
export async function childForeignKeys(
  sql: Sql,
  relation: Relation,
): Promise<readonly ChildForeignKey[]> {
  const rows = await sql(
    `SELECT c.conname                      AS constraint_name,
            n.nspname                      AS schema,
            cl.relname                     AS name,
            cl.oid::int8::int              AS child_oid,
            ca.attname                     AS child_column,
            pa.attname                     AS parent_column,
            c.confdeltype                  AS action
       FROM pg_constraint c
       JOIN pg_class cl ON cl.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = cl.relnamespace
       JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = c.conkey[1]
       JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
      WHERE c.confrelid = $1
        AND c.contype = 'f'
        AND array_length(c.conkey, 1) = 1
      ORDER BY cl.relname, c.conname`,
    [relation.oid],
  );

  return rows.map((row) => ({
    constraint: text(row, "constraint_name"),
    child: { schema: text(row, "schema"), name: text(row, "name") },
    childOid: integer(row, "child_oid"),
    column: text(row, "child_column"),
    parentColumn: text(row, "parent_column"),
    action: ACTIONS[text(row, "action")] ?? "no action",
  }));
}
