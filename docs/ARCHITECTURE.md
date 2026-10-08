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
MongoDB driver. CLI declares core, MongoDB, the driver for worker-local BSON
encoding, Effect v4, `proper-lockfile`, and
`@napi-rs/keyring`. The latter two own cross-process catalog locking and native
credential access. Core exports database target selection; provider contracts
remain future work. MongoDB exports its worker-local pool manager. The CLI library
entry point still exports an empty module. The executable supports help/version
and offline catalog discovery. Internal worker operations inspect connections and
list collections. CLI database commands invoke the worker through a local daemon.
It now also implements describe, find, count, and aggregate. Operation history is
on by default. The worker now runs JavaScript internally; CLI script invocation
and exports remain planned.

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
or the request. The worker uses it before credential lookup for CLI collection listing.

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
human setup adds validated registrations; migration remains planned.

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
`scriptTimeoutMs` remains reserved for the planned CLI script deadline default.

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

These helpers are internal to the CLI and now support human `setup`.
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
it. Script requests carry an explicit active deadline; zero disables it. The
supervisor adds 100 ms for cooperative cleanup before terminating a script worker.
The planned CLI will apply the catalog's five-minute script default.
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
and shutdown serialize even when scripts connect in parallel. Only acquisition
serializes; operations on acquired native handles can run in parallel.

The initial internal operations remain available. `inspect` lists databases accessible to
a supplied setup URI with a temporary client, then closes it. `list` resolves a
named target and lists collections using its retained client. Results include at
most 1,000 names and an explicit `truncated` flag. Collection cursors close on
success and failure. Driver operations have a 10-second timeout. Invalid URIs,
authentication failures, permission denials, and connectivity failures have safe
structured categories. Other driver failures use a generic error; raw messages,
stacks, URIs, and document-bearing diagnostics never cross IPC.

Human `setup` invokes connection inspection through the daemon. CLI `list` now invokes
the collection-listing operation. History is recorded by the daemon. Scripts also
execute internally in the worker; CLI invocation remains planned.
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
All command failures return structured errors and a nonzero exit. Operation
scripts and exports remain planned.


## Human setup

