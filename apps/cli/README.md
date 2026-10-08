# Runnel CLI

`@abijith-suresh/runnel` is the scoped public CLI package, with executable name
`runnel`. Bare npm `runnel` belongs to an existing package. The CLI depends on
the matching public core and MongoDB packages, plus Effect v4.

The CLI supports information flags, human setup, offline discovery, collection
listing, query commands, attached scripts, history, and daemon lifecycle commands:

```sh
runnel --help     # also -h; no arguments show help too
runnel --version  # also -v
runnel setup
runnel envs
runnel connections -e local
runnel databases -e local
runnel list -e local -d accounts
runnel describe users -e local -d accounts
runnel find users -e local -d accounts --filter-file filter.json
runnel count users -e local -d accounts
runnel aggregate users -e local -d accounts --pipeline-file pipeline.json
runnel run compare.mjs -e local -d accounts --args-file args.json --timeout 5m
runnel export users -e local -d accounts --output users.ejson
runnel history
runnel daemon status
runnel daemon reset
runnel daemon stop
```

Help lists available commands and flags. Version output
comes from the installed package metadata. Both write to stdout and exit with
status 0. If both flags are supplied, help takes precedence.

Unsupported commands, unknown flags, and malformed options write a concise
diagnostic to stderr and exit with status 1. Discovery writes a JSON envelope to
stdout, with `ok: true` and `data`, or `ok: false` and a structured `error`.
Discovery errors exit with status 1. `connections` and `databases` require an
explicit `-e`/`--env`. They list configured mappings without connecting to a
database or reading credentials. Connection output omits secret references.
`list` requires `-e` and infers `-d` only when the environment has exactly one
database alias. It starts a user-wide local daemon, resolves the alias in the
worker, reads the OS credential there, and returns collection names/types with
an explicit truncation flag. At most 1,000 collections are returned. Repeated
invocations use the same worker and connection pools.

`daemon status` reports a reachable daemon and its worker state. `reset` discards
active and queued operations without replay, then future work starts a fresh
worker. `stop` closes the worker and shuts down the daemon. These lifecycle
commands never start a missing daemon. The daemon shuts down after five minutes
of inactivity by default; active and queued work prevent shutdown. Stop the old
daemon after installing another Runnel version before running database work.

The library entry point still exports an empty
module; there is no public CLI composition API.

For local development, build at the repository root and invoke the compiled CLI.
After rebuilding, stop any existing daemon before the next database command so
its worker and protocol modules reload.

```sh
npm run build
node apps/cli/dist/cli.js --help
node apps/cli/dist/cli.js --version
node apps/cli/dist/cli.js daemon stop
node apps/cli/dist/cli.js envs
```

Run CLI tests with `npm test --workspace @abijith-suresh/runnel`.
`npm run pack:check` checks
all package artifacts and imports in a temporary local consumer without global
installation or publication.
The repository's [local testing guide](../../docs/LOCAL_TESTING.md) also covers
manual setup and `npm run check:mongodb`, an optional installed-package check
against a local test server with native credential storage.

