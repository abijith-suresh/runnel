---
name: runnel
description: Use the Runnel CLI to discover named MongoDB databases, query or export data, and run attached JavaScript scripts without handling connection credentials.
---

# Runnel

## Overview

Runnel resolves configured environment and database names in a local worker.
Native MongoDB clients and pools stay in that worker. Work by name; a human
registers connections and enters credentials through the hidden terminal prompt.
Never ask for, print, pipe, or put a connection URI in arguments or script files.

Discover the available names before choosing a target:

```sh
runnel envs
runnel connections -e local
runnel databases -e local
runnel list -e local -d accounts
```

Use actual environment and connection names from discovery. Every database
operation requires explicit `-e` or `--env`. With a default connection, `-d` or
`--db` selects a physical MongoDB database without prior alias registration. A
matching alias retains its original mapping. `--connection NAME` selects a
physical database through that connection, bypassing aliases. Without `-d`, use
the default connection's URI database, or the sole configured alias if there is
no URI database. Explicit `--connection` uses only its own URI database when `-d`
is omitted. `authSource` never selects the database. Ambiguity requires an
explicit target. Legacy environments keep their original alias-only selection
unless a default is explicitly configured.

`databases` lists optional aliases and default metadata, not live MongoDB databases.
An empty alias list does not mean there are no accessible physical databases.
Use a physical database identified by the task; do not invent a target.
Environment names group registrations; they do not guarantee different physical
databases or isolation. Two aliases can point to the same database through
different credentials. Collection metadata such as `info.readOnly` does not
describe the current database user's permissions. Do not infer permission to
write from metadata or from a name such as `sandbox`.

Read `ok` in each JSON result envelope. Success data is under `data`; failures
have `error.code` and `error.message` and exit nonzero. CLI syntax failures use
stderr instead. Help, the guide, skill printing, and version output are plain
text. Check `data.truncated` when present before claiming a result is complete.

Choose built-in commands for ordinary work. Use `run` for native driver work
that needs JavaScript. Database-user permissions are authoritative. Runnel adds
no read/write approval gate. Aggregation stages and scripts can write data;
result limits do not limit their side effects.

Use `runnel help` for available commands and `runnel help <command>` or
`runnel <command> --help` for exact options. For a management action, use
`runnel help database rename` or `runnel database rename --help`. These help
commands need no operands, catalog, credentials, or database access.
Offline details are available with `runnel guide query`, `runnel guide scripts`, `runnel guide errors`, and
`runnel guide management`. `runnel guide all` prints the whole guide.
`runnel skill path` prints this installed file's absolute path;
`runnel skill print` prints its content. Use the agent tool's own skill-loading
mechanism if needed. Installation does not write agent configuration.

## Query

Inspect collection metadata and indexes, then sample documents to learn field
names and BSON types. `describe` does not infer a document schema, and a small
sample does not establish every document's shape.
MongoDB can return an empty result for a collection that does not exist. An empty
`find`, zero `count`, or empty export therefore does not prove the collection
exists. Confirm its name with `list` or `describe` before interpreting that result.

```sh
runnel describe users -e local -d accounts
runnel find users -e local -d accounts --limit 5
runnel find users -e local -d accounts --filter-file filter.ejson --projection-file projection.json --limit 20
runnel count users -e local -d accounts --filter-file filter.ejson
runnel aggregate users -e local -d accounts --pipeline-file pipeline.json --limit 20
runnel export users -e local -d accounts --filter-file filter.ejson --output selected.ejson
```

Filters, projections, sorts, and pipelines accept JSON or MongoDB EJSON. Prefer
files for complex input to avoid shell quoting problems. Each input is limited
to 256 KiB. Choose inline input or its `-file` variant for each option. A filename
of `-` reads stdin; only one input option can use stdin per command. Filters and
projections are objects; pipelines are arrays of stage objects. Sort objects use
`1` or `-1` directions. `find` and `export` also support `--skip`.