`runnel setup` requires interactive stdin and stderr terminals. Credentials cannot
be passed in arguments or through piped input. It uses Node's
[readline promises API](https://github.com/nodejs/node/blob/v24.19.0/doc/api/readline.md#promises-api)
with raw terminal input, a muted output stream for the URI, and no readline history.
Prompts and selection summaries go to stderr; stdout contains one JSON result.
Ctrl+C, EOF, and declined confirmation cancel before credential storage. Each
answer has a 16 KiB input limit. Hidden input restores terminal mode when it ends.

The user chooses an existing or new environment and a new connection name.
Discovery runs in the worker using an isolated MongoDB client, which closes after
listing accessible databases. It returns at most 1,000 names with explicit
truncation. The user selects numbers or enters physical names, then supplies
unique aliases. Empty results and denied listing permissions allow manual entry;
manual registration does not verify access. Other inspection failures stop setup.
Unlisted names remain available when discovery is truncated.

Setup adds registrations without overwriting connections or aliases. After all
choices and confirmation, OS credential storage receives a new independent entry.
The serialized catalog commit rechecks name conflicts against the latest catalog,
retains unrelated changes, and stores only the secret reference. Failed commits
remove the new secret. Prompting and discovery run outside this commit sequence.
Credential rotation, editing registrations, and migration remain future work.
A daemon started for inspection may remain until idle shutdown even if setup is
cancelled. Native Linux terminal/keyring/MongoDB checks use isolated synthetic
fixtures; native Windows terminal and credential behavior remain unvalidated.


## MongoDB query commands

The CLI now implements `describe`, `find`, `count`, and `aggregate` through the
same persistent worker and target-selection path as `list`. Every command requires
`-e`; `-d` is inferred only for a sole alias. Query objects and pipelines are
validated in the CLI and again in the worker before credential lookup. Filters,
projections, sort objects, and pipelines can come from inline JSON/EJSON, a UTF-8
regular file, or stdin with filename `-`. Only one input may consume stdin per
command. Each input is limited to 256 KiB, and the complete request must fit the
existing 1 MiB IPC frame. Errors omit filenames, input values, and driver messages.

Find uses an empty filter by default and supports projection, numeric 1/-1 sort
directions, and a nonnegative `--skip` up to 2147483647. Find and aggregate return
at most 100 documents by default; `--limit` accepts 1 through 1,000. A 512 KiB
budget also bounds the document array. Results include `limits`, `truncated`,
and a `truncationReason` of `documents` or `bytes` when needed. An oversized first
document returns an empty array with byte truncation. The worker consumes at most
one extra document to detect the document cap and closes cursors on every path.
Find requests at most limit+1 documents from MongoDB. Aggregate preserves the
supplied pipeline and bounds returned documents at the cursor; it does not append
a stage. Pipelines such as `$merge` or `$out` run under database-user permissions.
The result limit does not limit those pipeline effects.

Describe returns collection metadata and at most 1,000 index descriptions under
the same combined 512 KiB budget. Views return no indexes. Missing collections
fail explicitly. Count uses `$match` followed by `$count`, closes its cursor, and
returns an exact safe integer, or a canonical `$numberLong` wrapper for a larger
count in EJSON mode. Invalid or inexact count values fail.

The worker uses the driver's
[Extended JSON encoding](https://www.mongodb.com/docs/drivers/node/current/data-formats/extended-json/).
`--format ejson` is the default and uses canonical EJSON. Query collections disable
BSON numeric promotion so Int32, Int64, and Double types remain available to the
encoder. Envelopes and their limits/count metadata use ordinary JSON numbers when
safe. `--format json` uses relaxed Extended JSON; BSON identifiers, dates, binary,
and decimals still use their standard wrappers. Numeric width can be lost, but
unsafe Int64 conversion fails with `ResultPrecisionLoss` instead of rounding.
Input numeric literals must be finite and safe when integral. Recognized EJSON
wrappers are checked for exact keys, valid types, bounds, and representability
before driver conversion. Date inputs must fit JavaScript's Date range. Ordinary
query objects, including `$regex` with sibling predicates and DBRef records with
extra fields, keep their keys; legacy regex wrapper conversion is disabled.
Numeric wrappers supply larger integers or explicit nonfinite doubles. Driver error codes can also
arrive as BSON numeric wrappers; classification normalizes them before mapping
permission, authentication, invalid-query, missing-collection, and timeout errors.

Driver cursor operations have a 10-second deadline and run within the supervisor's
15-second active deadline. Queue wait time is separate. Internal script requests
have their own explicit deadline; CLI script and export options remain future work. Operation history is on by default. Standard verification uses synthetic
handles and inputs; separate WSL probes exercise these commands against Podman
MongoDB with an isolated catalog and keyring entry. Native Windows query operation
has not been validated.

## Operation history

The daemon records one entry for each valid database request it accepts, including
queued requests that fail after a reset, stop, crash, or deadline. Setup connection
inspection and lifecycle commands are excluded. CLI preflight failures and offline
commands never reach the recorder. The recorder snapshots request names and reads
the catalog for configured target names and `settings.historyEnabled`; omission
means enabled. Unknown names are omitted. Disabling recording applies to newly
submitted work and leaves existing history intact.

Entries contain an operation name, a UTC start timestamp, elapsed milliseconds
including queue wait, configured target names when resolved, and a success/error
outcome. Error codes come from a fixed allowlist; unknown codes become
`OperationFailed`. No collection names, request values, secret references,
credentials, physical databases, result documents, or error messages are stored.
The history schema is CLI-owned and does not change provider contracts or IPC
worker results.

`history/entries.json` below the catalog directory retains the latest 1,000 entries,
with a 1 MiB read/write cap. Effect v4 schemas reject unknown fields and malformed
entries. Reads require private owned directories and regular files; POSIX file
opens refuse symlinks and do not block on FIFOs. Hardlinks are rejected. Writers
use a process lock, private temporary file, fsync, and atomic rename. The daemon
serializes writes and acquires the history lock without waiting, so a busy history
file produces a warning without holding operation results during shutdown. It
waits for pending recording before graceful shutdown; normal
idle accounting includes this work. `runnel history` reads entries newest first
without starting a daemon or accessing credentials.

A save failure preserves the database result and exit status. The daemon response
adds an optional `HistoryUnavailable` warning, and the CLI emits a fixed diagnostic
to stderr. Corrupt or unsupported history is preserved rather than overwritten.
This history is best effort and is not an audit log: hard process termination or
machine failure may lose an entry, and an error records the application outcome,
not proof that a writing pipeline had no side effects. Native Windows filesystem
permissions and history behavior have not been validated.


## Internal JavaScript runner

The worker accepts internal `run` requests with an absolute JavaScript entry path,
plain JSON arguments, an output format, and an explicit deadline. The executable
still has no `run` command. CLI file/stdin arguments, cancellation on disconnect,
and `settings.scriptTimeoutMs` defaults are the next slice.

A module default-exports a function, normally async, receiving
`{ db, args, connect, signal, bson }`. `db` is an actual worker-local driver `Db`.
`connect({ env, db })` uses the same catalog, credential lookup, core selection,
and connection pools as built-ins. The environment is explicit; a sole database
alias can be inferred. Parallel connects within a script remain one application
operation. `bson` is the driver's BSON namespace, so scripts need no separate
driver installation to construct identifiers and BSON values. Neither native
handles nor helper functions cross IPC.

Arguments are plain JSON up to 256 KiB, with finite, safe numeric literals.
EJSON-looking argument keys remain data. The runner reads regular `.mjs` or `.js`
entry files up to 1 MiB, resolves their real paths, and imports their file URLs
using Node's native module loader. It hashes the entry bytes on each invocation.
A previously imported entry whose bytes change fails with `ScriptChanged` before
calling the cached function. An edit during import also requires reset. Failed
imports remain subject to Node's module cache; reset after fixing them. Imported
dependency-only edits require explicit reset. Reset starts a fresh worker and
clears both modules and connection pools.

Results accept JSON/BSON values, use the query encoder's canonical EJSON or safe
relaxed output, and carry a 512 KiB limit. An undefined return becomes null. Live
handles, accessor properties, functions, cyclic values, and unsupported class
instances fail with
`ResultEncodingFailed`; oversized results fail with `ResultTooLarge`. Scripts
choose their own bounded result. Invalid Int32/Int64 payloads and unsigned Long values beyond the signed BSON
range fail rather than being coerced. The runner snapshots plain data and native
BSON values before encoding so
validation and serialization use the same values. It does not silently truncate
arbitrary values. Awaited failures use fixed application messages even if a
script modifies a caught error, with useful driver
permission and connection categories. Script bodies, arguments, filenames, and
raw error messages are excluded from application errors and operation history.
The recorder stores one `run` entry for the primary configured target, rather than
tracing each driver call or secondary connect.

The active deadline includes target resolution, module loading, and execution;
queue wait is separate. The runner aborts `signal` at the requested deadline and
waits for the script to settle. The supervisor terminates uncooperative work after
100 ms of cleanup time and discards queued requests without replay. A deadline of
zero disables both timers. Shutdown also aborts the signal. Scripts must await
their work, pass the signal to operations that support it, and clean up their own
resources. A completed invocation disables later `connect` calls but cannot
revoke a native handle retained by arbitrary JavaScript. Scripts run with the
worker user's OS and database permissions. No driver proxy or script sandbox is
introduced. Native Windows script execution remains unvalidated.
