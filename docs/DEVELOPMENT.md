# Local CLI milestone

The maintainer authorized incremental development until Runnel can be installed
and tested locally against MongoDB. Development and integration tests run on
Linux in WSL with rootless Podman and synthetic data. Native Windows use on a
work laptop is also a target. Windows compatibility must include credential
storage, paths, process lifecycle, and package installation, with explicit
limitations for behavior that has not been tested there.

Each slice uses a branch, a patch Changeset, focused tests, full verification,
and a fresh independent review. Fix objections and repeat with a fresh reviewer
until green. Merge only when required GitHub checks pass. After every three
merged feature PRs, prepare a separate version PR with `npm run version:packages`,
verify it, review it, and merge it. A version PR advances all packages exactly one
patch and consumes the pending notes. This process does not publish to npm or
create a remote release. The agent creates these PRs directly; no additional
repository credential or release workflow is required.

## Progress and remaining work

- Implemented: core target selection, CLI help/version, catalog validation and offline discovery.
- Planned: safe catalog writes, native OS secret storage, hidden human setup,
  accessible database discovery, and manual alias registration.
- Planned: daemon supervision, one persistent worker with local native driver
  handles and warm pools, operation queueing, reset/stop/status, and idle shutdown.
- Planned: list, describe, find, count, aggregate, bounded JSON/EJSON results,
  structured errors, and sanitized local operation history.
- Planned: attached JavaScript scripts with native `db`, cross-environment
  `connect`, `args`, `signal`, and `bson`, deadlines, reset behavior, and exports.
- Planned: installed-artifact integration tests, Windows checks, and a local
  testing guide with commands that have been run against synthetic fixtures.

The agreed semantics remain in [DESIGN.md](DESIGN.md). Routine implementation
defaults may be chosen during these slices and documented when they become real.
MCP, additional providers, publication, and unrelated project changes are outside
this milestone. Container tooling is a development dependency, not a requirement
for users connecting to an existing MongoDB deployment.