Canonical EJSON is the default. Preserve wrappers when interpreting values or
building subsequent filters. Examples of field values are `{"$oid":"..."}` for
ObjectId, `{"$numberInt":"3"}` for Int32, `{"$numberLong":"9007199254740993"}`
for Int64, `{"$numberDouble":"3.5"}` for Double, and
`{"$numberDecimal":"3.50"}` for Decimal128. A date can appear as
`{"$date":{"$numberLong":"1704067200000"}}`. These are typed field values,
not extra document fields. Envelope fields such as `limits.documents` remain
ordinary JSON numbers. Count is a safe JSON integer or an EJSON Int64 wrapper.

For example, `filter.ejson` can contain an exact large-integer predicate:

```json
{"sequence":{"$gte":{"$numberLong":"9007199254740993"}}}
```

`--format json` selects relaxed Extended JSON, which still has wrappers for
types such as ObjectId and Decimal128. It rejects unsafe Int64 conversion with
`ResultPrecisionLoss` rather than rounding. Use EJSON for exact BSON values;
ordinary JSON integer literals must fit JavaScript's safe integer range.

`find`, `aggregate`, and `export` default to 100 documents. `--limit` accepts
1 through 1000. Returned arrays also have a 512 KiB budget. Check `truncated`,
`truncationReason`, and `limits` under `data`. Truncation can succeed with zero
documents when the first document is too large. Reduce fields with a projection.
A limit bounds returned documents, including for pipelines with `$out` or
`$merge`; it does not limit writes. Never replay a writing pipeline just because
its output was truncated.

Exports contain a single JSON/EJSON array plus a newline. Stdout reports the
saved path, counts, limits, and truncation instead of documents. `--output` must
name a new file in an existing directory. The extension does not select the
format. Export is bounded, not a full backup. For additional read results, choose
an explicit stable sort and pagination suited to the task. There is no built-in
continuation token or snapshot guarantee while data changes.

## Scripts

Write an ES module ending in `.mjs` or `.js` that default-exports an async
function. Entry paths resolve from the CLI's working directory. The injected
signature is `{ db, args, connect, signal, bson }`:

```js
export default async function ({ db, args, connect, signal, bson }) {
  const user = await db.collection("users").findOne(
    { _id: new bson.ObjectId(args.id) },
    { signal, projection: { _id: 1, active: 1 } }
  );
  const reporting = await connect({ env: "local", db: "reporting" });
  const events = await reporting.collection("events").countDocuments({}, { signal });
  return { user, events };
}
```

```sh
runnel run lookup.mjs -e local -d accounts --args-file args.json --timeout 30s
```

`db` is the selected native MongoDB database. `connect` takes an explicit
environment, optional database and optional connection, using the same target
selection rules as the CLI.

An operation uses one catalog snapshot, including default selection and aliases first visited by later
`connect()` calls. Catalog edits become visible on the next operation. Acquired
handles keep their credentials until the operation finishes. A mapping change
during credential recovery can return `TargetChanged`. Inspect possible writes
before starting another operation; Runnel never replays database work.

Use `bson` for native values such as `ObjectId`, `Long`, and `Decimal128`;
no separate driver install is needed for these injected helpers. Script imports
otherwise follow Node module resolution from the script's location. Scripts
execute with the worker user's OS and database permissions.

Choose `--args` or `--args-file`; `--args-file -` reads stdin. Arguments default
to `{}` and accept plain JSON up to 256 KiB. EJSON-looking argument objects stay
plain data. Construct BSON values inside the script, for example
`bson.Long.fromString(args.sequence)` when passing a large integer as a string.

Await all work and pass `signal` to driver operations that support it. Return
bounded data, not handles or cursors. Results appear in `data.value` and have a
512 KiB cap. Top-level `undefined` becomes `null`; nested `undefined` is rejected.
Use `null` or omit missing properties. Console output from the worker is discarded.

