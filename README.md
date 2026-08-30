# pg-dry-run

[![CI](https://github.com/polycore/pg-dry-run/actions/workflows/ci.yml/badge.svg)](https://github.com/polycore/pg-dry-run/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/pg-dry-run.svg)](https://www.npmjs.com/package/pg-dry-run)
[![license](https://img.shields.io/npm/l/pg-dry-run.svg)](LICENSE)

See exactly which rows a Postgres `INSERT`, `UPDATE` or `DELETE` would write,
before it runs. Then apply only those rows, and only if none of them have
changed since.

```sh
npm install pg-dry-run
```

```ts
import { createPreviewer } from "pg-dry-run";

const pg = createPreviewer({ url: process.env.DATABASE_URL });

const proposal = await pg.propose(
  "UPDATE profiles SET status = $1 WHERE email LIKE $2",
  ["suspended", "%@acme.com"],
);

proposal.rowCount; // 14, not the 1 you expected
```

```
14 rows would change in profiles

  a3f2…  alice@acme.com        status: active -> suspended
  d579…  bob@acme.com          status: active -> suspended
  9c46…  ci-bot@acme.com       status: active -> suspended
  b700…  intern-2024@acme.com  status: active -> suspended
  … 10 more

this preview is partial
  ! BEFORE UPDATE trigger touch_updated_at may change the values actually
    written, which this preview cannot see.
```

## Why

The two things people do today both fail.

**Checking the statement.** Block it unless it looks safe. This asserts a
property of a program you did not write, and the property is not in the text:

```sql
WITH d AS (DELETE FROM users RETURNING *) SELECT count(*) FROM d
```

Valid SQL, starts with `WITH`, returns a row, empties the table.

**Confirming the statement.** Show a human the SQL and ask yes or no. The SQL
looks correct, so they approve, and it hits fourteen rows because the CI bot
also has an `@acme.com` address. The information that would have saved them is
in the data, not the statement.

Both are the same mistake: gating on the request. What a statement will do is a
property of the data it runs against, so the only way to gate on the effect is
to go and find out.

## How

**1. The mutation is rewritten into a read.** The statement is parsed with
PostgreSQL's own parser and turned into an equivalent `SELECT`. The predicate is
copied across as an AST subtree, untouched, so any predicate Postgres can parse
is supported.

```sql
-- you called propose() with:
UPDATE profiles SET status = $1 WHERE email LIKE $2

-- it runs:
SELECT id, xmin::text, email::text,
       status AS "status.before",
       ($1::text)::text AS "status.after"
  FROM profiles
 WHERE email LIKE $2
```

Read `proposal.derivedSql` to see the exact query that ran.

**2. An insert is resolved rather than echoed.** An insert names its rows
literally, so nothing about which rows it touches is in doubt. What is hidden is
the other half of each row, the half the table supplies:

```ts
const p = await pg.propose("INSERT INTO accounts (email) VALUES ($1)", [
  "new@acme.com",
]);

p.changes[0].fields;
// email      -> new@acme.com
// role       -> admin          <- the column default, not in the statement
// status     -> active
// created_at -> 2026-08-29 14:31:07+00
```

Every value is evaluated during the read-only preview and written back exactly
as shown, defaults included. The exception is a key drawn from a sequence:
`nextval()` is a write, so it cannot run in the preview. Those columns are left
out of the diff, named in a `deferred_default` warning, and reported on the
receipt after the apply:

```ts
const receipt = await pg.apply(p);
receipt.keys; // [{ id: "4821" }]
```

**3. The catalog is asked what a rewrite cannot see.** Triggers, rewrite rules,
generated columns, unique columns, and every foreign key pointing at the target.
For a delete this is the important part, because a rewritten read selects from
one table while `ON DELETE CASCADE` reaches many:

```ts
const p = await pg.propose("DELETE FROM workspaces WHERE id = $1", ["ws_881"]);

p.rowCount; // 1
p.cascades;
// profiles          depth 0   5 rows   cascade
// sessions          depth 1  15 rows   cascade
// api_keys          depth 1   1 row    cascade
// invoices          depth 0   1 row    restrict   <- this delete will fail
```

**4. Apply is pinned to what was shown.** Every row carries its `xmin`, the
transaction id that last wrote that row version. The apply re-runs the mutation
matched on those versions, in one transaction:

```ts
try {
  const receipt = await pg.apply(proposal);
  receipt.rowsAffected; // 14
} catch (error) {
  if (error instanceof StateChangedError) {
    error.drifted;
    // [{ key: { id: "c04d…" }, reason: "modified", currentVersion: "90418" }]
  }
}
```

Two properties follow from the mechanism rather than from a rule:

- **It fails safe.** A row cannot change without its `xmin` changing. A drifted
  row aborts the entire apply, so nothing partial lands.
- **The approved set cannot grow.** Because the apply names primary keys, a row
  that starts matching the predicate while the approval is pending is not
  eligible. You approved fourteen rows; exactly those fourteen can change.

## Approval is yours

pg-dry-run produces the artifact you approve. It does not own the workflow, the
identity, or the transport:

```ts
const proposal = await pg.propose(sql, params);
if (await yourApprovalFlow(proposal)) await pg.apply(proposal);
```

A `Proposal` is plain JSON with no methods, so it survives a trip through a
queue, a database row, or a Slack round trip and applies in a different process.

That boundary is deliberate, but it is worth being explicit about what sits on
your side of it. Running this against a production database with an agent
attached also means:

- **Someone other than the caller approves.** A second approver needs an
  identity the caller cannot assume.
- **The approval leaves the terminal.** The people who should sign off on a
  production write are not tailing your process output.
- **The log is not written by the thing being audited.** An audit trail the
  caller appends to is not an audit trail.
- **Environments route differently.** Staging should not have to clear the bar
  production does.
- **The connection string is not on a laptop.** A credential should not be held
  by the process asking to use it.

None of those are Postgres problems, so none of them are in this library.

[Polycore](https://polycore.ai) is where we build them: governed production
access for agents and humans, with the approval, the identity, and the audit log
around it, and credentials that stay inside your own infrastructure. pg-dry-run
is the piece that answers what a write would actually do, and it is open source
because that question is worth answering whether or not you use the rest.

## One connection string is enough

`url` alone is fine. The derived read is generated by this library, never by a
caller or a model, and the statement is refused unless the rewriter fully
understands it, so the rewriter cannot emit a write. Previews additionally run
inside `BEGIN TRANSACTION READ ONLY`, which is what stops a predicate that calls
a volatile `SECURITY DEFINER` function from writing.

A `SELECT`-only role is still the stronger guarantee, because then
write-incapability is enforced by PostgreSQL privileges rather than by this
library being correct. It is an upgrade, never a requirement:

```ts
const pg = createPreviewer({
  url: process.env.DATABASE_URL, // apply
  readUrl: process.env.DATABASE_URL_READONLY, // preview
});
```

## What it refuses

A wrong diff is worse than no diff, because it manufactures confidence. Anything
the rewriter cannot transform faithfully throws `UnsupportedStatementError`
rather than producing an approximation:

- anything that is not a single `INSERT`, `UPDATE` or `DELETE`, including
  data-modifying CTEs and DDL;
- a missing `WHERE` clause on an update or delete;
- `UPDATE ... FROM`, `DELETE ... USING`, and statements with a `WITH` clause;
- assignment to a subfield or array element;
- `INSERT ... SELECT`, whose rows come from a query rather than the statement;
- `ON CONFLICT` in either form, since what a conflict does to an existing row is
  not visible until the insert runs;
- writing a generated or `GENERATED ALWAYS AS IDENTITY` column;
- a table with no primary key for an update or delete, since its rows could not
  be pinned. An insert is fine without one: there is no existing row to pin.

It also refuses to name more rows than `maxRows` (default 1000):

```
TooManyRowsError: Statement matches 41219 rows, above the enumeration limit of
1000. An approval must name its rows; a change this size belongs in a reviewed
migration.
```

That limit is a design position. An approval that does not name its rows was not
really an approval, and past a few hundred rows the change is not a decision a
human can review.

## Limitations

Stated here rather than discovered later:

- **Triggers.** A `BEFORE` trigger can change the values actually written, and
  any trigger can write elsewhere. Reported as a warning, never invisible.
- **Constraints.** A preview cannot prove the apply will not violate a unique or
  check constraint. Assignments touching a unique column are flagged.
- **Volatile expressions.** `SET token = gen_random_uuid()` is evaluated at
  preview time and the previewed value is what gets written. That is deliberate:
  you apply exactly what was approved. The same holds for a column default an
  insert falls through to, so a `created_at DEFAULT now()` carries the moment
  the preview ran rather than the moment it was approved. Reported as a
  `default_evaluated` warning.
- **Cascade reach is followed one column at a time.** A multi-column foreign
  key needs a tuple match the walk cannot express, so rows reachable through one
  are named in a `composite_foreign_key_skipped` warning rather than counted.
  The same goes for anything past `cascadeDepth`, which reports
  `cascade_depth_truncated`. A truncated count is never presented as a complete
  one.
- **`xmin` and `VACUUM FREEZE`.** Freezing rewrites `xmin` without changing
  data, which would reject a valid apply. Wrong in the harmless direction, and
  irrelevant at proposal lifetimes.
- **Postgres only.** The rewrite would port to any transactional database; the
  drift guard would not, because `xmin` is Postgres-specific.

## API

```ts
createPreviewer(options: PreviewerOptions): Previewer

interface Previewer {
  propose(statement: string, params?: readonly unknown[]): Promise<Proposal>;
  apply(proposal: Proposal): Promise<Receipt>;
  close(): Promise<void>;
}
```

Options: `url`, `readUrl`, `driver`, `readDriver`, `maxRows` (1000), `ttlMs`
(5 min), `statementTimeoutMs` (10s), `labelColumns`, `cascadeDepth` (5), `now`.

A `Receipt` carries `rowsAffected` and `keys`, the primary keys of the rows the
apply touched. For an insert those are the only way to learn a key the database
generated.

Errors: `UnsupportedStatementError`, `TooManyRowsError`, `ProposalExpiredError`,
`StateChangedError`, all extending `PgDryRunError`.

Bring your own connection by implementing `Driver`, which needs one thing:
exclusive use of a session, so a transaction's statements share a connection.

## Contributing

`pnpm install && pnpm verify` is the whole loop. Tests run against real
PostgreSQL semantics in-process via PGlite, so there is no server or container
to set up. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

---

Built and maintained by [Polycore](https://polycore.ai), which does governed
production access for agents and humans. If you want the approval flow, the
identity, and the audit log around this, that is what we make.
