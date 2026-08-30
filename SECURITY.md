# Security

## Reporting a vulnerability

Please do not open a public issue.

Report privately through
[GitHub Security Advisories](https://github.com/polycore/pgpreview/security/advisories/new),
or email <support@polycore.ai>. We will acknowledge within three working days
and keep you updated until it is resolved.

## Scope

This library generates SQL and executes it against a database you point it at,
so the parts worth scrutiny are:

- the rewrite in `src/derive.ts` and `src/insert.ts`, which must never emit a
  write during a preview;
- the identifier and type-name handling in `src/catalog.ts`, which is what keeps
  catalog-sourced names from being interpolated into SQL unchecked;
- the apply path in `src/previewer.ts`, which reconstructs a statement from a
  `Proposal`;
- the refusal list in `src/analyze.ts`, since a statement that slips past it
  gets a diff that may not describe what it does.

## What a Proposal is

A `Proposal` is plain JSON, and `apply()` reconstructs a statement from it. It
is a capability rather than an inert record: whoever can hand a proposal to
`apply()` decides what that call writes.

Keep proposals inside the trust boundary that produced them. If they cross a
process, a queue, or a network hop, authenticate them on the way back in.