The default deadline comes from `settings.scriptTimeoutMs`, initially five
minutes. `--timeout` accepts one integer with one unit, such as `1500ms`, `30s`,
`5m`, or `1h`; `0` disables it. Use `150s` instead of `2m30s`. The maximum is
2147483547 ms. Queue waiting is separate from the active deadline.

Scripts stay attached to the CLI. Interruption or client loss cancels their
work without replay. Cancellation, timeout, worker reset, or disconnection can
leave writes committed with their outcome unknown. Do not automatically rerun
a script that may have written data. Inspect database state first.

Modules are cached in the persistent worker. After editing a previously loaded
entry, an imported dependency, or a failed import, use `runnel daemon reset`
before running it again. Entry changes can report `ScriptChanged`. Reset drops
modules and pools and interrupts active and queued work without replay, so
coordinate it with any other work using this catalog.

## Errors

Check exit status, the JSON envelope when present, and stderr. Fix the specific
cause before retrying.

CLI syntax diagnostics distinguish unknown commands/options, missing operands or
option values, invalid actions, and unsupported flags. They go to stderr with
exit status 1 and empty stdout, before catalog access, daemon activity, or stdin
reads. Follow the help pointer in the diagnostic. Help allows omitted operands
but still rejects invalid actions and unsupported or malformed flags. Use
`--option=<value>` for values starting with a dash, and `--` before operands
starting with a dash. Tokens after `--` are operands, including `--help`.
Use `-e local` or `-elocal` for short options, or `--env=local` with an equals
sign. `-e=local` selects the literal name `=local`.

- `EnvironmentRequired` or `EnvironmentNotFound`: use `runnel envs`, then supply
  an explicit configured `-e`. If no suitable target exists, have a human run
  `runnel setup` in an interactive terminal.
- Missing or ambiguous target: use `runnel connections -e <environment>` and
  `runnel databases -e <environment>`. Select the physical `-d` through the default
  connection, a configured alias, or explicit `--connection NAME -d DATABASE`.
- `InputInvalid` or `InputTooLarge`: check command help, input shape, duration
  syntax, mutually exclusive flags, and file size. Files must be UTF-8 regular
  files or `-` for stdin.
- `ResultPrecisionLoss`: choose canonical `--format ejson`.
- `ResultTooLarge` or `ResultEncodingFailed`: return less data, use a projection,
  and remove unsupported values such as nested `undefined` from script results.
- `ScriptChanged` or an import-related `ScriptInvalid`: fix the module and use
  `runnel daemon reset` before another attempt.
- Credential or authentication failures: have the human check the registered
  connection, database-user permissions, and unlocked OS credential storage.
  For `SecretNotFound` or rejected credentials, use `runnel connections -e ENV`
  and have the human run `runnel connection rotate NAME -e ENV` in a terminal.
  Retrying setup with the same name conflicts. Never request a URI or secret in
  agent chat.

An operation timeout, cancellation, worker failure, or lost connection does not
prove that a write failed or rolled back. Runnel does not replay these requests;
an agent should not automatically replay writes either. Inspect the current
database state and establish whether another attempt is needed. Reset or stop
does not undo database writes. `runnel history` helps locate recent sanitized
outcomes but cannot prove whether a write committed.

## Management

Humans can run `runnel ui` for the bundled foreground loopback manager, or
`runnel ui --open` to explicitly open its one-use browser pairing link. Agents
continue using these CLI operations. Opening/refreshing the manager is offline;
registration needs only an environment name and hidden URI. Explicit tests,
discovery and credential replacement may contact MongoDB. No browser query or
script editor is provided. Stop manager and Stop database daemon are separate.

`runnel setup --env NAME` is for a human in an interactive terminal. One hidden
URI prompt saves the environment's default connection. No alias, database list,
connection label or repeated confirmation is required. Saving alone makes no
MongoDB connection; `--test` explicitly requests a bounded ping before saving.
URI syntax validation does not establish access. Bare `setup` asks the environment
first. Setup cannot accept a URI through flags or piped stdin. It never replaces
an existing connection. Additional connections use `setup --env NAME --connection
LABEL`, optionally with `--default`. A human can replace an existing connection's
credentials with `connection rotate LABEL -e NAME`.

