import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  type Proposal,
  ProposalExpiredError,
  StateChangedError,
} from "../src/index.js";
import { countWhere, type Harness, harness, statusOf } from "./fixtures.js";

let h: Harness;
beforeEach(async () => {
  h ??= await harness();
  await h.reset();
});
afterAll(async () => h && (await h.close()));

const suspendAcme = (): Promise<Proposal> =>
  h.pg.propose("UPDATE profiles SET status = $1 WHERE email LIKE $2", [
    "suspended",
    "%@acme.com",
  ]);

async function expectDrift(proposal: Proposal): Promise<StateChangedError> {
  try {
    await h.pg.apply(proposal);
  } catch (error) {
    expect(error).toBeInstanceOf(StateChangedError);
    return error as StateChangedError;
  }
  throw new Error("expected the apply to be rejected");
}

describe("apply", () => {
  it("applies exactly the rows that were previewed", async () => {
    const proposal = await suspendAcme();
    const receipt = await h.pg.apply(proposal);

    expect(receipt.rowsAffected).toBe(5);
    expect(receipt.proposalId).toBe(proposal.id);
    expect(
      await countWhere(h.db, `FROM profiles WHERE status = 'suspended'`),
    ).toBe(5);
    // the row outside the predicate is untouched
    expect(await statusOf(h.db, "outsider@other.com")).toBe("active");
  });

  it("rejects the whole apply when one row changed, writing nothing", async () => {
    const proposal = await suspendAcme();

    await h.db.query(
      `UPDATE profiles SET status = 'deleted' WHERE email = $1`,
      ["carol@acme.com"],
    );

    const error = await expectDrift(proposal);
    expect(error.drifted).toHaveLength(1);
    expect(error.drifted[0]!.reason).toBe("modified");
    expect(error.drifted[0]!.currentVersion).not.toBeNull();

    // nothing partial: the other four rows were not suspended either
    expect(
      await countWhere(h.db, `FROM profiles WHERE status = 'suspended'`),
    ).toBe(0);
  });

  it("reports a previewed row that has since been deleted", async () => {
    const proposal = await suspendAcme();

    await h.db.query(
      `DELETE FROM memberships WHERE user_id IN
      (SELECT id FROM profiles WHERE email = $1)`,
      ["bob@acme.com"],
    );
    await h.db.query(`DELETE FROM profiles WHERE email = $1`, ["bob@acme.com"]);

    const error = await expectDrift(proposal);
    expect(error.drifted).toHaveLength(1);
    expect(error.drifted[0]!.reason).toBe("missing");
    expect(error.drifted[0]!.currentVersion).toBeNull();
    expect(
      await countWhere(h.db, `FROM profiles WHERE status = 'suspended'`),
    ).toBe(0);
  });

  it("never grows: a row that starts matching the predicate is not touched", async () => {
    const proposal = await suspendAcme();
    expect(proposal.rowCount).toBe(5);

    await h.db.exec(
      `INSERT INTO profiles (workspace_id, email) VALUES ('ws_881', 'late@acme.com')`,
    );

    const receipt = await h.pg.apply(proposal);
    expect(receipt.rowsAffected).toBe(5);
    expect(await statusOf(h.db, "late@acme.com")).toBe("active");
  });

  it("cannot be applied twice, because the first apply moves every version", async () => {
    const proposal = await suspendAcme();
    await h.pg.apply(proposal);

    const error = await expectDrift(proposal);
    expect(error.drifted).toHaveLength(5);
    expect(error.drifted.every((d) => d.reason === "modified")).toBe(true);
  });

  it("refuses an expired proposal without touching the database", async () => {
    let now = new Date("2026-08-13T10:00:00Z");
    const clocked = await harness({ now: () => now });
    try {
      const proposal = await clocked.pg.propose(
        "UPDATE profiles SET status = 'suspended' WHERE email = 'alice@acme.com'",
      );
      now = new Date("2026-08-13T10:06:00Z"); // ttl is 5 minutes

      await expect(clocked.pg.apply(proposal)).rejects.toThrow(
        ProposalExpiredError,
      );
      expect(await statusOf(clocked.db, "alice@acme.com")).toBe("active");
    } finally {
      await clocked.close();
    }
  });

  it("applies a delete, and only the previewed rows", async () => {
    await h.db.exec(`DELETE FROM memberships`);
    const proposal = await h.pg.propose(
      "DELETE FROM profiles WHERE email LIKE $1",
      ["%@acme.com"],
    );
    expect(proposal.rowCount).toBe(5);

    const receipt = await h.pg.apply(proposal);
    expect(receipt.rowsAffected).toBe(5);
    expect(await countWhere(h.db, `FROM profiles`)).toBe(1);
  });

  it("rejects a delete when a previewed row moved", async () => {
    await h.db.exec(`DELETE FROM memberships`);
    const proposal = await h.pg.propose(
      "DELETE FROM profiles WHERE email LIKE $1",
      ["%@acme.com"],
    );

    await h.db.query(`UPDATE profiles SET status = 'x' WHERE email = $1`, [
      "alice@acme.com",
    ]);

    await expectDrift(proposal);
    expect(await countWhere(h.db, `FROM profiles`)).toBe(6);
  });

  it("applies with a composite primary key", async () => {
    const proposal = await h.pg.propose(
      "UPDATE memberships SET role = $1 WHERE role = $2",
      ["admin", "member"],
    );
    const receipt = await h.pg.apply(proposal);
    expect(receipt.rowsAffected).toBe(5);
    expect(
      await countWhere(h.db, `FROM memberships WHERE role = 'admin'`),
    ).toBe(5);
  });

  it("applies zero rows without touching the database", async () => {
    const proposal = await h.pg.propose(
      "UPDATE profiles SET status = 'x' WHERE email = 'nobody@nowhere.test'",
    );
    const receipt = await h.pg.apply(proposal);
    expect(receipt.rowsAffected).toBe(0);
  });

  it("applies a proposal that has been through JSON, as an approval flow would", async () => {
    const proposal = await suspendAcme();
    const revived = JSON.parse(JSON.stringify(proposal)) as Proposal;

    const receipt = await h.pg.apply(revived);
    expect(receipt.rowsAffected).toBe(5);
    expect(
      await countWhere(h.db, `FROM profiles WHERE status = 'suspended'`),
    ).toBe(5);
  });
});
