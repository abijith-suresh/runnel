# Current architecture

This document describes the development baseline and implemented core behavior.
Runtime plans live in [DESIGN.md](DESIGN.md).

## Workspaces

The private root coordinates three public npm packages. TypeScript project
references build core, MongoDB, then CLI. Each workspace emits ESM JavaScript,
declarations, declaration maps, and source maps into its own `dist/` directory.
Exports resolve to compiled files. `runnel` resolves to `apps/cli/dist/cli.js`.

```text
apps/cli -> packages/mongodb -> packages/core
         -> packages/core
```

Core declares Effect v4. MongoDB declares core, Effect v4, and the official
MongoDB driver. CLI declares core, MongoDB, Effect v4, `proper-lockfile`, and
`@napi-rs/keyring`. The latter two own cross-process catalog locking and native
credential access. These dependencies
reserve the agreed boundaries; no provider adapter or provider contracts exist
yet. Core exports database target selection. The MongoDB and CLI library entry
points still export empty modules. The executable supports help/version and
offline catalog discovery. No database operations are implemented.

All workspaces are publishable with public access and fixed, aligned versions.
The CLI uses ordinary package dependencies rather than bundling. The future
release must make core and MongoDB available with the CLI. There are no private
runtime dependencies, custom bundlers, or postinstall behavior.

## Tooling

Node and npm are pinned in `mise.toml`; `.node-version` supports setup-node and
other version managers. TypeScript uses NodeNext and strict checks, including
exact optional properties and unchecked indexed access. The compiler includes
the DOM type library because Effect 4.0.1 declarations reference web-platform
types such as `TextDecoderOptions`. Dependency declaration checking stays enabled;
the runtime remains Node. Biome owns JavaScript,
TypeScript, and JSON formatting and lint. It also restricts concrete provider
imports from core. Markdown is reviewed as prose; Biome does not format it.

Husky, lint-staged, and commitlint follow Outpost's local workflow. CI reuses the
owner's shared quality and title workflows. The local release policy and tests
validate Changesets and actual Git version diffs. Temporary policy fixtures clear
inherited Git variables so hooks in a worktree cannot redirect fixture commands
to the caller's repository. Packaging verification checks exports, declarations,
executable destinations and shebang, then installs local
tarballs outside the workspace and checks module resolution.

Core and CLI behavior tests use Node's test runner and `.mts` files, checked with
the same strict TypeScript settings as source. `npm run verify` runs them along with release
policy tests. There are no database fixtures. Verification imports dependency
modules without creating clients or accessing credentials. No package is
published by a development command or CI workflow.

## Database target selection

`resolveDatabaseTarget` takes a read-only map of environment names to sets of
database alias names, plus requested `env` and `db` names. This names-only input
does not define catalog storage, physical database mappings, or provider contracts.

The pure function returns an Effect v4 `Result` containing selected names or a
typed selection error. Environment selection is always explicit. A missing
database is inferred only when the selected environment has exactly one alias.
Unknown environments and databases fail. Zero aliases and multiple aliases have
distinct errors when no database was supplied. Names match exactly; the function
does not trim or change case, and explicit empty strings do not trigger defaults.

The error tags describe core selection failures. They are not a finalized CLI or
IPC JSON envelope. The function performs no I/O and does not mutate supplied names
or the request. No CLI command uses it yet.

## CLI information flags

The executable uses Node's built-in `parseArgs` for `--help`/`-h` and
`--version`/`-v`. No arguments show help. Help takes precedence when both flags
are supplied. Success writes to stdout and exits with status 0. Unknown flags,
unsupported positional commands, and malformed options produce a concise stderr diagnostic
and exit with status 1, without echoing the supplied arguments.

Version output reads the owning package's `package.json` relative to the compiled
entry point, independently of the working directory. It reflects the installed
artifact's version after Changesets updates metadata. Missing or invalid version
metadata produces a stderr diagnostic and status 1 when the executable can load.

These small process and package-metadata boundaries use Node APIs directly.
Help/version do not initialize database dependencies, a catalog, or a daemon.
Help/version use plain text.

## Catalog and offline discovery

