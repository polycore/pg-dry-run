import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { countWhere, type Harness, harness } from "./fixtures.js";

/**
 * A preview must never imply completeness it does not have. Everything the
 * derived read cannot see has to be named, not buried in documentation.
 */
let h: Harness;
beforeEach(async () => {
  h ??= await harness();
  await h.reset();
});
afterAll(async () => h && (await h.close()));

const codes = (warnings: readonly { code: string }[]) =>
  warnings.map((w) => w.code);

describe("warnings", () => {
  it("names a BEFORE trigger that could change the values written", async () => {
    const p = await h.pg.propose(
      "UPDATE profiles SET status = $1 WHERE email = $2",
      ["suspended", "alice@acme.com"],
    );
    const trigger = p.warnings.find((w) => w.code === "trigger");
    expect(trigger).toBeDefined();
    expect(trigger!.message).toContain("touch_updated_at");
    expect(trigger!.message).toMatch(/values actually written/);
  });

  it("does not warn about a trigger that cannot fire for this statement", async () => {
    // touch_updated_at is UPDATE-only, so a DELETE preview must stay quiet
    await h.db.exec(`DELETE FROM memberships`);
    const p = await h.pg.propose("DELETE FROM profiles WHERE email = $1", [
      "alice@acme.com",
    ]);
    expect(codes(p.warnings)).not.toContain("trigger");
  });

  it("proves the trigger warning is not theoretical", async () => {
    const p = await h.pg.propose(
      "UPDATE profiles SET status = $1 WHERE email = $2",
      ["suspended", "alice@acme.com"],
    );
    // preview shows updated_at unchanged, because it is not assigned
    expect(p.changes[0]!.fields.map((f) => f.column)).toEqual(["status"]);

    await h.pg.apply(p);
    // ...but the trigger moved it anyway, which is exactly what we warned about
    expect(
      await countWhere(
        h.db,
        `FROM profiles WHERE email = 'alice@acme.com' AND updated_at > '2020-06-01'`,
      ),
    ).toBe(1);
  });

  it("names a generated column that will be recomputed", async () => {
    await h.db.exec(
      `INSERT INTO widgets (name, qty, price) VALUES ('bolt', 2, 3.00)`,
    );
    const p = await h.pg.propose(
      "UPDATE widgets SET qty = $1 WHERE name = $2",
      [10, "bolt"],
    );
    const warning = p.warnings.find((w) => w.code === "generated_column");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("total");
  });

  it("warns when an assignment touches a unique column", async () => {
    const p = await h.pg.propose(
      "UPDATE profiles SET email = $1 WHERE email = $2",
      ["renamed@acme.com", "alice@acme.com"],
    );
    const warning = p.warnings.find((w) => w.code === "unique_column_touched");
    expect(warning).toBeDefined();
    expect(warning!.message).toContain("email");
  });

  it("does not warn about uniqueness when the assignment avoids it", async () => {
    const p = await h.pg.propose(
      "UPDATE profiles SET status = $1 WHERE email = $2",
      ["suspended", "alice@acme.com"],
    );
    expect(codes(p.warnings)).not.toContain("unique_column_touched");
  });

  it("stays quiet on a table with nothing to declare", async () => {
    const p = await h.pg.propose(
      "UPDATE ops.tickets SET state = $1 WHERE id = $2",
      ["closed", 1],
    );
    expect(p.warnings).toEqual([]);
  });
});
