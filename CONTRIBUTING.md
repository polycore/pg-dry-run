# Contributing

## Setup

```sh
pnpm install
pnpm verify
```

`verify` is the whole gate: `format:check`, `lint`, `typecheck`, `test`, and
`build`. It is exactly what CI runs, so green locally means green on the PR.

There is nothing else to set up. The tests run against real PostgreSQL
semantics in-process through [PGlite](https://pglite.dev) (Postgres compiled to
WASM), so no server, no container, and no fixtures on disk. That matters because
most of what is under test is Postgres behaviour rather than ours: `xmin`
changing on every row version, read-only transactions rejecting writes, and
`ON DELETE CASCADE` reach.

## The bar

A wrong diff is worse than no diff, because it manufactures confidence. That one
idea decides most questions here.

- **Refuse rather than approximate.** If the rewriter cannot transform a
  statement faithfully, it throws `UnsupportedStatementError`. Adding support
  for a new statement shape means proving the derived read is equivalent, not
  getting close.
- **Never inspect an expression.** Predicates and assigned values are copied
  across as opaque AST subtrees. That is why any predicate Postgres can parse is
  supported, and it stops being true the moment something starts interpreting
  them.
- **Warn rather than hide.** Anything the derived read cannot see (triggers,
  rules, constraints) is a `Warning` on the proposal. A preview must never imply
  a completeness it does not have.
- **`src/ast.ts` is the only file that touches raw parse trees.** Everything
  else consumes the typed facade it exports.

## Changesets

Versions and the changelog come from
[Changesets](https://github.com/changesets/changesets). Nobody edits a version
number by hand.

A PR that changes behaviour carries one:

```sh
pnpm changeset
```

Write the entry in the voice of the changelog: what changed and why it matters
to someone using the library, not what the diff did.

While the package is pre-1.0:

- `minor` for a feature, a behaviour change, or anything breaking;
- `patch` for a fix that changes no interface.

On merge, CI opens a `chore: version packages` PR. Merging that PR publishes to
npm and tags the release.

That PR is opened by the release workflow using `RELEASE_PAT`, not the default
`GITHUB_TOKEN`, because this organization disables write permissions for
workflows and `GITHUB_TOKEN` is therefore not allowed to create pull requests.

## Tests

Every test file targets one property of the design rather than one function:

| File                | What it holds down                                           |
| ------------------- | ------------------------------------------------------------ |
| `propose.test.ts`   | the derived read reports the right rows and values           |
| `apply.test.ts`     | the apply writes exactly what was previewed, or nothing      |
| `insert.test.ts`    | a resolved row, defaults included, survives the round trip   |
| `cascade.test.ts`   | a delete reports the reach the catalog knows about           |
| `refuse.test.ts`    | every refusal in the README actually refuses                 |
| `warnings.test.ts`  | hazards the read cannot see are reported rather than dropped |
| `values.test.ts`    | every type family survives the text round trip               |
| `read-only.test.ts` | a predicate that tries to write cannot                       |
| `postgres.test.ts`  | drift under a genuinely concurrent writer (opt-in)           |

A new refusal belongs in `refuse.test.ts`, a new warning in `warnings.test.ts`,
and a new supported type in `values.test.ts`.

### The Postgres suite

`postgres.test.ts` is the one suite PGlite cannot stand in for. PGlite has a
single backend, so the drift tests everywhere else interleave a writer
sequentially and prove the mechanism rather than the race. This one uses two
independent connections to a real server, and it is also the only place the
`SELECT`-only role path is exercised, since PGlite has no roles.

It skips unless you point it at a scratch database:

```sh
docker run -d --name pg -e POSTGRES_PASSWORD=pw -p 55433:5432 postgres:18
PG_DRY_RUN_TEST_POSTGRES_URL=postgres://postgres:pw@localhost:55433/postgres pnpm test
```

It creates and drops its own `dry_run_it` schema, and the role test needs an
account that can `CREATE ROLE`. CI runs it on every PR against a service
container, so you do not have to.

## Reporting a vulnerability

Do not open a public issue. See [SECURITY.md](SECURITY.md).
