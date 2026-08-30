---
"pgdryrun": minor
---

First release.

`pgdryrun` derives a read-only preview of what a Postgres `INSERT`, `UPDATE` or
`DELETE` would write, then applies only the previewed rows and only if none of
them have moved since.

The mutation is parsed with PostgreSQL's own parser and rewritten into an
equivalent `SELECT`, with the predicate carried across as an AST subtree so any
predicate Postgres can parse is supported. The catalog supplies what a rewrite
cannot see: triggers, rewrite rules, generated columns, unique columns, and
every foreign key pointing at the target, so a `DELETE` preview reports the rows
`ON DELETE CASCADE` will reach rather than only the ones named by the statement.
An `INSERT` has no rows to enumerate, so what it resolves instead is the other
half of each row: every column the table would fill from a default, evaluated
during the preview and written back exactly as shown.

Apply is pinned to what was shown. Every previewed row carries its `xmin`, and
the apply matches on those versions inside one transaction, so a row that moved
aborts the whole apply and the approved set can never grow.

Anything the rewriter cannot transform faithfully is refused rather than
approximated, since a wrong diff manufactures confidence. The refusal list and
the known limitations are in the README.

This is the standalone extraction of the package previously published as
`@polycore/pgpreview`, renamed because npm treats `pgpreview` as too close to an
existing `pg-preview` placeholder. The API is unchanged apart from the base error
class, which is now `PgDryRunError`; it names the package rather than the preview
step, since every error extends it including the apply-time ones. The package is
also built to `dist/` now, so it can be consumed from plain Node rather than only
through a bundler.
