---
"pg-dry-run": minor
---

Settle the public surface before it has users.

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
