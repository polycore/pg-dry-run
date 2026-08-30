import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { type Harness, harness } from "./fixtures.js";

/**
 * A DELETE that names one row can remove thousands through ON DELETE CASCADE,
 * and the derived read cannot see any of them because it selects from one
 * table. The cascade walk is what closes that gap, using reads only.
 */
let h: Harness;
beforeEach(async () => {
  h ??= await harness();
  await h.reset();
});
afterAll(async () => h && (await h.close()));

const find = (
  nodes: readonly {
    table: { name: string };
    via: string;
    rowCount: number;
    depth: number;
    action: string;
  }[],
  name: string,
) => nodes.find((n) => n.table.name === name);

describe("cascade", () => {
  it("follows the graph more than one level deep", async () => {
    const p = await h.pg.propose("DELETE FROM workspaces WHERE id = $1", [
      "ws_881",
    ]);

    expect(p.rowCount).toBe(1);

    // direct children of workspaces
    expect(find(p.cascades, "profiles")).toMatchObject({
      depth: 0,
      via: "workspace_id",
      action: "cascade",
      rowCount: 5,
    });

    // grandchildren, reached through profiles
    expect(find(p.cascades, "sessions")).toMatchObject({
      depth: 1,
      via: "user_id",
      action: "cascade",
      rowCount: 15,
    });
    expect(find(p.cascades, "api_keys")).toMatchObject({
      depth: 1,
      action: "cascade",
      rowCount: 1,
    });
  });

  it("reports a RESTRICT constraint as a blocker rather than a row count to lose", async () => {
    const p = await h.pg.propose("DELETE FROM workspaces WHERE id = $1", [
      "ws_002",
    ]);

    expect(find(p.cascades, "invoices")).toMatchObject({
      action: "restrict",
      rowCount: 1,
    });
    expect(p.warnings.map((w) => w.code)).toContain("restrict_blocks_delete");
    expect(
      p.warnings.find((w) => w.code === "restrict_blocks_delete")!.message,
    ).toMatch(/will fail/);
  });

  it("does not descend past a restricting constraint", async () => {
    const p = await h.pg.propose("DELETE FROM workspaces WHERE id = $1", [
      "ws_002",
    ]);
    // ws_002's only profile has no sessions; the restrict path must not invent any
    expect(find(p.cascades, "invoices")!.action).toBe("restrict");
  });

  it("omits constraints with no referencing rows", async () => {
    await h.db.exec(`DELETE FROM sessions; DELETE FROM api_keys;`);
    const p = await h.pg.propose("DELETE FROM workspaces WHERE id = $1", [
      "ws_881",
    ]);
    expect(find(p.cascades, "sessions")).toBeUndefined();
    expect(find(p.cascades, "profiles")!.rowCount).toBe(5);
  });

  it("computes no cascade for an update", async () => {
    const p = await h.pg.propose(
      "UPDATE workspaces SET name = $1 WHERE id = $2",
      ["Renamed", "ws_881"],
    );
    expect(p.cascades).toEqual([]);
  });

  it("finds nothing to cascade when the delete matches nothing", async () => {
    const p = await h.pg.propose("DELETE FROM workspaces WHERE id = $1", [
      "nope",
    ]);
    expect(p.rowCount).toBe(0);
    expect(p.cascades).toEqual([]);
  });

  it("follows a foreign key that references a non-key column", async () => {
    await h.db.exec(`
      CREATE TABLE aliases (
        id      bigserial PRIMARY KEY,
        p_email text REFERENCES profiles(email) ON DELETE CASCADE
      );
      INSERT INTO aliases (p_email) VALUES ('alice@acme.com'), ('alice@acme.com');
    `);
    const p = await h.pg.propose("DELETE FROM profiles WHERE email = $1", [
      "alice@acme.com",
    ]);
    expect(find(p.cascades, "aliases")).toMatchObject({
      via: "p_email",
      action: "cascade",
      rowCount: 2,
    });
  });

  it("terminates on a self-referencing table", async () => {
    await h.db.exec(`
      CREATE TABLE nodes (
        id     bigserial PRIMARY KEY,
        parent bigint REFERENCES nodes(id) ON DELETE CASCADE
      );
      INSERT INTO nodes (parent) VALUES (NULL);
      INSERT INTO nodes (parent) VALUES (1);
      INSERT INTO nodes (parent) VALUES (2);
    `);
    const p = await h.pg.propose("DELETE FROM nodes WHERE id = $1", [1]);
    expect(p.rowCount).toBe(1);
    expect(find(p.cascades, "nodes")).toMatchObject({ rowCount: 1 });
  });
});
