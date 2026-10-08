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
credential access. Core exports database target selection; provider contracts
remain future work. MongoDB exports its worker-local pool manager. The CLI library
entry point still exports an empty module. The executable supports help/version
and offline catalog discovery. Internal worker operations inspect connections and
list collections. CLI `list` invokes them through a local daemon; other database
commands remain planned.

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

Workspace behavior tests use Node's test runner and `.mts` files, checked with
the same strict TypeScript settings as source. `npm run verify` runs them along with release
policy tests. Normal verification uses injected clients and synthetic worker
processes, plus a real worker that rejects missing names and malformed URIs
without DB access. It needs no MongoDB server or credential service. Separate
integration probes use synthetic data in a local Podman MongoDB instance. No package is
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
or the request. The internal worker uses it before credential lookup; no CLI
database command uses it yet.

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
Settings are nonnegative integer milliseconds bounded by Node's timer range.
The daemon reads `idleTimeoutMs` at startup; zero disables idle shutdown.
`scriptTimeoutMs` remains reserved for the planned script runner.

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

## Persistent worker and MongoDB pools

The internal CLI supervisor lazily forks `worker.js` over Node's private IPC
channel. Requests and results are JSON application values validated with Effect
v4 Schema. Unknown fields, invalid shapes, and messages over 1 MiB fail. Native
clients, databases, and cursors stay inside the worker. Child stdout and stderr
are discarded so dependency diagnostics cannot contaminate command output.
The detached daemon now owns this supervisor; separate CLI invocations reach it
over an authenticated local socket.

The supervisor retains one worker and dispatches one application operation at a
time. At most 32 additional operations can wait. It snapshots requests before
queueing them. Startup has a 10-second deadline. Internal operations default to a
15-second active deadline; queue waiting does not consume it, and zero disables
it. These are worker infrastructure defaults, not the planned script deadline.
Reset, stop, a crash, and protocol failure discard active and queued requests
without replay. A timed-out active request reports `OperationTimedOut`; its queued
requests report `WorkerRestarted`. Later requests may start a fresh worker after
the old process exits. Stop permanently closes that supervisor. Shutdown sends
SIGTERM, then SIGKILL after one second if needed. Pool and module state disappears
with the process. An abandoned worker exits when its parent IPC channel closes.

The worker reads the current catalog and resolves environment/database names
before reading the OS credential. It uses a connection key containing the
environment and connection name. MongoDB's pool manager shares one client across
that connection's aliases. Independent registrations get independent clients.
The driver connects lazily. Client creation uses app name `runnel`, pool size 10,
minimum pool size zero, and 10-second connection/server-selection timeouts.
Changing the stored URI closes and replaces its client. Failed closes remain
tracked for a later replacement or shutdown attempt. Shutdown rejects new
acquisition and removes clients only after successful close. Pool creation, replacement,
and shutdown serialize even if future scripts connect in parallel. Only acquisition
serializes; operations on acquired native handles can run in parallel.

Two internal operations currently exist. `inspect` lists databases accessible to
a supplied setup URI with a temporary client, then closes it. `list` resolves a
named target and lists collections using its retained client. Results include at
most 1,000 names and an explicit `truncated` flag. Collection cursors close on
success and failure. Driver operations have a 10-second timeout. Invalid URIs,
authentication failures, permission denials, and connectivity failures have safe
structured categories. Other driver failures use a generic error; raw messages,
stacks, URIs, and document-bearing diagnostics never cross IPC.

Connection inspection remains internal for upcoming setup. CLI `list` now invokes
the collection-listing operation. History and script execution remain planned.
The worker IPC format is internal. Native Windows process behavior has not been
validated on Windows.

## Local daemon and CLI transport

Database work starts `daemon.js` as a detached Node process with ignored stdio.
Information flags and offline discovery do not start it. The daemon holds a
`proper-lockfile` ownership lock for its lifetime and supervises one worker.
Concurrent startup requests converge on the same daemon; losing starter processes
exit without owning a worker. An abandoned lock can recover after its 10-second
stale threshold. Recovery does not kill a descriptor PID or replace a live
process, even if that PID belongs to something else.

Runtime metadata lives in `<catalog directory>/daemon/daemon.json`. It contains
an endpoint, random instance ID and authentication token, PID, package version,
and internal protocol version. It contains no database credentials. New POSIX
runtime directories use `0700`; metadata files and sockets use `0600`. Readers
check owner identity and permissions and reject symlinks or nonregular metadata.
Metadata replacement is atomic. Corrupt or insecure metadata fails rather than
silently starting another daemon. Shutdown removes only its own instance record.

The transport uses Unix domain sockets on POSIX and a random named pipe on Windows,
following [Node's IPC support](https://github.com/nodejs/node/blob/v24.x/doc/api/net.md#ipc-support).
Long POSIX configuration paths use a short private directory under the system
temporary directory, keyed by user ID and runtime path. Socket paths stay below
100 bytes. Windows metadata uses inherited filesystem ACLs; native Windows
access and lifecycle behavior still need validation.

Each connection carries one authenticated, newline-terminated JSON request and
one result, bounded to 1 MiB. At most 64 connections are retained. Incomplete
requests have a two-second inactivity timeout. Tokens and transport diagnostics
never appear in user output. A lost operation result reports
`OperationOutcomeUnknown` and is never retried. Status/reset/stop work with a
compatible protocol across package versions; database work requires a matching
package version and directs the user to stop an older daemon. No public IPC
compatibility promise is made.

The daemon reads the catalog's idle setting at startup, defaulting to five
minutes. Accepted application operations and resets postpone idle shutdown until
all active and queued requests finish. Status observations do not reset the idle
timer. Idle shutdown and stop close the worker before releasing daemon ownership.
Lifecycle commands return JSON envelopes and do not start an absent daemon.
`list` requires an explicit environment and uses the core's alias selection rules.
All command failures return structured errors and a nonzero exit. Human setup,
operation history, other built-ins, scripts, and exports remain planned.
