import { defineConfig } from "vitest/config";

/**
 * pgpreview tests run against real PostgreSQL semantics via PGlite (Postgres
 * compiled to WASM), in-process and hermetic: no server, no container, no
 * fixtures on disk. That matters because the guarantees under test are
 * Postgres behaviours, not our own: `xmin` changing on every row version,
 * read-only transactions rejecting writes, and `ON DELETE CASCADE` reach.
 */
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 30_000,
  },
});
