# pg-dry-run

## 0.1.0

### Minor Changes

- [`129f27e`](https://github.com/polycore/pg-dry-run/commit/129f27eb2126e6381578b048bab2d7ad7e2bce96) Thanks [@kafkas](https://github.com/kafkas)! - First release.
  
  `pg-dry-run` derives a read-only preview of what a Postgres `INSERT`, `UPDATE` or
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

- [#1](https://github.com/polycore/pg-dry-run/pull/1) [`aba395a`](https://github.com/polycore/pg-dry-run/commit/aba395ab07f7fabbfdd512d28250586ad082c9cd) Thanks [@kafkas](https://github.com/kafkas)! - Settle the public surface before it has users.
  
  `createPreviewer` is now `createDryRunner`, and `Previewer` / `PreviewerOptions`
  are `DryRunner` / `DryRunnerOptions`. Those three carried the package's old name
  rather than describing anything, and the factory is the first line of every
  example.
  
  `propose()` and `Proposal` stay. The verb and the noun are a pair, and what
  comes back is a thing to be approved rather than a run that did nothing, which
  is the half of the product a name like `dryRun()` would drop. The package name
  says what kind of tool this is; the API says what the objects are.
  
  `analyze` and its `Analysis` types are no longer exported. They carried
  `pgsql-parser` parse nodes through a type this package does not export, so
  consumers got types they could not name while the parser's node shape became
  part of the compatibility surface.
  
  `Proposal` gains `columns`: the columns the statement would write, which is what
  callers were reaching into `plan.assignments` for. `plan` was documented as
  opaque while being exported and read, which was true of neither; it is now
  described as what it is, the detail `apply` needs to rebuild the statement
  somewhere else.

- [`2d85fe7`](https://github.com/polycore/pg-dry-run/commit/2d85fe79a2271b76e7d97507699afa7e79ff66a8) Thanks [@kafkas](https://github.com/kafkas)! - Close three gaps where the library could be wrong without saying so.
  
  **A proposal edited in transit can no longer smuggle SQL into the apply.** Every
  column and table name on the apply path goes through `quoteIdent` and every
  value is a bound parameter, but the cast target in `plan.assignments[].type` was
  a bare type name spliced into the statement, and it was only checked when the
  catalog produced it. A `Proposal` is plain JSON and is meant to travel, so a
  proposal that came back off a queue with `"text, email = 'x@evil.com'"` in that
  field wrote a column nobody previewed, and the receipt reported success. Both
  apply paths now run `assertTypeName` on the way in. A proposal is still a bearer
  capability, so authenticate one that crosses a trust boundary; see SECURITY.md.
  
  **A multi-column foreign key is now reported instead of skipped.** The cascade
  walk filtered composite keys out in SQL, so a `DELETE` preview under-reported
  its own reach with nothing on the proposal to say so. They cannot be followed,
  because the walk matches one column against a list of values rather than a
  tuple, but they are now named in a `composite_foreign_key_skipped` warning.
  
  **The cascade depth cutoff now warns.** Stopping at `cascadeDepth` returned
  silently, so a truncated count read exactly like a complete one. It emits
  `cascade_depth_truncated`, which the breadth cutoff already did.
  
  `WarningCode` gains `composite_foreign_key_skipped`. Anything switching
  exhaustively on it needs a new arm.
  
  Also adds the suite PGlite cannot stand in for: drift under a genuinely
  concurrent second connection, and a preview through a `SELECT`-only role. It
  runs against a real server on every PR.
