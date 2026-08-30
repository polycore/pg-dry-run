/**
 * The only thing pgdryrun needs from a database: run parameterised SQL on a
 * session it has exclusive use of.
 *
 * Session affinity is not optional. Previews run inside
 * `BEGIN TRANSACTION READ ONLY` and applies inside `BEGIN`, so the statements of
 * one operation must land on one connection. A pooled `query()` that may hop
 * connections between calls would silently break both.
 *
 * Rows come back dynamically typed on purpose: a driver cannot know the shape of
 * an arbitrary query, so callers narrow at the point of use (see `row.ts`). The
 * interface is public so callers can supply an existing pool, and so tests can
 * run against a non-server Postgres.
 */

export type Row = Readonly<Record<string, unknown>>;

export type Sql = (
  text: string,
  params?: readonly unknown[],
) => Promise<readonly Row[]>;

export interface Driver {
  /** Run `fn` with exclusive use of one session, then release it. */
  session<T>(fn: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
