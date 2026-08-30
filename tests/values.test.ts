import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { type Harness, harness } from "./fixtures.js";

/**
 * Every value crosses the proposal boundary as PostgreSQL text and is cast back
 * with the column's catalog type on apply. That is the design that removes any
 * need for JavaScript-side type mapping, so it has to hold for every type
 * family, including the ones whose text form is structured.
 */
let h: Harness;
beforeEach(async () => {
  h ??= await harness();
  await h.reset();
  await h.db.exec(`
    INSERT INTO widgets (name, qty, price, active, seen_at, meta, tags, tier)
    VALUES ('bolt', 5, 1.50, true, '2024-05-01T12:00:00Z', '{"a": 1}', '{red,blue}', 'free');
  `);
});
afterAll(async () => h && (await h.close()));

async function roundTrip(
  assignment: string,
  params: readonly unknown[] = [],
): Promise<{ before: string | null; after: string | null; stored: unknown }> {
  const proposal = await h.pg.propose(
    `UPDATE widgets SET ${assignment} WHERE name = 'bolt'`,
    params,
  );
  expect(proposal.rowCount).toBe(1);
  const field = proposal.changes[0]!.fields[0]!;

  await h.pg.apply(proposal);

  // Re-read by key, not by a column the statement may have just rewritten.
  const res = await h.db.query<Record<string, unknown>>(
    `SELECT "${field.column}"::text AS v FROM widgets ORDER BY id LIMIT 1`,
  );
  return {
    before: field.before,
    after: field.after,
    stored: res.rows[0]!["v"],
  };
}

describe("text round trip by type", () => {
  it("text", async () => {
    const r = await roundTrip("name = $1", ["nut"]);
    expect(r).toMatchObject({ before: "bolt", after: "nut" });
  });

  it("integer, via an expression over the row", async () => {
    const r = await roundTrip("qty = qty * 3");
    expect(r).toMatchObject({ before: "5", after: "15", stored: "15" });
  });

  it("numeric keeps scale", async () => {
    const r = await roundTrip("price = $1", ["10.25"]);
    expect(r).toMatchObject({
      before: "1.50",
      after: "10.25",
      stored: "10.25",
    });
  });

  it("boolean", async () => {
    const r = await roundTrip("active = $1", [false]);
    expect(r).toMatchObject({
      before: "true",
      after: "false",
      stored: "false",
    });
  });

  it("timestamptz", async () => {
    const r = await roundTrip("seen_at = $1", ["2030-01-02T03:04:05Z"]);
    expect(r.after).toBe(r.stored);
    expect(String(r.stored)).toContain("2030-01-02");
  });

  it("jsonb", async () => {
    const r = await roundTrip("meta = $1", ['{"b": [1, 2]}']);
    expect(r.before).toBe('{"a": 1}');
    expect(r.after).toBe(r.stored);
    expect(JSON.parse(String(r.stored))).toEqual({ b: [1, 2] });
  });

  it("text array", async () => {
    const r = await roundTrip("tags = $1", ["{green,yellow}"]);
    expect(r.before).toBe("{red,blue}");
    expect(r.after).toBe(r.stored);
    expect(r.stored).toBe("{green,yellow}");
  });

  it("enum", async () => {
    const r = await roundTrip("tier = $1", ["enterprise"]);
    expect(r).toMatchObject({
      before: "free",
      after: "enterprise",
      stored: "enterprise",
    });
  });

  it("null, distinguished from the text 'null'", async () => {
    const r = await roundTrip("seen_at = NULL");
    expect(r.after).toBeNull();
    expect(r.stored).toBeNull();
  });

  it("reads null as null rather than a string", async () => {
    await h.db.exec(`UPDATE widgets SET meta = NULL WHERE name = 'bolt'`);
    const proposal = await h.pg.propose(
      `UPDATE widgets SET meta = $1 WHERE name = 'bolt'`,
      ['{"x": true}'],
    );
    expect(proposal.changes[0]!.fields[0]!.before).toBeNull();
  });

  it("handles several assignments at once, in order", async () => {
    const proposal = await h.pg.propose(
      `UPDATE widgets SET qty = $1, name = $2, active = $3 WHERE name = 'bolt'`,
      [99, "washer", false],
    );
    expect(proposal.changes[0]!.fields).toEqual([
      { column: "qty", before: "5", after: "99" },
      { column: "name", before: "bolt", after: "washer" },
      { column: "active", before: "true", after: "false" },
    ]);

    await h.pg.apply(proposal);
    const res = await h.db.query<{
      qty: number;
      name: string;
      active: boolean;
    }>(`SELECT qty, name, active FROM widgets`);
    expect(res.rows[0]).toMatchObject({
      qty: 99,
      name: "washer",
      active: false,
    });
  });
});
