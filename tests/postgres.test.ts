import postgres from "postgres";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDryRunner,
  type DryRunner,
  postgresDriver,
  StateChangedError,
} from "../src/index.js";

/**
 * The one suite PGlite cannot stand in for.
 *
 * Everything else runs against PGlite, which is Postgres compiled to WASM, so
 * `xmin`, read-only transactions, triggers, and cascades all behave natively.
 * What it does not have is a second backend: its drift tests interleave a
 * writer sequentially and therefore prove the mechanism rather than the race.
 * They would pass just as happily if `xmin` were a counter this library
 * maintained itself.
 *
 * These tests use two independent connections to a real server, so the writer
 * genuinely runs between the preview and the apply. They also exercise
 * `postgresDriver` and a `SELECT`-only role, neither of which PGlite can reach:
 * it has no connection pool and no role system.
 *
 * Opt in by pointing at a scratch database:
 *
 *   PG_DRY_RUN_TEST_POSTGRES_URL=postgres://localhost/postgres pnpm test
 *
 * Without it the suite reports as skipped rather than passing quietly.
 */
const url = process.env["PG_DRY_RUN_TEST_POSTGRES_URL"] ?? "";

// Not `pg_dry_run_it`: PostgreSQL reserves the `pg_` prefix for system schemas
// and system roles, and rejects both outright.
const SCHEMA = "dry_run_it";

