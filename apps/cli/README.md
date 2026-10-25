# Runnel CLI

`@abijith-suresh/runnel` provides the `runnel` executable for named MongoDB access.
A human registers credentials through `setup`; agents query database aliases.
The CLI requires Node `>=24.19.0 <25`. For a local installation, follow the
[local testing guide](../../CONTRIBUTING.md#local-testing).

```sh
runnel setup
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
configured names without querying MongoDB or reading credentials. Connection
output omits secret references. Every database operation requires an explicit
`-e`/`--env`. Omit `-d`/`--db` only when that environment has exactly one alias.

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

## Registering a connection

Run `runnel setup` in an interactive terminal. Choose an environment and a new
connection name, then enter the MongoDB URI at the hidden prompt. The worker lists
accessible databases. Choose a listed number or enter a physical database name,
then name its alias. Repeat for more aliases, leave the database selection blank,
and confirm saving. Use `m` for manual entry when the physical name is a number
or the literal `m`. At least one alias is required.

Setup permits manual names when discovery returns no databases or the database
user lacks listing permission. It does not verify access to manually entered
names. Authentication and connectivity failures stop setup. Configured names are
never overwritten; use a new connection and new aliases for another registration.
The same URI registered elsewhere gets a separate credential entry.

Prompts go to stderr; the final result is a JSON envelope on stdout. Ctrl+C, EOF,
or declining the save cancels before registration. Credentials cannot be supplied
through CLI flags or piped stdin. Setup input is limited to 16 KiB per answer.
Linux requires an unlocked Secret Service store, such as GNOME Keyring, and a
session D-Bus connection. Windows uses native credential storage through the same
binding; native Windows setup has not yet been tested. Discovery can start the
daemon even if setup is later cancelled; `runnel daemon stop` stops it explicitly.

## Managing registrations

Change an existing connection's credentials with `runnel connection rotate primary
-e local`. A human enters the replacement URI in a hidden interactive terminal
prompt. Runnel checks the connection, preserves aliases, commits a new credential
reference, then removes the old credential when no registration references it.
A concurrent connection change rejects the rotation instead of overwriting it.
If old-credential cleanup fails after the commit, the result stays successful
with a `SecretCleanupFailed` warning. A later operation reads the new credential;
the worker replaces the old connection pool when the URI changes. Already active
work keeps acquired handles and credentials until it finishes. Each operation
uses one catalog snapshot, including aliases first visited by a later `connect()`.
Catalog edits become visible on the next operation. A concurrent mapping change
during credential recovery can return `TargetChanged`; inspect possible writes
before starting another operation. Runnel never replays database work.

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
queue waiting. It omits collection names, filters, arguments, scripts, returned
documents, credentials, physical database names, and driver error messages.

Set `settings.historyEnabled` to `false` in `catalog.json` to disable recording
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
