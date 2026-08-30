import postgres from "postgres";

import type { Driver, Row, Sql } from "./driver.js";

export interface PostgresDriverOptions {
  /** Pool size. Two is plenty: one preview or apply runs at a time. */
  readonly max?: number;
  readonly connectTimeoutSeconds?: number;
}

/**
 * The default driver, over `postgres` (postgres.js).
 *
 * `reserve()` is what makes this correct: every statement of one operation runs
 * on the same connection, so `BEGIN TRANSACTION READ ONLY`, `SET LOCAL`, and
 * `ROLLBACK` apply to the work between them.
 */
export function postgresDriver(
  url: string,
  options: PostgresDriverOptions = {},
): Driver {
  const pg = postgres(url, {
    max: options.max ?? 2,
    connect_timeout: options.connectTimeoutSeconds ?? 10,
    prepare: false,
    // Notices are not part of this library's contract; drop them.
    onnotice: () => undefined,
  });

  return {
    async session<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
      const reserved = await pg.reserve();
      const sql: Sql = async (text, params = []) =>
        await reserved.unsafe<Row[]>(text, params as never[]);
      try {
        return await fn(sql);
      } finally {
        reserved.release();
      }
    },
    async close(): Promise<void> {
      await pg.end({ timeout: 5 });
    },
  };
}
