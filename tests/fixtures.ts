import { PGlite } from "@electric-sql/pglite";

import { createDryRunner, type DryRunner } from "../src/index.js";
import { pgliteDriver } from "./pglite-driver.js";

/**
 * One schema covering every shape the dry runner has to reason about: cascading
 * and restricting foreign keys, a composite key, a keyless table, BEFORE
 * triggers on update and on insert, a unique column, a generated column, a
 * sequence-assigned key, a volatile default, a non-public schema, and a column
 * of every type family the text round trip has to survive.
 */
export const SCHEMA = `
CREATE TYPE plan_tier AS ENUM ('free', 'pro', 'enterprise');

CREATE TABLE workspaces (
  id   text PRIMARY KEY,
  name text NOT NULL,
  plan plan_tier NOT NULL DEFAULT 'free'
);

CREATE TABLE profiles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE,
  email        text UNIQUE NOT NULL,
  status       text NOT NULL DEFAULT 'active',
  updated_at   timestamptz NOT NULL DEFAULT '2020-01-01T00:00:00Z'
);

CREATE TABLE sessions (
  id      bigserial PRIMARY KEY,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE TABLE api_keys (
  id      bigserial PRIMARY KEY,
  user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
  label   text
);

-- Deliberately RESTRICT: deleting a referenced workspace must fail, and the
-- preview has to say so instead of counting rows as if they would vanish.
CREATE TABLE invoices (
  id           bigserial PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id) ON DELETE RESTRICT,
  cents        int NOT NULL
);

CREATE TABLE memberships (
  workspace_id text,
  user_id      uuid,
  role         text NOT NULL DEFAULT 'member',
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE audit_log (
  id   bigserial PRIMARY KEY,
  note text
);

-- Insert-side hazards in one place: a key the database assigns, a default
-- evaluated during the preview, and a BEFORE INSERT trigger that rewrites the
-- value the approver was shown.
CREATE TABLE notes (
  id   bigserial PRIMARY KEY,
  body text NOT NULL,
  at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE keyless (
  value text
);

CREATE TABLE widgets (
  id       bigserial PRIMARY KEY,
  name     text NOT NULL,
  qty      int NOT NULL DEFAULT 0,
  price    numeric(10,2) NOT NULL DEFAULT 0,
  active   bool NOT NULL DEFAULT true,
  seen_at  timestamptz,
  meta     jsonb,
  tags     text[],
  tier     plan_tier NOT NULL DEFAULT 'free',
  total    numeric(12,2) GENERATED ALWAYS AS (qty * price) STORED
);

-- A composite foreign key, which the cascade walk counts by tuple and so
-- cannot follow. Present to prove it is reported rather than skipped in
-- silence: memberships has the composite primary key it points at.
CREATE TABLE membership_notes (
  id           bigserial PRIMARY KEY,
  workspace_id text,
  user_id      uuid,
  note         text NOT NULL,
  CONSTRAINT membership_notes_membership_fkey
    FOREIGN KEY (workspace_id, user_id)
    REFERENCES memberships (workspace_id, user_id) ON DELETE CASCADE
);

-- A cascade chain long enough to run past a lowered depth limit, so the depth
-- cutoff has something to stop at: workspaces -> chain_a -> b -> c -> d.
CREATE TABLE chain_a (
  id           bigserial PRIMARY KEY,
  workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE TABLE chain_b (
  id bigserial PRIMARY KEY,
  a_id bigint REFERENCES chain_a(id) ON DELETE CASCADE
);
CREATE TABLE chain_c (
  id bigserial PRIMARY KEY,
  b_id bigint REFERENCES chain_b(id) ON DELETE CASCADE
);
CREATE TABLE chain_d (
  id bigserial PRIMARY KEY,
  c_id bigint REFERENCES chain_c(id) ON DELETE CASCADE
);

CREATE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE TRIGGER touch_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE FUNCTION shout_body() RETURNS trigger AS $$
BEGIN NEW.body := upper(NEW.body); RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE TRIGGER shout_body BEFORE INSERT ON notes
  FOR EACH ROW EXECUTE FUNCTION shout_body();

CREATE SCHEMA ops;
CREATE TABLE ops.tickets (
  id     bigserial PRIMARY KEY,
  title  text NOT NULL,
  state  text NOT NULL DEFAULT 'open'
);
`;