`runnel config` shows redacted configuration without URIs, secret references or
credential-availability checks. `runnel settings` reads effective values, bounds
and application timing. `runnel settings set --idle-timeout-ms 300000
--script-timeout-ms 60000 --history-enabled false` updates selected fields offline
under the catalog lock. Supply one or more supported fields; durations are whole
milliseconds and booleans are exactly `true` or `false`. Defaults are five minutes
for both timeouts and history enabled. Zero disables the respective timeout.
Idle settings apply at the next daemon start, script defaults to the next request
without `--timeout`, and history settings to new submissions. Settings writes do
not restart services or interrupt active work; existing history remains.

`runnel connection test NAME -e ENV` explicitly pings a registered connection in
the worker without listing databases. `runnel connection databases NAME -e ENV`
explicitly lists authorized databases, capped at 1000 with truncation. Listing
permission may be denied even when known database operations work. These checks
are bounded and never expose stored credentials. Config/settings/status reads do
not start database work, check the vault or keep an idle worker alive.

Manage catalog mappings with these commands when the task requires it:

```sh
runnel database add reporting -e local --connection primary --database reports
runnel database rename reporting -e local --to analytics
runnel database remove analytics -e local
runnel connection default primary -e local
runnel connection remove primary -e local
```

Alias changes never create, rename, or delete physical databases. Adding an alias
does not verify database access. A connection with aliases cannot be removed;
remove its aliases first. Removing the default clears it without promoting another
connection. `connection default NAME -e ENV` explicitly selects one. Credential rotation is human-only: run
`runnel connection rotate primary -e local` in an interactive terminal and enter
the replacement URI at the hidden prompt. It preserves aliases and default connection selection, updates the URI database,
and uses a bounded ping without listing databases. Subsequent
operations use the new credentials; already active work can use the old handle.
A `SecretCleanupFailed` warning means the catalog commit succeeded but an old
credential could not be removed from OS storage; do not repeat the mutation.

```sh
runnel envs
runnel connections -e local
runnel databases -e local
runnel history
runnel daemon status
runnel daemon reset
runnel daemon stop
```

Discovery and history use the local catalog without querying MongoDB or reading
credentials. Connection discovery omits secret references. History contains
sanitized operation outcomes, not query values, scripts, or returned documents.
Treat a `HistoryUnavailable` warning separately from the database result.

Database operations start a local daemon on demand. `daemon status`, `reset`,
and `stop` do not start a missing daemon. `reset` discards active and queued work
without replay and clears cached modules and pools. `stop` shuts down the daemon.
Normal idle/stop/reset asks the worker to close clients over private IPC and waits
for actual child exit. The close acknowledgement alone is not proof of exit.
Cleanup has a two-second grace window before force escalation. Active cancellation,
deadlines or broken workers force termination without replay; writes may already
have occurred. `stopping` means an owned child is still exiting.
After installing another Runnel version, stop the old daemon before new database
work. An idle daemon shuts down automatically.

For an isolated catalog, set `RUNNEL_HOME` to an absolute private directory.
Stop its daemon before changing that variable. Use the platform's environment
variable syntax; do not assume a particular home directory or shell. The guide
and bundled skill need no catalog, credential storage, or running daemon.

### Build identity

Run `runnel build-info` for the bounded offline installed-package receipt. Prepared
dev/alpha artifacts report one source SHA, channel, run and attempt across all
three packages. Ordinary source/local builds report `build: null`; use the human's
approved source/install receipt to identify them. `--version` remains plain text.
Neither command starts a daemon or accesses the vault/database. Preparation does
not authorize publication; stable/latest distribution remains disabled.
