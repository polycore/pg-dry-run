import {
  childForeignKeys,
  primaryKeyColumns,
  qualify,
  quoteIdent,
  type Relation,
} from "./catalog.js";
import type { Sql } from "./driver.js";
import { integer, optionalText } from "./row.js";
import type { CascadeNode, TableRef, Warning } from "./types.js";

export interface CascadeOptions {
  /** How deep to follow the graph. */
  readonly maxDepth: number;
  /**
   * Stop descending past this many rows at one level. Counting stays exact; only
   * the recursion below a very wide level is skipped, and that is reported
   * rather than silently dropped.
   */
  readonly maxKeysPerLevel: number;
}

export interface CascadeResult {
  readonly nodes: readonly CascadeNode[];
  readonly warnings: readonly Warning[];
}

/** Values of one column for the rows matched at the level above. */
type ValueSource = (column: string) => Promise<readonly string[]>;

/**
 * Walk the foreign keys that point at the target, using reads only.
 *
 * A DELETE that names one row can remove thousands through `ON DELETE CASCADE`,
 * and the derived read cannot see any of them: it selects from one table. This
 * is the part of a delete preview that is usually missing and usually matters
 * most.
 */
export async function walkCascade(
  sql: Sql,
  relation: Relation,
  rootValues: ValueSource,
  options: CascadeOptions,
): Promise<CascadeResult> {
  const nodes: CascadeNode[] = [];
  const warnings: Warning[] = [];
  // One warning per constraint and per stopping point, however many levels of
  // the walk arrive at the same place.
  const reported = new Set<string>();

  await descend(relation, rootValues, 0, new Set([relation.oid]));

  return { nodes, warnings };

  function warnOnce(key: string, warning: Warning): void {
    if (reported.has(key)) return;
    reported.add(key);
    warnings.push(warning);
  }

  async function descend(
    parent: Relation,
    valuesFor: ValueSource,
    depth: number,
    path: ReadonlySet<number>,
  ): Promise<void> {
    // A truncated count reads exactly like a complete one, so stopping has to
    // say so. The breadth cutoff below already did; this is the depth cutoff.
    if (depth > options.maxDepth) {
      warnOnce(`depth:${parent.oid}`, {
        code: "cascade_depth_truncated",
        message:
          `${qualify(parent.ref)} is ${depth} level(s) from the target, past the ` +
          `cascade depth limit of ${options.maxDepth}. Tables cascading from it ` +
          `are not counted.`,
      });
      return;
    }

    const { followable, composite } = await childForeignKeys(sql, parent);

    // A tuple match is not expressible as the one-column-against-a-list read
    // this walk uses, so a composite key is named rather than followed. It used
    // to be filtered out in SQL, which under-reported the delete's reach with
    // nothing on the proposal to say so.
    for (const fk of composite) {
      warnOnce(`composite:${fk.constraint}`, {
        code: "composite_foreign_key_skipped",
        message:
          `${qualify(fk.child)} references this target through the multi-column ` +
          `foreign key ${fk.constraint} (${fk.columns.join(", ")}), which this ` +
          `preview cannot follow. Rows it would reach are not counted.`,
      });
    }

    for (const fk of followable) {
      const parentValues = await valuesFor(fk.parentColumn);
      if (parentValues.length === 0) continue;

      const rowCount = await countReferencing(
        fk.child,
        fk.column,
        parentValues,
      );
      if (rowCount === 0) continue;

      nodes.push({
        depth,
        table: fk.child,
        via: fk.column,
        action: fk.action,
        rowCount,
      });

      if (fk.action === "restrict" || fk.action === "no action") {
        warnings.push({
          code: "restrict_blocks_delete",
          message:
            `${qualify(fk.child)} has ${rowCount} row(s) referencing this target ` +
            `via ${fk.column} with ON DELETE ${fk.action.toUpperCase()}. The ` +
            `delete will fail unless those rows are removed first.`,
        });
        continue;
      }

      if (fk.action !== "cascade") continue;
      if (path.has(fk.childOid)) continue;

      if (rowCount > options.maxKeysPerLevel) {
        warnings.push({
          code: "cascade_depth_truncated",
          message:
            `${qualify(fk.child)} has ${rowCount} cascading row(s), above the ` +
            `${options.maxKeysPerLevel} row limit for descending further. Tables ` +
            `cascading from it are not counted.`,
        });
        continue;
      }

      const child: Relation = { oid: fk.childOid, ref: fk.child };
      if (!(await hasPrimaryKey(child))) continue;

      await descend(
        child,
        valuesOf(child.ref, fk.column, parentValues),
        depth + 1,
        new Set([...path, fk.childOid]),
      );
    }
  }

  /**
   * A child without a primary key can still be counted, but cannot be descended
   * through, because there is no stable handle for its rows.
   */
  async function hasPrimaryKey(relation: Relation): Promise<boolean> {
    try {
      await primaryKeyColumns(sql, relation);
      return true;
    } catch {
      return false;
    }
  }

  async function countReferencing(
    child: TableRef,
    column: string,
    parentValues: readonly string[],
  ): Promise<number> {
    const rows = await sql(
      `SELECT count(*)::int AS n FROM ${qualify(child)}
        WHERE ${quoteIdent(column)}::text = ANY($1::text[])`,
      [[...parentValues]],
    );
    const row = rows[0];
    return row === undefined ? 0 : integer(row, "n");
  }

  /** Lazily read one column of the rows matched at this level. */
  function valuesOf(
    child: TableRef,
    column: string,
    parentValues: readonly string[],
  ): ValueSource {
    const cache = new Map<string, readonly string[]>();
    return async (wanted) => {
      const hit = cache.get(wanted);
      if (hit) return hit;
      const rows = await sql(
        `SELECT DISTINCT ${quoteIdent(wanted)}::text AS v FROM ${qualify(child)}
          WHERE ${quoteIdent(column)}::text = ANY($1::text[])`,
        [[...parentValues]],
      );
      const values = rows
        .map((row) => optionalText(row, "v"))
        .filter((value): value is string => value !== null);
      cache.set(wanted, values);
      return values;
    };
  }
}
