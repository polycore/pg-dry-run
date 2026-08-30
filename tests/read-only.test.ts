import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { countWhere, type Harness, harness } from "./fixtures.js";

/**
 * Why one connection string is enough.
 *
 * The derived read is generated here, never by a caller or a model, and the
 * statement is refused unless the rewriter fully understands it. That makes the
 * rewriter incapable of emitting a write. The remaining hole is that the
 * predicate is copied across verbatim, so a predicate that calls a function
 * which writes would write during preview. `BEGIN TRANSACTION READ ONLY` is
 * what closes it, and it costs nothing on a single URL.
 *
 * A SELECT-only role is still the stronger guarantee, which is why `readUrl`
 * exists. It is an upgrade, not a requirement.
 */
let h: Harness;
beforeEach(async () => {
  h ??= await harness();
  await h.reset();
});
afterAll(async () => h && (await h.close()));

describe("the preview cannot write", () => {
  it("blocks a predicate that calls a function which writes", async () => {
    await h.db.exec(`
      CREATE OR REPLACE FUNCTION sneaky(text) RETURNS boolean AS $$
      BEGIN
        INSERT INTO audit_log (note) VALUES ('written during preview');
        RETURN true;
      END $$ LANGUAGE plpgsql VOLATILE;
    `);

    await expect(
      h.pg.propose("UPDATE profiles SET status = 'x' WHERE sneaky(email)"),
    ).rejects.toThrow(/read-only transaction/i);

    expect(await countWhere(h.db, `FROM audit_log`)).toBe(0);
  });

  it("blocks it for a SECURITY DEFINER function too, where a role would not", async () => {
    await h.db.exec(`
      CREATE OR REPLACE FUNCTION sneaky_definer(text) RETURNS boolean AS $$
      BEGIN
        INSERT INTO audit_log (note) VALUES ('definer');
        RETURN true;
      END $$ LANGUAGE plpgsql VOLATILE SECURITY DEFINER;
    `);

    await expect(
      h.pg.propose("DELETE FROM profiles WHERE sneaky_definer(email)"),
    ).rejects.toThrow(/read-only transaction/i);

    expect(await countWhere(h.db, `FROM audit_log`)).toBe(0);
  });

  it("leaves the session usable after a blocked preview", async () => {
    await h.db.exec(`
      CREATE OR REPLACE FUNCTION sneaky2(text) RETURNS boolean AS $$
      BEGIN INSERT INTO audit_log (note) VALUES ('x'); RETURN true; END $$
      LANGUAGE plpgsql VOLATILE;
    `);
    await expect(
      h.pg.propose("UPDATE profiles SET status = 'x' WHERE sneaky2(email)"),
    ).rejects.toThrow();

    // the aborted transaction was rolled back, so normal work still succeeds
    const p = await h.pg.propose(
      "UPDATE profiles SET status = $1 WHERE email = $2",
      ["suspended", "alice@acme.com"],
    );
    expect(p.rowCount).toBe(1);
  });

  it("emits only a SELECT", async () => {
    for (const statement of [
      "UPDATE profiles SET status = 'x' WHERE email LIKE '%@acme.com'",
      "DELETE FROM profiles WHERE email LIKE '%@acme.com'",
      "UPDATE memberships SET role = 'admin' WHERE role = 'member'",
    ]) {
      const p = await h.pg.propose(statement);
      expect(p.derivedSql.trimStart()).toMatch(/^SELECT/i);
      expect(p.derivedSql).not.toMatch(
        /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/i,
      );
    }
  });

  it("changes nothing in the database during a preview", async () => {
    const before = await h.db.query<{ h: string }>(
      `SELECT md5(string_agg(t::text, '' ORDER BY t::text)) AS h FROM profiles t`,
    );
    await h.pg.propose(
      "UPDATE profiles SET status = 'suspended' WHERE email LIKE '%@acme.com'",
    );
    await h.pg.propose("DELETE FROM profiles WHERE email LIKE '%@acme.com'");
    const after = await h.db.query<{ h: string }>(
      `SELECT md5(string_agg(t::text, '' ORDER BY t::text)) AS h FROM profiles t`,
    );
    expect(after.rows[0]!.h).toBe(before.rows[0]!.h);
  });
});
