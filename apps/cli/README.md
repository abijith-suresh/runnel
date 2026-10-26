# Runnel CLI

`@abijith-suresh/runnel` provides the `runnel` executable for named MongoDB access.
A human registers credentials through `setup`; agents select physical databases or optional aliases.
The CLI requires Node `>=24.19.0 <25`. For a local installation, follow the
[local testing guide](../../CONTRIBUTING.md#local-testing).

```sh
runnel setup --env local
runnel envs
runnel databases -e local
runnel list -e local -d accounts
runnel find users -e local -d accounts --limit 10
runnel guide
```

## Help and syntax

`runnel help`, `--help`, `-h`, and no arguments show the available commands.
Use `runnel help find` or `runnel find --help` for command options, and
`runnel help database rename` for a management action. Help needs no operands,
catalog, or database access, but still checks supplied syntax. `--version` or
`-v` prints the installed version.

Application commands write one JSON envelope to stdout. Success has `ok: true`
and `data`; failure has `ok: false` and `error.code`/`error.message`, with exit
status 1. Syntax errors instead leave stdout empty and write a usage diagnostic
to stderr before catalog access, daemon activity, or input reads. Diagnostics
omit private argument values. Help, version, guide, and skill output is plain text.

For values starting with a dash, use `--option=<value>`. Use `--` before operands
starting with a dash. Short options accept `-e local` or `-elocal`; use
`--env=local` for an equals sign. `-e=local` selects the literal name `=local`.

## Choosing a database

`envs`, `connections -e <environment>`, and `databases -e <environment>` read
configuration without querying MongoDB or reading credentials. They report the
default connection and its URI database when configured. `databases` lists
optional aliases, not an inventory of accessible physical databases; an empty
list does not mean you lack access. Connection output omits secret references.
Every database operation requires an explicit `-e`/`--env`.

With a default connection, `-d`/`--db` can name any valid physical database, without
prior enumeration or alias registration. A matching alias keeps its original
mapping, even if it points at another connection. Use `--connection NAME` to
select a physical database explicitly and bypass aliases with the same name.
This also selects a connection in environments that have several registrations.
Runnel never guesses between connections or checks a read/write approval policy.
MongoDB's database-user permissions decide whether the operation succeeds.

If `-d` is omitted, Runnel first uses the selected default connection's URI
path database, then the environment's sole alias. `authSource` is only an
authentication option and never supplies a target. Without either unambiguous
choice, supply `-d`. With `--connection NAME`, omission uses only that connection's
URI database and otherwise fails. Legacy environments retain alias-only selection
until a default is explicitly configured; `--connection` permits physical selection
without changing their default.

```sh
runnel list -e local -d physical_database
runnel find users -e local --connection reporting -d physical_database --limit 10
runnel connection default primary -e local
```

`list` queries the selected database for collection names and types, returning
at most 1,000 collections with a `truncated` flag. Database operations start a
local daemon on demand and reuse its worker and connection pools.

## Offline agent instructions

`runnel guide` reads the bundled `skills/runnel/SKILL.md`. It needs no catalog,
credential storage, database, or network access:

```sh
runnel guide
runnel guide query
runnel guide scripts
runnel guide errors
runnel guide management
runnel guide all
runnel skill path
```

`runnel skill` or `runnel skill print` prints the full file. `skill path` locates
it for an agent's skill loader. Installation does not change agent configuration.

## Catalog

The catalog is `catalog.json` under `$XDG_CONFIG_HOME/runnel` or
`~/.config/runnel` on Linux, and `%APPDATA%/runnel` on Windows. An absolute
`RUNNEL_HOME` overrides that directory for isolated testing. A missing catalog
returns empty discovery results. Invalid or unreadable catalogs fail; they do
not silently become empty. Setup and management commands update it atomically;
it stores OS secret references, never credentials.
See [the architecture section](../../README.md#architecture) for its schema.

## Settings

`runnel config` returns effective settings and whitelisted environment, connection,
default-database and optional-alias metadata. It omits stored URIs and secret
references. It does not test credential availability. `runnel settings` and
`runnel settings get` return settings, supported numeric limits and application
timing. Reads do not create a missing catalog or start/connect to a daemon.

```sh
runnel config
runnel settings
runnel settings set --idle-timeout-ms 300000 --script-timeout-ms 60000
runnel settings set --history-enabled false
```

Supply at least one field to `settings set`. Milliseconds must be decimal
integers, and history must be exactly `true` or `false`. Unknown fields, fractions,
negative values and values outside the supported bounds fail without a partial
write. Unspecified fields, aliases and credentials stay intact. Writes use the
existing catalog lock and v1-to-v2 migration; they never read the vault or contact
MongoDB. Defaults remain 300000 ms for both timeouts and enabled history.

| Setting | Supported values | Takes effect |
| --- | --- | --- |
| `idleTimeoutMs` | 0 to 2147483647 ms; 0 disables idle expiry | Next daemon start; an existing daemon retains its startup value |
| `scriptTimeoutMs` | 0 to 2147483547 ms; 0 disables the active deadline | Next script submission without an explicit `--timeout`; already queued/active requests retain their deadline |
| `historyEnabled` | Boolean | Newly submitted operations; existing entries remain |

Stop a daemon explicitly with `runnel daemon stop` when a new idle timeout needs
to take effect before its normal idle exit. Settings/config/status inspection
never resets the idle timer or keeps pools alive. Settings writes do not stop or
restart an existing daemon and do not interrupt current work.

The CLI and a future human UI use these same validated application operations
inside the installed package. Ordinary registration and credential replacement
also have prompt-independent operations with redacted results. Terminal rotation
uses the same replacement transaction and pins its connection snapshot before
asking for input. No HTTP server or browser query/script editor is included.

## Registering a connection

Run `runnel setup --env local` in an interactive terminal and enter the URI at
the single hidden prompt. Bare `runnel setup` asks for the environment first.
Setup creates an internal `primary` connection, selects it as the environment's
default, and saves no aliases. There is no database discovery, selection, naming,
or confirmation wizard. Saving validates URI syntax and names locally, stores the
URI in native OS storage, and commits the registration atomically. It does not
verify reachability, authentication, or database access and does not start a daemon.
`--test` explicitly requests a bounded worker-owned ping before saving, without
listing databases. A failed or cancelled test leaves no registration.

For an advanced additional connection use `runnel setup --env local --connection
reporting`, optionally with `--default` to select it as default. Existing
connections cannot be overwritten through setup. To replace missing or rejected
credentials, use `runnel connections -e local`, then `runnel connection rotate
primary -e local`. Rotation updates the existing registration and preserves its
aliases and default selection. Do not retry setup with the same name to recover.
The same URI registered elsewhere gets a separate credential entry.

Prompts go to stderr; the final result is a JSON envelope on stdout. Ctrl+C or EOF
cancels before registration. Credentials cannot be supplied through CLI flags or
piped stdin. Setup input is limited to 16 KiB per answer. Linux requires an
unlocked Secret Service store and a session D-Bus connection. Windows uses native
credential storage; native Windows interactive setup still needs manual testing.
An explicit `--test` may start the daemon; `runnel daemon stop` stops it.

## Managing registrations

Change an existing connection's credentials with `runnel connection rotate primary
-e local`. A human enters the replacement URI in a hidden interactive terminal
prompt. Runnel checks the connection with a bounded ping, preserves aliases and the default
connection selection, updates the URI database metadata, commits a new credential
reference, then removes the old credential when no registration references it.
A concurrent connection change rejects the rotation instead of overwriting it.
If old-credential cleanup fails after the commit, the result stays successful
with a `SecretCleanupFailed` warning. A later operation reads the new credential;
the worker replaces the old connection pool when the URI changes. Already active
work keeps acquired handles and credentials until it finishes. Each operation
uses one catalog snapshot, including default selection, URI database metadata and
aliases first visited by a later `connect()`.
Catalog edits become visible on the next operation. A concurrent mapping change
during credential recovery can return `TargetChanged`; inspect possible writes
before starting another operation. Runnel never replays database work.

Explicit connection checks use the registered target by name. They need no alias
and never return the stored URI or secret reference:

```sh
runnel connection test primary -e local
runnel connection databases primary -e local
```

`test` uses a bounded ping without enumerating databases. `databases` explicitly
requests authorized database names, capped at 1000 with `truncated`. A user can
have database access while listing returns `PermissionDenied`; this does not
invalidate the saved registration. Both calls run in the worker with existing
connection pools, target snapshots and bounded credential refresh, without replay.
Each driver operation has a 10-second deadline and the supervisor's 15-second
active deadline. Configuration/status commands perform neither check.

Aliases can be managed without accessing MongoDB or credentials:

```sh
runnel database add reporting -e local --connection primary --database reports
runnel database rename reporting -e local --to analytics
runnel database remove analytics -e local
```

These commands change only catalog mappings. They never create, rename, or drop
physical databases, and adding an alias does not verify access to that database.
Existing aliases cannot be overwritten. Remove all aliases referring to a
connection before `runnel connection remove primary -e local`. Connection removal
deletes the registration and removes its obsolete credential from OS storage.
Removing the default clears that selection; another connection is never promoted
automatically. Use `connection default NAME -e ENV` to select a replacement.
An empty environment remains available for later setup.

## Querying a named database

`find` and `count` accept `--filter` or `--filter-file`; omission uses `{}`. Find also
accepts `--projection` or `--projection-file`, `--sort` or `--sort-file`, and
`--skip`. Sort objects use 1/-1 directions. Aggregate requires `--pipeline` or
`--pipeline-file` containing an array of stage objects. Inputs are JSON or MongoDB
EJSON, limited to 256 KiB each. Use `-` as a filename to read stdin, once per command.
Inline and file inputs for the same option cannot be combined.
Invalid collection names, formats, limits, offsets, and conflicting input sources
fail before Runnel reads query files or waits for stdin.
Canonical and relaxed EJSON wrappers require valid keys, types, and values.
Date inputs must fit JavaScript's Date range. Ordinary `$regex` query objects keep
their sibling predicates; use `$regularExpression` for a BSON regex value.

```sh
runnel find users -e local --filter '{"active":true}' --limit 10
runnel find users -e local --projection '{"name":1,"_id":0}' --sort '{"name":1}' --skip 10
runnel count users -e local --filter-file filter.json
runnel aggregate users -e local --pipeline-file pipeline.json --format json
```

Find and aggregate default to 100 documents, with `--limit` ranging from 1 to 1,000.
Their document array also has a 512 KiB budget. The JSON envelope includes the
selected names, `documents`, `limits`, and `truncated`. Truncated results include
`truncationReason`, either `documents` or `bytes`. A single oversized document can
produce an empty truncated result; projection can reduce document size. Cursors
close after completion, truncation, or failure. These are bounded results, with
no continuation token or snapshot guarantee.

Describe returns `metadata` and `indexes` under the same byte budget, with at most
1,000 indexes. Views have no indexes. Count returns an exact safe integer, or an
EJSON Int64 wrapper for a larger count. Driver work has a 10-second deadline, and
the supervisor has a 15-second active deadline. Queue waiting is separate.

Output defaults to canonical MongoDB EJSON with `--format ejson`, preserving BSON
numeric widths and values. `--format json` selects relaxed Extended JSON. ObjectId,
date, binary, and decimal values still use standard wrappers. Int64 values outside
JavaScript's safe integer range require EJSON mode; relaxed output fails instead
of rounding them. Use input EJSON wrappers such as `{"$numberLong":"9007199254740993"}`
for large integers. Ordinary integral JSON numbers must be safe and finite.

Aggregation pipelines run unchanged under the database user's permissions,
including stages that write data. `--limit` bounds returned documents and does
not bound pipeline side effects. Runnel adds no separate read/write approval gate.
Errors are structured and exit nonzero without dumping query values or driver
messages. Unreadable query or script argument files identify the failing option,
such as `--filter-file` or `--args-file`, without revealing filenames or contents.
Exports use the same query execution and encoding rules.

## JavaScript scripts

`run` executes a local `.mjs` or `.js` ES module in the persistent worker. Entry
paths resolve from the CLI's working directory. The module default-exports an
async function receiving `{ db, args, connect, signal, bson }`. Native MongoDB
handles and connection pools remain in that worker. Scripts need no separate
driver installation to use `bson.ObjectId` or `connect({ env, db })`.

```js
export default async function ({ db, args, signal }) {
  return await db.collection("users").findOne(args.filter, { signal });
}
```

```sh
runnel run lookup.mjs -e dint -d accounts --args '{"filter":{"active":true}}'
runnel run lookup.mjs -e dint -d accounts --args-file args.json --timeout 5m
cat args.json | runnel run lookup.mjs -e dint -d accounts --args-file -
```

Choose `--args` or `--args-file`; arguments default to `{}` and accept plain JSON
up to 256 KiB from inline input, UTF-8 regular files, or stdin.
EJSON-looking argument keys stay data. Use the `bson` helpers inside the script
when constructing native values. Numeric argument literals must be finite and safe.

Output defaults to canonical EJSON; `--format json` chooses relaxed output and
rejects unsafe Int64 conversion. Return bounded data, not handles or cursors.
Results have a 512 KiB cap. A top-level `undefined` return becomes `null`.
Nested `undefined` values are rejected with `ResultEncodingFailed`; use `null`
for missing values or omit undefined object properties. Worker console output is
discarded so stdout contains one result envelope.

The deadline defaults to `settings.scriptTimeoutMs`, initially five minutes.
`--timeout` accepts a nonnegative integer followed by one unit, `ms`, `s`, `m`
or `h`, up to 2,147,483,547 ms. Examples are `1500ms`, `30s`, `5m` and `1h`.
Composite values such as `2m30s` are rejected; use `150s` instead. Bare nonzero
numbers need a unit, so use `1500ms` rather than `1500`. `0` disables the deadline.
If the catalog setting exceeds this limit, lower it or supply `--timeout`.
The active deadline includes target lookup, imports, execution, and result processing; queue wait is
separate. It is independent of the daemon's idle timer. Pass `signal` to driver
operations that support it and await all work.

Scripts stay attached. On Linux, Ctrl+C returns `OperationCancelled` and exit
130; SIGTERM returns exit 143. Losing the CLI connection also cancels its script.
Cancelling a queued request removes only that request. Cancelling active work
stops the worker and discards queued requests, with no replay. Neither a timeout
nor cancellation proves that database writes were rolled back. Native Windows
signal behavior remains unvalidated.

Scripts execute with the worker user's OS and database permissions. After editing
a loaded script or its imports, follow the [daemon recovery rules](#daemon-and-recovery).

## Daemon and recovery

`runnel daemon status` reports the daemon and worker state. `reset` interrupts
active and queued work and clears modules and pools; the next operation starts a
fresh worker. `stop` shuts down both. These commands never start a missing daemon.
By default, five minutes of inactivity shuts it down. Active and queued work
prevent idle shutdown.

Node caches script modules in the worker. After editing an already-used entry,
an imported dependency, or a failed import, run `runnel daemon reset`. Changed
entries fail with `ScriptChanged` until reset. Coordinate resets with other work
using the same catalog. Reset and stop do not undo writes.

After installing another Runnel version or rebuilding the CLI, stop the old
daemon before running database work so its modules reload.

## Local operation history

`runnel history` reads the most recent entries first without starting a daemon or
reading credentials. History is on by default for database operations submitted
to the daemon. It retains the latest 1,000 entries in a private file below the
catalog directory, with a 1 MiB file cap. Each entry contains configured environment,
database alias and connection names when resolved, the operation, its UTC start
time, elapsed milliseconds, and a sanitized success/error outcome. Duration includes
queue waiting. Physical target names and URI database defaults are omitted unless
they identify a configured alias. It omits collection names, filters, arguments, scripts, returned
documents, credentials, physical database names, and driver error messages.

Use `runnel settings set --history-enabled false` to disable recording
for newly submitted operations. An absent setting means enabled. Existing entries
remain available. Setup discovery, lifecycle commands, offline discovery, and
requests rejected before submission do not add entries.

History failures produce `warning: "HistoryUnavailable"` and a diagnostic on
stderr. The database result and exit status stay intact. A corrupt history file
is preserved for inspection. This is lightweight local history; a hard daemon
kill or machine failure can leave an operation unrecorded, and an error outcome
does not establish whether a writing pipeline completed before interruption.

## Exports

```sh
runnel export users -e local -d accounts --output users.ejson
runnel export users -e local --filter-file filter.json --sort '{"_id":1}' --limit 500 --output selected.ejson
runnel export users -e local --format json --output users.json
```

`export` accepts the same filter, projection, sort, skip, limit, and format options
as `find`. The filename extension does not choose the format.

The file contains one JSON/EJSON array with a trailing newline. Stdout contains a
JSON envelope with the resolved path, document count, file bytes, limits and
truncation status, without returned documents. Default and maximum document caps
are 100 and 1,000. The array is bounded to 512 KiB, plus one byte for its newline.
Truncation is a successful bounded export; check `truncated` and `truncationReason`
before treating the file as complete. Exports do not promise a full database
backup or stable pagination while documents change.

`--output` is required and must name a new file in an existing directory. Relative
paths resolve from the CLI working directory. Existing files, directories and
links are refused, including files created concurrently. Saving requires
filesystem hard-link support. A failed save leaves no partial destination.
Abrupt process termination can leave a private `.runnel-export-*.tmp` file beside
the destination. Linux files use mode 0600;
Windows relies on directory ACLs and has not yet been validated natively.

History records one `export` database operation without the filename, filter or
returned documents. Its outcome describes worker execution. A subsequent local
file-save failure is reported by the CLI and does not rewrite that history entry.

## Development

Build at the repository root and invoke the compiled CLI:

```sh
npm run build
node apps/cli/dist/cli.js --help
node apps/cli/dist/cli.js daemon stop
node apps/cli/dist/cli.js envs
```

Run CLI tests with `npm test --workspace @abijith-suresh/runnel`. The package's
library entry point is empty; it has no public composition API.

The [local testing guide](../../CONTRIBUTING.md#local-testing) covers persistent
tarball installation, manual setup, and optional MongoDB integration checks.
`npm run pack:check` validates tarball installs in a temporary consumer without
global installation or publication. This package has not been published.
