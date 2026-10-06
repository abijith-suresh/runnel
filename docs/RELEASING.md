# Release policy

## Patch releases only

All Runnel releases advance exactly one patch. This rule includes functionality
additions and continues after 1.0. Minor and major Changesets, prerelease versions,
skipped patch increments, downgrades, and unaligned workspace versions are rejected.

The three public packages share a Changesets fixed group. Internal dependencies
use the same exact version. Start at `0.0.1`; the first version operation produces
`0.0.2`. Initial package versions do not mean that any package has been published.

`npm run release-policy` checks pending Changesets, the fixed group, package
versions, dependency direction, public package metadata, Effect v4 pins, and the
lockfile. `npm run changeset:check` adds a Git comparison on PRs. Every ordinary
PR must add a nonempty patch Changeset and leave versions unchanged.

A version PR must consume all existing valid patch Changesets and increment all
three packages exactly once. Its diff may contain only those deleted Changesets,
workspace versions and internal dependency versions, changelogs, and the lockfile.
It cannot mix source or package-script edits into a release. No branch name grants
an exemption. Policy tests exercise invalid notes, version jumps, missing notes,
and hidden changes in version PRs.

## Preparing a version PR

After development PRs and their Changesets land on main:

```sh
git switch main
git pull --ff-only
git switch -c chore/version-packages
npm ci
npm run version:packages
npm run verify
git add .
git commit -m "chore(release): version packages"
git push -u origin HEAD
gh pr create --title "chore(release): version packages"
```

The wrapper validates pending notes and Changesets' computed plan before editing
versions. It validates the result after updating the lockfile. If it fails after
editing files, inspect the working tree and fix or revert the version changes on
that branch. Do not invoke unguarded `changeset version` as the release process.

Review and merge the version PR only after required checks pass. Do not combine
new functionality with the version PR. Changesets writes the workspace changelogs.

## Publication boundary

The baseline deliberately has no npm publication command, release workflow,
GitHub release creation, registry credential, or auto-merge workflow. Versioning
is local and PR based. Packaging verification uses temporary tarballs and local
installs with lifecycle scripts disabled; it never publishes.

A future, separately authorized release task must define explicit publication
controls, validate all three artifacts, and publish their matching versions.
The CLI's exact dependencies require core and MongoDB to be available at that
version. Do not enable publication as a side effect of initial setup or a feature
PR. GitHub branch protection and the required `Baseline verified` check also apply
to maintainer-authored version PRs.
