# Changesets

This repo versions and publishes through
[Changesets](https://github.com/changesets/changesets). Nobody edits a version
number by hand.

A PR that changes behaviour carries a changeset:

```sh
pnpm changeset
```

Pick the bump type, write the entry in the voice of the CHANGELOG (what changed
and why, not what the diff did), and commit the generated `.changeset/*.md`
alongside the code.

On merge, CI opens a `chore: version packages` PR that applies every pending
changeset: it bumps `package.json`, rewrites `CHANGELOG.md`, and deletes the
consumed changeset files. Merging that PR tags the release, which publishes to
npm.

While the package is pre-1.0, `minor` is a breaking or feature-bearing release
and `patch` is a fix. See the versioning note in `CONTRIBUTING.md`.
