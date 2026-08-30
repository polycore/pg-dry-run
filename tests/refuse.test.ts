import { afterAll, describe, expect, it } from "vitest";

import { UnsupportedStatementError } from "../src/index.js";
import { type Harness, harness } from "./fixtures.js";

/**
 * Refusal is a feature. An approximate diff is worse than no diff because it
 * manufactures confidence, so anything the rewriter cannot transform faithfully
 * must fail loudly rather than produce a partial answer.
 */
let h: Harness;
const setup = async () => (h ??= await harness());
afterAll(async () => h && (await h.close()));

async function reason(statement: string): Promise<string> {
  const { pg } = await setup();
  try {
    await pg.propose(statement);
  } catch (error) {
    expect(error).toBeInstanceOf(UnsupportedStatementError);
    return (error as UnsupportedStatementError).reason;
  }
  throw new Error(`expected a refusal for: ${statement}`);
}

describe("refuses what it cannot preview faithfully", () => {
  it("refuses statements that are not INSERT, UPDATE or DELETE", async () => {
    expect(await reason("SELECT 1")).toBe("unsupported_statement");
    expect(await reason("DROP TABLE profiles")).toBe("unsupported_statement");
    expect(await reason("TRUNCATE profiles")).toBe("unsupported_statement");
  });

  it("refuses data-modifying CTEs, whose real effect is not one table", async () => {
    expect(
      await reason(
        `WITH gone AS (DELETE FROM sessions RETURNING *)
         INSERT INTO audit_log (note) SELECT 'x' FROM gone`,
      ),
    ).toBe("multi_table");
  });

  it("refuses upserts, whose effect on a conflicting row is invisible", async () => {
    expect(
      await reason(
        `INSERT INTO workspaces (id, name) VALUES ('ws_881', 'dup')
           ON CONFLICT (id) DO UPDATE SET name = 'dup'`,
      ),
    ).toBe("unsupported_clause");
    expect(
      await reason(
        `INSERT INTO workspaces (id, name) VALUES ('ws_881', 'dup')
           ON CONFLICT DO NOTHING`,
      ),
    ).toBe("unsupported_clause");
  });

  it("refuses an INSERT whose rows come from a query rather than a VALUES list", async () => {
    expect(
      await reason(
        `INSERT INTO audit_log (note) SELECT email FROM profiles WHERE status = 'active'`,
      ),
    ).toBe("unsupported_clause");
  });

  it("refuses writing a column the database owns", async () => {
    expect(
      await reason(`INSERT INTO widgets (name, total) VALUES ('bolt', 10)`),
    ).toBe("unresolvable_assignment");
  });

  it("refuses an INSERT that names the same column twice", async () => {
    expect(
      await reason(`INSERT INTO workspaces (id, id) VALUES ('ws_9', 'ws_8')`),
    ).toBe("unresolvable_assignment");
  });

  it("refuses an INSERT whose row does not match its column list", async () => {
    expect(
      await reason(`INSERT INTO workspaces (id, name) VALUES ('ws_9')`),
    ).toBe("unresolvable_assignment");
    expect(await reason(`INSERT INTO audit_log (nope) VALUES ('x')`)).toBe(
      "unresolvable_assignment",
    );
  });

  it("refuses a missing WHERE clause, which would name every row", async () => {
    expect(await reason("UPDATE profiles SET status = 'x'")).toBe(
      "missing_where",
    );
    expect(await reason("DELETE FROM profiles")).toBe("missing_where");
  });

  it("refuses multi-table forms it cannot attribute to one relation", async () => {
    expect(
      await reason(
        `UPDATE profiles SET status = 'x' FROM workspaces w WHERE profiles.workspace_id = w.id`,
      ),
    ).toBe("multi_table");
    expect(
      await reason(
        `DELETE FROM profiles USING workspaces w WHERE profiles.workspace_id = w.id`,
      ),
    ).toBe("multi_table");
    expect(
      await reason(
        `WITH x AS (SELECT 1) UPDATE profiles SET status = 'x' WHERE email = 'a'`,
      ),
    ).toBe("multi_table");
  });

  it("refuses more than one statement", async () => {
    expect(
      await reason(
        `UPDATE profiles SET status = 'x' WHERE email = 'a'; DROP TABLE profiles`,
      ),
    ).toBe("not_a_single_statement");
  });

  it("refuses a table with no primary key, since rows could not be pinned", async () => {
    expect(
      await reason("UPDATE keyless SET value = 'x' WHERE value = 'y'"),
    ).toBe("no_primary_key");
  });

  it("refuses assignment to a column that does not exist", async () => {
    expect(
      await reason("UPDATE profiles SET nope = 'x' WHERE email = 'a@acme.com'"),
    ).toBe("unresolvable_assignment");
  });

  it("refuses assignment to a subfield", async () => {
    expect(await reason("UPDATE widgets SET tags[1] = 'x' WHERE id = 1")).toBe(
      "unresolvable_assignment",
    );
  });

  it("reports a relation that does not exist", async () => {
    expect(await reason("UPDATE nonexistent SET a = 'x' WHERE b = 'y'")).toBe(
      "no_primary_key",
    );
  });
});
