import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { type Proposal, TooManyRowsError } from "../src/index.js";
import { countWhere, type Harness, harness } from "./fixtures.js";

/**
 * An insert has no rows to find, so the thing worth previewing is the half of
 * each row the statement does not mention: the defaults the table fills in, the
 * keys the database assigns, and the columns that will make the insert fail.
 */
let h: Harness;
beforeEach(async () => {
  h ??= await harness();
  await h.reset();
});
afterAll(async () => h && (await h.close()));

const codes = (warnings: readonly { code: string }[]): readonly string[] =>
  warnings.map((w) => w.code);

const columns = (p: Proposal, row = 0): readonly string[] =>
  (p.changes[row]?.fields ?? []).map((f) => f.column);

function valueOf(p: Proposal, column: string, row = 0): string | null {
  const field = p.changes[row]?.fields.find((f) => f.column === column);
  if (field === undefined) throw new Error(`no field for ${column}`);
  return field.after;
}

async function rowsOf(
  table: string,
): Promise<readonly Record<string, unknown>[]> {
  const res = await h.db.query<Record<string, unknown>>(
    `SELECT * FROM ${table} ORDER BY 1`,
  );
  return res.rows;
}

describe("propose", () => {
  it("resolves the whole row, not just the columns the statement names", async () => {
    const p = await h.pg.propose(
      "INSERT INTO profiles (workspace_id, email) VALUES ($1, $2)",
      ["ws_881", "new@acme.com"],
    );

    expect(p.kind).toBe("insert");
    expect(p.table).toEqual({ schema: "public", name: "profiles" });
    expect(p.rowCount).toBe(1);
    // status and updated_at appear because the table supplies them, which is
    // exactly what an approver reading the statement would not know.
    expect(columns(p)).toEqual([
      "id",
      "workspace_id",
      "email",
      "status",
      "updated_at",
    ]);
    expect(valueOf(p, "status")).toBe("active");
    expect(valueOf(p, "updated_at")).toBe("2020-01-01 00:00:00+00");
    expect(p.changes[0]!.fields.every((f) => f.before === null)).toBe(true);
  });

  it("names the key when it can compute one", async () => {
    const p = await h.pg.propose(
      "INSERT INTO profiles (workspace_id, email) VALUES ($1, $2)",
      ["ws_881", "new@acme.com"],
    );
    // gen_random_uuid() is volatile but not a write, so it runs in the preview
    // and the key is known before the approval.
    expect(p.changes[0]!.key["id"]).toBe(valueOf(p, "id"));
    expect(p.changes[0]!.key["id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("carries a label so the new row can be recognised", async () => {
    const p = await h.pg.propose(
      "INSERT INTO profiles (workspace_id, email) VALUES ($1, $2)",
      ["ws_881", "new@acme.com"],
    );
    expect(p.changes[0]!.label).toBe("new@acme.com");
  });

  it("leaves a key the database assigns out of the diff, and says so", async () => {
    const p = await h.pg.propose(
      "INSERT INTO ops.tickets (title) VALUES ($1)",
      ["printer on fire again"],
    );

    expect(p.table).toEqual({ schema: "ops", name: "tickets" });
    expect(columns(p)).toEqual(["title", "state"]);
    expect(p.changes[0]!.key).toEqual({});
    const warning = p.warnings.find((w) => w.code === "deferred_default");
    expect(warning?.message).toContain("id");
  });

  it("has no version to pin, because the row does not exist yet", async () => {
    const p = await h.pg.propose(
      "INSERT INTO ops.tickets (title) VALUES ('x')",
    );
    expect(p.changes[0]!.version).toBeNull();
    expect(p.cascades).toEqual([]);
  });

  it("counts every row of a multi-row insert", async () => {
    const p = await h.pg.propose(
      `INSERT INTO ops.tickets (title, state)
       VALUES ($1, 'open'), ($2, 'closed'), ($3, 'open')`,
      ["one", "two", "three"],
    );
    expect(p.rowCount).toBe(3);
    expect(
      p.changes.map((c) => valueOf(p, "title", p.changes.indexOf(c))),
    ).toEqual(["one", "two", "three"]);
  });

  it("resolves the DEFAULT keyword per row, next to rows that supply a value", async () => {
    const p = await h.pg.propose(
      `INSERT INTO ops.tickets (title, state) VALUES ($1, DEFAULT), ($2, $3)`,
      ["defaulted", "explicit", "closed"],
    );
    expect(valueOf(p, "state", 0)).toBe("open");
    expect(valueOf(p, "state", 1)).toBe("closed");
  });

  it("maps values positionally when the statement names no columns", async () => {
    const p = await h.pg.propose(
      "INSERT INTO workspaces VALUES ($1, $2, 'enterprise')",
      ["ws_003", "Third Co"],
    );
    expect(columns(p)).toEqual(["id", "name", "plan"]);
    expect(valueOf(p, "plan")).toBe("enterprise");
  });

  it("previews an insert with nothing to evaluate", async () => {
    const p = await h.pg.propose("INSERT INTO audit_log DEFAULT VALUES");
    expect(p.rowCount).toBe(1);
    expect(p.changes[0]!.fields).toEqual([]);
    expect(p.derivedSql).toContain("database default");
  });

  it("exposes the derived read, which reads no table and writes nothing", async () => {
    const p = await h.pg.propose(
      "INSERT INTO ops.tickets (title) VALUES ($1)",
      ["x"],
    );
    expect(p.derivedSql).toMatch(/^SELECT/);
    expect(p.derivedSql).not.toMatch(/\bINSERT\b/);
    expect(p.derivedSql).toContain("'open'");
  });

  it("writes nothing during the preview", async () => {
    await h.pg.propose("INSERT INTO ops.tickets (title) VALUES ('ghost')");
    expect(await countWhere(h.db, `FROM ops.tickets`)).toBe(2);
  });

  it("is JSON-serialisable, because a proposal crosses process boundaries", async () => {
    const p = await h.pg.propose(
      "INSERT INTO profiles (workspace_id, email) VALUES ($1, $2)",
      ["ws_881", "new@acme.com"],
    );
    expect(JSON.parse(JSON.stringify(p))).toEqual(p);
  });

  it("refuses to name more rows than a human could review", async () => {
    const small = await harness({ maxRows: 2 });
    try {
      await small.pg
        .propose(`INSERT INTO ops.tickets (title) VALUES ('a'), ('b'), ('c')`)
        .then(
          () => expect.unreachable("should have refused"),
          (error: unknown) => {
            expect(error).toBeInstanceOf(TooManyRowsError);
            expect((error as TooManyRowsError).rowCount).toBe(3);
          },
        );
    } finally {
      await small.close();
    }
  });
});

describe("apply", () => {
  it("writes exactly the values that were previewed", async () => {
    const p = await h.pg.propose(
      "INSERT INTO profiles (workspace_id, email) VALUES ($1, $2)",
      ["ws_881", "new@acme.com"],
    );
    const receipt = await h.pg.apply(p);

    expect(receipt.rowsAffected).toBe(1);
    expect(receipt.proposalId).toBe(p.id);

    const stored = await h.db.query<Record<string, string>>(
      `SELECT id::text, workspace_id, email, status, updated_at::text
         FROM profiles WHERE email = $1`,
      ["new@acme.com"],
    );
    expect(stored.rows[0]).toEqual({
      id: valueOf(p, "id"),
      workspace_id: "ws_881",
      email: "new@acme.com",
      status: "active",
      updated_at: valueOf(p, "updated_at"),
    });
  });

  it("returns the key the database generated, which the preview could not", async () => {
    const p = await h.pg.propose(
      "INSERT INTO ops.tickets (title) VALUES ($1)",
      ["new ticket"],
    );
    const receipt = await h.pg.apply(p);

    expect(receipt.keys).toHaveLength(1);
    expect(receipt.keys[0]!["id"]).toMatch(/^\d+$/);
    expect(
      await countWhere(
        h.db,
        `FROM ops.tickets WHERE id = ${receipt.keys[0]!["id"]}`,
      ),
    ).toBe(1);
  });

  it("writes every row of a multi-row insert, and only those", async () => {
    const p = await h.pg.propose(
      `INSERT INTO ops.tickets (title) VALUES ($1), ($2)`,
      ["one", "two"],
    );
    const receipt = await h.pg.apply(p);

    expect(receipt.rowsAffected).toBe(2);
    expect(await countWhere(h.db, `FROM ops.tickets`)).toBe(4);
  });

  it("cannot be applied twice, because the proposal is taken by the first", async () => {
    const p = await h.pg.propose(
      "INSERT INTO ops.tickets (title) VALUES ('x')",
    );
    await h.pg.apply(p);
    // The dry runner itself holds nothing; re-applying the same document would
    // insert a second row, so callers own single use. The runner's held-proposal
    // map is what enforces it end to end.
    expect(await countWhere(h.db, `FROM ops.tickets`)).toBe(3);
  });

  it("writes an all-defaults row", async () => {
    const p = await h.pg.propose("INSERT INTO audit_log DEFAULT VALUES");
    const receipt = await h.pg.apply(p);

    expect(receipt.rowsAffected).toBe(1);
    expect(receipt.keys[0]!["id"]).toMatch(/^\d+$/);
    expect(await countWhere(h.db, `FROM audit_log`)).toBe(1);
  });

  it("works on a table with no primary key", async () => {
    const p = await h.pg.propose("INSERT INTO keyless (value) VALUES ($1)", [
      "x",
    ]);
    expect(p.plan.keyColumns).toEqual([]);
    expect(p.changes[0]!.key).toEqual({});

    const receipt = await h.pg.apply(p);
    expect(receipt.rowsAffected).toBe(1);
    expect(receipt.keys).toEqual([]);
    expect(await countWhere(h.db, `FROM keyless WHERE value = 'x'`)).toBe(1);
  });

  it("lands nothing when the row collides with one that exists", async () => {
    const p = await h.pg.propose(
      "INSERT INTO workspaces (id, name) VALUES ($1, $2), ($3, $4)",
      ["ws_009", "Fine", "ws_881", "Duplicate"],
    );
    await expect(h.pg.apply(p)).rejects.toThrow(/duplicate key/);

    // Both rows were in one transaction, so the good one did not land either.
    expect(await countWhere(h.db, `FROM workspaces WHERE id = 'ws_009'`)).toBe(
      0,
    );
    expect(
      await countWhere(h.db, `FROM workspaces WHERE name = 'Acme Inc'`),
    ).toBe(1);
  });

  it("round-trips every type family through text", async () => {
    const p = await h.pg.propose(
      `INSERT INTO widgets (name, qty, price, active, seen_at, meta, tags, tier)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        "bolt",
        5,
        "1.50",
        true,
        "2024-05-01T12:00:00Z",
        '{"a": 1}',
        "{red,blue}",
        "pro",
      ],
    );
    expect(valueOf(p, "price")).toBe("1.50");
    expect(valueOf(p, "tags")).toBe("{red,blue}");

    await h.pg.apply(p);
    const stored = await h.db.query<Record<string, string>>(
      `SELECT qty::text, price::text, active::text, seen_at::text, meta::text,
              tags::text, tier::text, total::text
         FROM widgets WHERE name = 'bolt'`,
    );
    expect(stored.rows[0]).toMatchObject({
      qty: "5",
      price: "1.50",
      active: "true",
      meta: '{"a": 1}',
      tags: "{red,blue}",
      tier: "pro",
      // generated, so computed on insert rather than taken from the diff
      total: "7.50",
    });
  });

  it("writes a NULL the caller asked for, not the column default", async () => {
    const p = await h.pg.propose(
      "INSERT INTO widgets (name, meta) VALUES ($1, $2)",
      ["nut", null],
    );
    expect(valueOf(p, "meta")).toBeNull();

    await h.pg.apply(p);
    expect(await countWhere(h.db, `FROM widgets WHERE meta IS NULL`)).toBe(1);
  });
});

describe("warnings", () => {
  it("names a BEFORE INSERT trigger that could change the values written", async () => {
    const p = await h.pg.propose("INSERT INTO notes (body) VALUES ($1)", [
      "hello",
    ]);
    const trigger = p.warnings.find((w) => w.code === "trigger");
    expect(trigger?.message).toContain("shout_body");
    expect(trigger?.message).toMatch(/values actually written/);
  });

  it("proves that trigger warning is not theoretical", async () => {
    const p = await h.pg.propose("INSERT INTO notes (body) VALUES ($1)", [
      "hello",
    ]);
    expect(valueOf(p, "body")).toBe("hello");

    await h.pg.apply(p);
    const stored = await rowsOf("notes");
    // Previewed as "hello", written as "HELLO", which is what we warned about.
    expect(stored[0]!["body"]).toBe("HELLO");
  });

  it("does not warn about a trigger that cannot fire for an insert", async () => {
    // touch_updated_at is UPDATE-only, so an insert preview must stay quiet.
    const p = await h.pg.propose(
      "INSERT INTO profiles (workspace_id, email) VALUES ($1, $2)",
      ["ws_881", "quiet@acme.com"],
    );
    expect(codes(p.warnings)).not.toContain("trigger");
  });

  it("says a volatile default was evaluated now rather than at apply time", async () => {
    const p = await h.pg.propose("INSERT INTO notes (body) VALUES ('x')");
    const warning = p.warnings.find((w) => w.code === "default_evaluated");
    expect(warning?.message).toContain("at");

    await h.pg.apply(p);
    // Pinned: the row carries the value the approver saw, not now().
    const stored = await h.db.query<{ at: string }>(
      `SELECT at::text AS at FROM notes`,
    );
    expect(stored.rows[0]!.at).toBe(valueOf(p, "at"));
  });

  it("warns when the insert supplies a column that has to be unique", async () => {
    const p = await h.pg.propose(
      "INSERT INTO workspaces (id, name) VALUES ($1, $2)",
      ["ws_881", "dup"],
    );
    const warning = p.warnings.find((w) => w.code === "unique_column_touched");
    expect(warning?.message).toContain("id");
  });

  it("stays quiet about a key it generated itself", async () => {
    const p = await h.pg.propose(
      "INSERT INTO profiles (workspace_id, email) VALUES ($1, $2)",
      ["ws_881", "new@acme.com"],
    );
    // `id` is a unique column the preview filled from gen_random_uuid(), which
    // is not a collision anyone needs warning about. `email` is the caller's.
    const warning = p.warnings.find((w) => w.code === "unique_column_touched");
    expect(warning?.message).toMatch(/column\(s\) email\./);
  });

  it("says so when a required column has no value and no default", async () => {
    const p = await h.pg.propose("INSERT INTO widgets (qty) VALUES (1)");
    const warning = p.warnings.find(
      (w) => w.code === "missing_required_column",
    );
    expect(warning?.message).toContain("name");

    // The warning is the preview being honest, not the preview blocking.
    await expect(h.pg.apply(p)).rejects.toThrow(/not-null/);
  });

  it("names a generated column it cannot show", async () => {
    const p = await h.pg.propose(
      "INSERT INTO widgets (name, qty, price) VALUES ('bolt', 2, 3.00)",
    );
    const warning = p.warnings.find((w) => w.code === "generated_column");
    expect(warning?.message).toContain("total");
    expect(columns(p)).not.toContain("total");
  });

  it("stays quiet on a table with nothing to declare", async () => {
    const p = await h.pg.propose(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)",
      ["ws_002", "00000000-0000-0000-0000-000000000001", "admin"],
    );
    expect(codes(p.warnings)).toEqual(["unique_column_touched"]);
  });
});
