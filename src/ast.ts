/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- This is the single boundary where libpg_query's untyped parse trees enter the package. Everything else consumes the typed façade below. */

import { deparse, loadModule, parse } from "pgsql-parser";

import { PgPreviewError } from "./errors.js";

/**
 * The one file that touches raw parse trees.
 *
 * `libpg_query` is PostgreSQL's own parser, and its output is a large untyped
 * node graph. Rather than model it, this module exposes a small typed façade:
 * read a handful of fields, copy opaque subtrees, and build the few node shapes
 * the derived read needs. Nothing outside this file performs an unchecked
 * operation on a parse node.
 */

/** An opaque parse node. Subtrees are copied, never inspected. */
export type PgNode = Readonly<Record<string, unknown>>;

const PG_VERSION = 180004;

let ready: Promise<unknown> | undefined;
async function parserReady(): Promise<void> {
  ready ??= loadModule();
  await ready;
}

function isNode(value: unknown): value is PgNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Statement nodes of `sql`, each keyed by its node kind (e.g. `UpdateStmt`). */
export async function parseStatements(sql: string): Promise<readonly PgNode[]> {
  await parserReady();
  const tree: any = await parse(sql);
  const stmts: unknown = tree?.stmts;
  if (!Array.isArray(stmts)) return [];
  return stmts
    .map((entry: unknown) => (isNode(entry) ? entry["stmt"] : undefined))
    .filter(isNode);
}

/** The node kind of a statement, e.g. `UpdateStmt`. */
export function nodeKind(stmt: PgNode): string | undefined {
  return Object.keys(stmt)[0];
}

export function child(
  node: PgNode | undefined,
  key: string,
): PgNode | undefined {
  if (!node) return undefined;
  const value = node[key];
  return isNode(value) ? value : undefined;
}

export function childList(
  node: PgNode | undefined,
  key: string,
): readonly PgNode[] {
  if (!node) return [];
  const value = node[key];
  return Array.isArray(value) ? value.filter(isNode) : [];
}

export function str(node: PgNode | undefined, key: string): string | undefined {
  if (!node) return undefined;
  const value = node[key];
  return typeof value === "string" ? value : undefined;
}

/** Whether a clause is present and non-empty. */
export function present(node: PgNode | undefined, key: string): boolean {
  if (!node) return false;
  const value = node[key];
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

/* -------------------------------------------------------------- builders */

export function columnRef(name: string): PgNode {
  return { ColumnRef: { fields: [{ String: { sval: name } }] } };
}

export function starRef(): PgNode {
  return { ColumnRef: { fields: [{ A_Star: {} }] } };
}

export function resTarget(value: PgNode, alias?: string): PgNode {
  return {
    ResTarget:
      alias === undefined ? { val: value } : { name: alias, val: value },
  };
}

const TEXT_TYPE: PgNode = {
  names: [{ String: { sval: "text" } }],
  typemod: -1,
};

export function castTo(value: PgNode, typeName: PgNode): PgNode {
  return { TypeCast: { arg: value, typeName } };
}

export function castToText(value: PgNode): PgNode {
  return castTo(value, TEXT_TYPE);
}

/**
 * Type names and integer literals are obtained by asking the parser for the
 * node, so the shape always matches the grammar and the type name is validated
 * as a side effect.
 */
const typeNames = new Map<string, PgNode>();

export async function typeName(type: string): Promise<PgNode> {
  const cached = typeNames.get(type);
  if (cached) return cached;

  const value = await pluckTargetValue(`SELECT NULL::${type}`);
  const cast = child(value, "TypeCast");
  const name = child(cast, "typeName");
  if (!name) {
    throw new PgPreviewError(`Could not resolve the column type "${type}".`);
  }
  typeNames.set(type, name);
  return name;
}

export async function intLiteral(value: number): Promise<PgNode> {
  const node = await pluckTargetValue(`SELECT ${Math.trunc(value)}`);
  if (!node) throw new PgPreviewError("Could not build an integer literal.");
  return node;
}

/**
 * The expression node of `expression`, obtained by asking the parser for it.
 * Used for column defaults, which arrive from the catalog as SQL text and have
 * to become nodes before they can join the derived read.
 */
export async function parseExpression(
  expression: string,
): Promise<PgNode | undefined> {
  return await pluckTargetValue(`SELECT (${expression})`);
}

async function pluckTargetValue(sql: string): Promise<PgNode | undefined> {
  await parserReady();
  let tree: any;
  try {
    tree = await parse(sql);
  } catch {
    return undefined;
  }
  const select = child(child(tree?.stmts?.[0], "stmt"), "SelectStmt");
  const first = childList(select, "targetList")[0];
  return child(child(first, "ResTarget"), "val");
}

/* -------------------------------------------------------------- deparse */

export interface SelectShape {
  readonly targetList: readonly PgNode[];
  /** A bare `RangeVar` body, as carried on `UpdateStmt.relation`. */
  readonly relation: PgNode;
  readonly where: PgNode;
  readonly limit?: PgNode;
}

/**
 * `UpdateStmt.relation` and `DeleteStmt.relation` hold a bare `RangeVar` body,
 * while a `fromClause` holds wrapped nodes. Unqualified names survive the
 * difference; a schema-qualified one deparses to an empty FROM, so wrap it.
 */
export async function deparseSelect(shape: SelectShape): Promise<string> {
  await parserReady();
  const select: Record<string, unknown> = {
    targetList: shape.targetList,
    fromClause: [{ RangeVar: shape.relation }],
    whereClause: shape.where,
    op: "SETOP_NONE",
    limitOption: shape.limit ? "LIMIT_OPTION_COUNT" : "LIMIT_OPTION_DEFAULT",
  };
  if (shape.limit) select["limitCount"] = shape.limit;

  const tree: any = {
    version: PG_VERSION,
    stmts: [{ stmt: { SelectStmt: select } }],
  };
  const sql: unknown = await deparse(tree);

  if (typeof sql !== "string") {
    throw new PgPreviewError("Could not deparse the derived read.");
  }
  return sql;
}

/**
 * `SELECT <targets>`, with no FROM. An INSERT names its rows literally, so its
 * derived read evaluates expressions rather than reading a table.
 */
export async function deparseTargets(
  targetList: readonly PgNode[],
): Promise<string> {
  await parserReady();
  const tree: any = {
    version: PG_VERSION,
    stmts: [
      {
        stmt: {
          SelectStmt: {
            targetList,
            op: "SETOP_NONE",
            limitOption: "LIMIT_OPTION_DEFAULT",
          },
        },
      },
    ],
  };
  const sql: unknown = await deparse(tree);
  if (typeof sql !== "string") {
    throw new PgPreviewError("Could not deparse the derived read.");
  }
  return sql;
}

/** `SELECT count(*) FROM <relation> WHERE <predicate>`, same predicate. */
export async function deparseCount(
  relation: PgNode,
  where: PgNode,
): Promise<string> {
  await parserReady();
  const tree: any = await parse(
    "SELECT count(*)::int AS n FROM pgp_t WHERE true",
  );
  const select = tree.stmts[0].stmt.SelectStmt;
  select.fromClause = [{ RangeVar: relation }];
  select.whereClause = where;

  const sql: unknown = await deparse(tree);
  if (typeof sql !== "string") {
    throw new PgPreviewError("Could not deparse the count query.");
  }
  return sql;
}
