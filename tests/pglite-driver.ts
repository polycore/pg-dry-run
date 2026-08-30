import type { PGlite } from "@electric-sql/pglite";

import type { Driver, Row, Sql } from "../src/driver.js";

/**
 * Test driver over PGlite: real PostgreSQL semantics, in-process, no server.
 *
 * PGlite has a single backend, so sessions are serialised rather than pooled.
 * That satisfies the one guarantee the `Driver` contract actually needs, which
 * is that the statements of one operation share a session.
 */
export function pgliteDriver(db: PGlite): Driver {
  let queue: Promise<unknown> = Promise.resolve();

  return {
    session<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
      const sql: Sql = async (text, params = []) => {
        const result = await db.query<Row>(text, [...params]);
        return result.rows;
      };
      const run = queue.then(() => fn(sql));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    async close(): Promise<void> {
      await db.close();
    },
  };
}