See [the repository](https://github.com/abijith-suresh/runnel) for planned commands
and development documentation. This package has not been published.

The catalog is `catalog.json` under `$XDG_CONFIG_HOME/runnel` or
`~/.config/runnel` on Linux, and `%APPDATA%/runnel` on Windows. An absolute
`RUNNEL_HOME` overrides that directory for isolated testing. A missing catalog
returns empty discovery results. Invalid or unreadable catalogs fail; they do
not silently become empty. Human setup creates and updates this catalog with
serialized atomic replacement; it stores only OS secret references.
Its schema is documented in
[the current architecture](../../docs/ARCHITECTURE.md#catalog-and-offline-discovery).


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
The same URI registered elsewhere gets a separate credential entry. Editing
registrations and credential rotation remain future work.

Prompts go to stderr; the final result is a JSON envelope on stdout. Ctrl+C, EOF,
or declining the save cancels before registration. Credentials cannot be supplied
through CLI flags or piped stdin. Setup input is limited to 16 KiB per answer.
Linux requires an unlocked Secret Service store, such as GNOME Keyring, and a
session D-Bus connection. Windows uses native credential storage through the same
binding; native Windows setup has not yet been tested. Discovery can start the
daemon even if setup is later cancelled; `runnel daemon stop` stops it explicitly.


## Querying a named database

All query commands require `-e`, with `-d` inferred only for a sole alias. `find`
and `count` accept `--filter` or `--filter-file`; omission uses `{}`. Find also
accepts `--projection` or `--projection-file`, `--sort` or `--sort-file`, and
`--skip`. Sort objects use 1/-1 directions. Aggregate requires `--pipeline` or
`--pipeline-file` containing an array of stage objects. Inputs are JSON or MongoDB
EJSON, limited to 256 KiB each. Use `-` as a filename to read stdin, once per command.
Inline and file inputs for the same option cannot be combined.
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
messages. Exports use the same query execution and encoding rules.

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

An environment is required. A database alias is inferred only when the selected
environment has one. Choose `--args` or `--args-file`; arguments default to `{}`
and accept plain JSON up to 256 KiB from inline input, UTF-8 regular files, or stdin.
EJSON-looking argument keys stay data. Use the `bson` helpers inside the script
when constructing native values. Numeric argument literals must be finite and safe.

Output defaults to canonical EJSON; `--format json` chooses relaxed output and
rejects unsafe Int64 conversion. Return bounded data, not handles or cursors.
Results have a 512 KiB cap; undefined becomes null. Worker console output is
discarded so stdout contains one result envelope.

The deadline defaults to `settings.scriptTimeoutMs`, initially five minutes.
`--timeout` accepts whole durations with `ms`, `s`, `m`, or `h`, up to
2,147,483,547 ms. `0` disables it. If the catalog setting exceeds this script
limit, lower it or use an explicit supported override. The active deadline
includes target lookup, imports, execution, and result processing; queue wait is
separate. It is independent of the daemon's idle timer. Pass `signal` to driver
operations that support it and await all work.

Scripts stay attached. On Linux, Ctrl+C returns `OperationCancelled` and exit
130; SIGTERM returns exit 143. Losing the CLI connection also cancels its script.
Cancelling a queued request removes only that request. Cancelling active work
stops the worker and discards queued requests, with no replay. Neither a timeout
nor cancellation proves that database writes were rolled back. Native Windows
signal behavior remains unvalidated.

After editing an already-used entry, run `runnel daemon reset`; changed entries
fail with `ScriptChanged` until reset. Imported dependency-only edits and fixed
failed imports also need reset. Reset clears modules and pools. Scripts execute
with the worker user's OS and database permissions.

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

`export` uses the worker's find path. Filter, projection, sort, skip and limit
options work as they do for `find`. An environment is required; the database alias
is inferred only when the environment has exactly one. The default format is
canonical EJSON. JSON uses the same BSON conversion and precision checks as query
results. The filename extension does not choose the format.

The file contains one JSON/EJSON array with a trailing newline. Stdout contains a
JSON envelope with the resolved path, document count, file bytes, limits and
truncation status, without returned documents. Default and maximum document caps
are 100 and 1,000. The array is bounded to 512 KiB, plus one byte for its newline.
Truncation is a successful bounded export; check `truncated` and `truncationReason`
before treating the file as complete. Exports do not promise a full database
backup or stable pagination while documents change.

`--output` is required and must name a new file in an existing directory. Relative
paths resolve from the CLI working directory. Existing files, directories and
links are refused. A complete sibling temporary file is synced, closed and linked
to the destination without replacing a file created concurrently. This requires
filesystem hard-link support. Ordinary failures remove the temporary file and
leave the destination absent. Abrupt process termination can leave a private
`.runnel-export-*.tmp` file beside the destination. Linux files use mode 0600;
Windows relies on directory ACLs and has not yet been validated natively.

History records one `export` database operation without the filename, filter or
returned documents. Its outcome describes worker execution. A subsequent local
file-save failure is reported by the CLI and does not rewrite that history entry.