describe.runIf(url !== "")("against a real Postgres server", () => {
  // Two connections that know nothing about each other: the dry runner's, and
  // the one standing in for whoever else is writing to your database.
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  const other = postgres(url, { max: 1, onnotice: () => undefined });
  const pg: DryRunner = createDryRunner({ driver: postgresDriver(url) });

  beforeEach(async () => {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.unsafe(`CREATE SCHEMA ${SCHEMA}`);
    await admin.unsafe(`
      CREATE TABLE ${SCHEMA}.profiles (
        id     bigserial PRIMARY KEY,
        email  text UNIQUE NOT NULL,
        status text NOT NULL DEFAULT 'active'
      );
      INSERT INTO ${SCHEMA}.profiles (email) VALUES
        ('alice@acme.com'), ('bob@acme.com'), ('carol@acme.com');
    `);
  });

  afterAll(async () => {
    await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pg.close();
    await admin.end({ timeout: 5 });
    await other.end({ timeout: 5 });
  });

  const statusOf = async (email: string): Promise<string> => {
    const rows = await admin.unsafe<{ status: string }[]>(
      `SELECT status FROM ${SCHEMA}.profiles WHERE email = $1`,
      [email],
    );
    return rows[0]?.status ?? "missing";
  };

  it("rejects the apply when another connection moved a previewed row", async () => {
    const proposal = await pg.propose(
      `UPDATE ${SCHEMA}.profiles SET status = $1 WHERE email LIKE $2`,
      ["suspended", "%@acme.com"],
    );
    expect(proposal.rowCount).toBe(3);

    // A genuinely separate backend, committing between propose and apply.
    await other.unsafe(
      `UPDATE ${SCHEMA}.profiles SET status = 'vip' WHERE email = $1`,
      ["bob@acme.com"],
    );

    await expect(pg.apply(proposal)).rejects.toThrow(StateChangedError);

    // The whole apply rolled back, not just the row that moved.
    expect(await statusOf("alice@acme.com")).toBe("active");
    expect(await statusOf("bob@acme.com")).toBe("vip");
    expect(await statusOf("carol@acme.com")).toBe("active");
  });

  it("names the row that moved and its current version", async () => {
    const proposal = await pg.propose(
      `UPDATE ${SCHEMA}.profiles SET status = $1 WHERE email LIKE $2`,
      ["suspended", "%@acme.com"],
    );
    await other.unsafe(
      `UPDATE ${SCHEMA}.profiles SET status = 'vip' WHERE email = $1`,
      ["carol@acme.com"],
    );

    const error = await pg.apply(proposal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StateChangedError);
    const drifted = (error as StateChangedError).drifted;
    expect(drifted).toHaveLength(1);
    expect(drifted[0]?.reason).toBe("modified");
    expect(drifted[0]?.currentVersion).not.toBeNull();
  });

  it("reports a concurrently deleted row as missing", async () => {
    const proposal = await pg.propose(
      `UPDATE ${SCHEMA}.profiles SET status = $1 WHERE email LIKE $2`,
      ["suspended", "%@acme.com"],
    );
    await other.unsafe(`DELETE FROM ${SCHEMA}.profiles WHERE email = $1`, [
      "bob@acme.com",
    ]);

    const error = await pg.apply(proposal).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StateChangedError);
    const drifted = (error as StateChangedError).drifted;
    expect(drifted).toHaveLength(1);
    expect(drifted[0]?.reason).toBe("missing");
    expect(drifted[0]?.currentVersion).toBeNull();
  });

  it("applies when the concurrent write touched a row outside the preview", async () => {
    const proposal = await pg.propose(
      `UPDATE ${SCHEMA}.profiles SET status = $1 WHERE email = $2`,
      ["suspended", "alice@acme.com"],
    );
    await other.unsafe(
      `UPDATE ${SCHEMA}.profiles SET status = 'vip' WHERE email = $1`,
      ["carol@acme.com"],
    );

    const receipt = await pg.apply(proposal);
    expect(receipt.rowsAffected).toBe(1);
    expect(await statusOf("alice@acme.com")).toBe("suspended");
    expect(await statusOf("carol@acme.com")).toBe("vip");
  });

  it("does not grow the approved set when a new row starts matching", async () => {
    const proposal = await pg.propose(
      `UPDATE ${SCHEMA}.profiles SET status = $1 WHERE email LIKE $2`,
      ["suspended", "%@acme.com"],
    );
    expect(proposal.rowCount).toBe(3);

    // Now matching the predicate, but not part of what anyone approved.
    await other.unsafe(`INSERT INTO ${SCHEMA}.profiles (email) VALUES ($1)`, [
      "dave@acme.com",
    ]);

    const receipt = await pg.apply(proposal);
    expect(receipt.rowsAffected).toBe(3);
    expect(await statusOf("dave@acme.com")).toBe("active");
  });

  it("previews through a SELECT-only role, and that role cannot write", async () => {
    const role = "dry_run_it_reader";
    const password = "dry_run_it_pw";
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
    await admin.unsafe(`GRANT USAGE ON SCHEMA ${SCHEMA} TO ${role}`);
    await admin.unsafe(
      `GRANT SELECT ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${role}`,
    );

    const readUrl = new URL(url);
    readUrl.username = role;
    readUrl.password = password;

    const split = createDryRunner({
      driver: postgresDriver(url),
      readDriver: postgresDriver(readUrl.toString()),
    });

    try {
      // The preview reads through the least-privileged connection...
      const proposal = await split.propose(
        `UPDATE ${SCHEMA}.profiles SET status = $1 WHERE email = $2`,
        ["suspended", "alice@acme.com"],
      );
      expect(proposal.rowCount).toBe(1);

      // ...and that connection is write-incapable by privilege, not by this
      // library being careful. PGlite has no roles, so nothing else proves it.
      const reader = postgres(readUrl.toString(), {
        max: 1,
        onnotice: () => undefined,
      });
      try {
        await expect(
          reader.unsafe(`UPDATE ${SCHEMA}.profiles SET status = 'x'`),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await reader.end({ timeout: 5 });
      }

      // The apply still goes through the writing connection.
      const receipt = await split.apply(proposal);
      expect(receipt.rowsAffected).toBe(1);
      expect(await statusOf("alice@acme.com")).toBe("suspended");
    } finally {
      await split.close();
      await admin.unsafe(
        `REVOKE ALL ON ALL TABLES IN SCHEMA ${SCHEMA} FROM ${role}`,
      );
      await admin.unsafe(`REVOKE USAGE ON SCHEMA ${SCHEMA} FROM ${role}`);
      await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    }
  });
});
