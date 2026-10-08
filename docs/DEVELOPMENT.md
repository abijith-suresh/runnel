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

- Implemented: core target selection, CLI help/version, catalog validation and offline discovery,
  internal serialized catalog updates, native OS secret storage helpers, and a
  persistent worker supervisor with warm MongoDB pools, connection inspection,
  and collection listing. CLI `list` starts a user-wide daemon; lifecycle commands
  provide status/reset/stop, and idle shutdown waits for active and queued work.
- Implemented: hidden human setup, accessible database discovery, and manual alias
  registration for new connections. Existing connections and aliases are preserved.
  Credential rotation and catalog migration remain future work.
- Implemented: describe, find, count, aggregate, bounded JSON/EJSON results, and
  structured errors. Inputs support inline values, files, and stdin.
- Implemented: bounded private operation history, offline inspection, a catalog
  opt-out setting, and sanitized outcomes.
- Implemented: attached CLI JavaScript execution in the persistent worker with native
  `db`, cross-environment `connect`, JSON `args`, `signal`, and `bson`; bounded
  JSON/EJSON results, explicit deadlines, and entry-change reset requirements.
  Arguments support inline/file/stdin JSON. Catalog deadline defaults, duration
  overrides, zero deadlines, and attached cancellation are implemented.
- Implemented: bounded JSON/EJSON exports, query options, new-file creation and
  explicit truncation metadata.
- CI now includes native Windows verification and a synthetic OS credential
  persistence/cleanup probe. Results must pass before merging; configuring the
  job alone does not establish native Windows compatibility.
- Planned: installed-artifact MongoDB integration tests, native Windows database
  and interactive-terminal testing, and a local guide with verified commands.

The agreed semantics remain in [DESIGN.md](DESIGN.md). Routine implementation
defaults may be chosen during these slices and documented when they become real.
MCP, additional providers, publication, and unrelated project changes are outside
this milestone. Container tooling is a development dependency, not a requirement
for users connecting to an existing MongoDB deployment.
