---
"pg-dry-run": minor
---

Close three gaps where the library could be wrong without saying so.

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