The CLI owns `catalog.json`, a user-wide configuration file independent of cwd.
Linux uses `$XDG_CONFIG_HOME/runnel` or `~/.config/runnel`; Windows uses
`%APPDATA%/runnel`, falling back to `~/AppData/Roaming/runnel`. An absolute
`RUNNEL_HOME` overrides the directory. Relative configuration roots fail.

The reader implements schema version 1 from the design example. It requires
`settings.idleTimeoutMs`, `settings.scriptTimeoutMs`, and `environments`.
Each environment has `connections` and `databases`. A connection has provider
`mongodb` and a `keyring:runnel/<identifier>` secret reference. A database alias
has a connection name within that environment and a physical database name.
No credential is stored in this file. An internal writer now updates the catalog;
human setup and migration remain planned.

Effect v4 Schema validates every field and rejects extra properties. Environment,
connection, and alias names use 1 to 64 ASCII letters, digits, underscores, or
hyphens. Prototype-related names are reserved. References must resolve within
their environment. Unknown schema versions, providers, malformed JSON, or files
over 1 MiB fail without reporting input values. Missing files mean an empty catalog;
I/O failures remain distinct. Nonregular files are rejected without waiting for
a FIFO writer. Physical database names exclude whitespace and MongoDB's forbidden
characters on either platform and use at most 63 UTF-8 bytes, following
[MongoDB's naming limits](https://www.mongodb.com/docs/manual/reference/limits/#naming-restrictions).
Settings are nonnegative integer milliseconds bounded
by Node's timer range; their operational behavior remains planned.

`envs`, `connections -e <name>`, and `databases -e <name>` return sorted configured
names or mappings in JSON envelopes. Success is `{ "ok": true, "data": ... }`;
failure is `{ "ok": false, "error": { "code": ..., "message": ... } }` and exits
with status 1. Connection results omit credential references. These commands
need no credential service, provider, daemon, or database connection. Core's
names-only target resolver remains separate from the persisted CLI schema.

## Catalog updates and credentials

The internal `updateCatalog` helper locks the catalog, reads the current validated
contents, runs an Effect updater, and validates the result before replacement.
The updater must not perform external side effects. A new configuration directory
uses mode `0700` on POSIX. The next catalog is written to a unique file with mode
`0600`, synced, closed, and renamed within that directory. Validation failures,
oversized results, and updater failures leave the old catalog unchanged. Effect
resource management releases locks on failure and interruption. The file commit
finishes before observing cancellation, so a released lock cannot race an
unfinished write. This is atomic replacement, not a claim of power-loss durability.

[`proper-lockfile`](https://github.com/moxystudio/node-proper-lockfile) serializes
writers across processes. Every writer uses the resolved directory and the same
10-second stale threshold, with a 3-second heartbeat. Acquisition retries for
about one second, then returns `CatalogBusy`. An abandoned stale lock can recover
on a later attempt. Symbolic links and nonregular catalog destinations cannot be
replaced by the writer. A completed rename remains a successful commit even if
temporary-file or lock cleanup fails; callers must not delete its credentials as
though it rolled back. A hard process exit may leave temporary metadata files or
unreferenced OS secrets. No automatic vault-wide cleanup is implemented.

The internal credential store uses pinned
[`@napi-rs/keyring`](https://github.com/Brooooooklyn/keyring-node). Linux explicitly
requires Secret Service and does not use the library's default fallback to an
in-memory kernel keyring. Windows uses the binding's native credential store.
The service is `runnel`; each registration gets its own random identifier and a
`keyring:runnel/<identifier>` catalog reference. Reusing the same URI does not
reuse the secret identifier.

`withStored` creates a credential and runs a callback that commits its reference
to the catalog. A successful callback retains the credential. A failed callback
removes it, and a failed native write attempts cleanup. This small commit sequence
finishes before observing external Effect interruption. Read and delete operations
validate references before touching the vault. Missing entries are distinct from
a locked or unavailable store. Native errors are replaced by generic diagnostics
that do not include the connection string. Tests inject a credential-entry factory
to avoid the user's vault; ordinary `verify` needs no credential service. Packaging
checks also load the native binding without constructing an entry.

These helpers are internal to the CLI and do not add setup or database commands.
Native Linux round-trip checks use a temporary catalog and synthetic secrets.
Native Windows checks are still planned.
