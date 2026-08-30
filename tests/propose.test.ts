import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { TooManyRowsError } from "../src/index.js";
import { countWhere, type Harness, harness } from "./fixtures.js";

let h: Harness;
beforeEach(async () => {
  h ??= await harness();
  await h.reset();
});
afterAll(async () => h && (await h.close()));

describe("propose", () => {
  it("names every row the predicate matches, not the one you expected", async () => {
    const p = await h.pg.propose(
      "UPDATE profiles SET status = $1 WHERE email LIKE $2",
      ["suspended", "%@acme.com"],
    );

    expect(p.kind).toBe("update");
    expect(p.table).toEqual({ schema: "public", name: "profiles" });
    expect(p.rowCount).toBe(5);
    expect(p.changes).toHaveLength(5);
  });

  it("carries a human-recognisable label so the rows can be recognised", async () => {
    const p = await h.pg.propose(
      "UPDATE profiles SET status = 'suspended' WHERE email LIKE '%@acme.com'",
    );
    expect(p.changes.map((c) => c.label).sort()).toEqual([
      "alice@acme.com",
      "bob@acme.com",
      "carol@acme.com",
      "ci-bot@acme.com",
      "intern-2024@acme.com",
    ]);
  });

  it("reports before and after per column", async () => {
    const p = await h.pg.propose(
      "UPDATE profiles SET status = $1 WHERE email = $2",
      ["suspended", "alice@acme.com"],
    );
    expect(p.changes[0]!.fields).toEqual([
      { column: "status", before: "active", after: "suspended" },
    ]);
  });

  it("evaluates assigned expressions rather than echoing them", async () => {
    const p = await h.pg.propose(
      "UPDATE widgets SET qty = qty + 10 WHERE id = $1",
      [1],
    );
    expect(p.rowCount).toBe(0); // no widgets seeded

    await h.db.exec(`INSERT INTO widgets (name, qty) VALUES ('bolt', 5)`);
    const q = await h.pg.propose(
      "UPDATE widgets SET qty = qty + 10 WHERE name = $1",
      ["bolt"],
    );
    expect(q.changes[0]!.fields).toEqual([
      { column: "qty", before: "5", after: "15" },
    ]);
  });

  it("writes nothing, and leaves no transaction behind", async () => {
    const before = await countWhere(
      h.db,
      `FROM profiles WHERE status = 'active'`,
    );
    await h.pg.propose(
      "UPDATE profiles SET status = 'suspended' WHERE email LIKE '%@acme.com'",
    );
    await h.pg.propose("DELETE FROM profiles WHERE email LIKE '%@acme.com'");
    expect(
      await countWhere(h.db, `FROM profiles WHERE status = 'active'`),
    ).toBe(before);
    // the session is still usable, so the read-only transaction was closed
    expect(await countWhere(h.db, `FROM profiles`)).toBe(6);
  });

  it("exposes the derived read for inspection", async () => {
    const p = await h.pg.propose(
      "UPDATE profiles SET status = $1 WHERE email LIKE $2",
      ["suspended", "%@acme.com"],
    );
    expect(p.derivedSql).toMatch(/^SELECT/);
    expect(p.derivedSql).toContain("xmin");
    expect(p.derivedSql).toContain("FROM profiles");
    expect(p.derivedSql).not.toMatch(/\bUPDATE\b/);
  });

  it("handles a zero-row match as a real result, not an error", async () => {
    const p = await h.pg.propose(
      "UPDATE profiles SET status = 'x' WHERE email = 'nobody@nowhere.test'",
    );
    expect(p.rowCount).toBe(0);
    expect(p.changes).toEqual([]);
  });

  it("resolves a schema-qualified relation", async () => {
    const p = await h.pg.propose(
      "UPDATE ops.tickets SET state = $1 WHERE state = $2",
      ["closed", "open"],
    );
    expect(p.table).toEqual({ schema: "ops", name: "tickets" });
    expect(p.rowCount).toBe(2);
  });

  it("supports a composite primary key", async () => {
    const p = await h.pg.propose(
      "UPDATE memberships SET role = $1 WHERE role = $2",
      ["admin", "member"],
    );
    expect(p.plan.keyColumns).toEqual(["workspace_id", "user_id"]);
    expect(Object.keys(p.changes[0]!.key)).toEqual(["workspace_id", "user_id"]);
    expect(p.rowCount).toBe(5);
  });

  it("is JSON-serialisable, because a proposal crosses process boundaries", async () => {
    const p = await h.pg.propose(
      "UPDATE profiles SET status = $1 WHERE email LIKE $2",
      ["suspended", "%@acme.com"],
    );
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  describe("enumeration limit", () => {
    it("refuses to name more rows than a human could review", async () => {
      const small = await harness({ maxRows: 3 });
      try {
        await expect(
          small.pg.propose(
            "UPDATE profiles SET status = 'x' WHERE email LIKE '%@acme.com'",
          ),
        ).rejects.toThrow(TooManyRowsError);
      } finally {
        await small.close();
      }
    });

    it("reports the exact count it refused", async () => {
      const small = await harness({ maxRows: 2 });
      try {
        await small.pg
          .propose(
            "UPDATE profiles SET status = 'x' WHERE email LIKE '%@acme.com'",
          )
          .then(
            () => expect.unreachable("should have refused"),
            (error: unknown) => {
              expect(error).toBeInstanceOf(TooManyRowsError);
              expect((error as TooManyRowsError).rowCount).toBe(5);
              expect((error as TooManyRowsError).limit).toBe(2);
            },
          );
      } finally {
        await small.close();
      }
    });

    it("allows exactly the limit", async () => {
      const exact = await harness({ maxRows: 5 });
      try {
        const p = await exact.pg.propose(
          "UPDATE profiles SET status = 'x' WHERE email LIKE '%@acme.com'",
        );
        expect(p.rowCount).toBe(5);
      } finally {
        await exact.close();
      }
    });
  });
});