export const SEED = `
INSERT INTO workspaces (id, name, plan) VALUES
  ('ws_881', 'Acme Inc', 'pro'),
  ('ws_002', 'Other Co', 'free');

INSERT INTO profiles (workspace_id, email, status) VALUES
  ('ws_881', 'alice@acme.com',       'active'),
  ('ws_881', 'bob@acme.com',         'active'),
  ('ws_881', 'carol@acme.com',       'active'),
  ('ws_881', 'ci-bot@acme.com',      'active'),
  ('ws_881', 'intern-2024@acme.com', 'active'),
  ('ws_002', 'outsider@other.com',   'active');

INSERT INTO sessions (user_id)
  SELECT id FROM profiles, generate_series(1, 3) WHERE email LIKE '%@acme.com';

INSERT INTO api_keys (user_id, label)
  SELECT id, 'deploy' FROM profiles WHERE email = 'ci-bot@acme.com';

INSERT INTO invoices (workspace_id, cents) VALUES ('ws_002', 4900);

INSERT INTO memberships (workspace_id, user_id, role)
  SELECT 'ws_881', id, 'member' FROM profiles WHERE email LIKE '%@acme.com';

INSERT INTO membership_notes (workspace_id, user_id, note)
  SELECT 'ws_881', id, 'onboarded' FROM profiles WHERE email LIKE '%@acme.com';

INSERT INTO chain_a (workspace_id) VALUES ('ws_881');
INSERT INTO chain_b (a_id) SELECT id FROM chain_a;
INSERT INTO chain_c (b_id) SELECT id FROM chain_b;
INSERT INTO chain_d (c_id) SELECT id FROM chain_c;

INSERT INTO ops.tickets (title) VALUES ('printer on fire'), ('coffee machine');
`;

export interface Harness {
  readonly db: PGlite;
  readonly pg: DryRunner;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function harness(
  options: {
    readonly maxRows?: number;
    readonly now?: () => Date;
    readonly cascadeDepth?: number;
  } = {},
): Promise<Harness> {
  const db = await PGlite.create();
  // PGlite inherits the host timezone, so a `timestamptz` renders differently
  // depending on where the suite runs: the same instant comes back as
  // `2020-01-01 00:00:00+00` in CI and `2020-01-01 03:00:00+03` on a laptop in
  // Istanbul. Pin the session so the text round trip these tests assert on is
  // the same everywhere.
  await db.exec(`SET TimeZone = 'UTC';`);
  await db.exec(SCHEMA);
  await db.exec(SEED);

  const pg = createDryRunner({
    driver: pgliteDriver(db),
    ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.cascadeDepth === undefined
      ? {}
      : { cascadeDepth: options.cascadeDepth }),
  });

  return {
    db,
    pg,
    async reset() {
      await db.exec(`
        TRUNCATE membership_notes, memberships, invoices, api_keys, sessions,
                 profiles, workspaces, audit_log, widgets, keyless, notes,
                 chain_d, chain_c, chain_b, chain_a, ops.tickets
          RESTART IDENTITY CASCADE;
      `);
      await db.exec(SEED);
    },
    async close() {
      await db.close();
    },
  };
}

/** Current status of one profile, for asserting that nothing partial landed. */
export async function statusOf(
  db: PGlite,
  email: string,
): Promise<string | null> {
  const res = await db.query<{ status: string }>(
    `SELECT status FROM profiles WHERE email = $1`,
    [email],
  );
  return res.rows[0]?.status ?? null;
}

export async function countWhere(db: PGlite, sql: string): Promise<number> {
  const res = await db.query<{ n: number }>(`SELECT count(*)::int AS n ${sql}`);
  return res.rows[0]?.n ?? 0;
}
