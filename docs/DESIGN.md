# Agreed product design

This document records the agreed product design. Core now implements in-memory
environment and database alias selection, described in
[the current architecture](ARCHITECTURE.md#database-target-selection). The CLI also
implements help/version flags. Database commands and all other product behavior
below remain **planned**. The document preserves
the decisions from the initial discussion so later tasks can build from them
without reconstructing it.

## Purpose and scope

Runnel is agent-first named database access. Humans register credentials and name
targets. Agents run short commands without supplying connection strings. Start
with a CLI and MongoDB. MCP and other providers come later. Use Effect v4 and the
official MongoDB Node driver.

Do not add an MCP or PostgreSQL package before implementation needs it. The
baseline has core, MongoDB, and CLI boundaries only. Exact provider contracts
remain future implementation work.

## Named targets and human setup

One user-wide catalog is available from any working directory. An environment
can contain multiple connections and databases, eventually across providers.
Each connection belongs to one environment. Reusing a URI elsewhere means
registering it independently in that environment.

Each environment has named database aliases. An alias maps a connection name to
a physical database name. Commands use those names rather than credentials.

Connection strings belong in OS credential storage. The catalog contains only
secret references. Human setup prompts for a hidden URI, lists accessible
databases, and lets the human choose and name aliases. Manual database entry
remains possible. The OS credential library and catalog persistence mechanism
have not been chosen or implemented.

Every database command requires `-e` or `--env`. Infer `-d` or `--db` only when
that environment has exactly one database alias. Do not put a `mongo` prefix in
command names. Discovery of configured names can work offline.

Database-user permissions are authoritative in v1. Runnel adds no separate
read-only/write policy or approval gate. Permission denials should produce
useful structured errors.

## Daemon, worker, and connection ownership

The CLI auto-starts a daemon on its first database operation. Five minutes of
inactivity shuts the daemon down. Active or queued work prevents idle shutdown.
This idle timeout is separate from a script's execution deadline.

The daemon supervises **one persistent worker**. That worker owns every
MongoClient and connection pool, and executes both built-ins and scripts locally.
Only application requests and results cross IPC. Native driver `Db`, cursor, and
client handles never cross IPC and are never replaced by a custom driver proxy.

Built-ins and repeated scripts reuse warm connections. Restarting the worker
clears pools and loaded modules. Application commands queue with one active
application operation at a time. Within that operation, a script may query
different environments in parallel.

The prior research thread was `mcp:4498efc8-20cb-44e4-9be9-b42471eff35a`, titled
"Runnel: research JavaScript script execution". Its recommendation supports
this single persistent worker architecture, local native driver handles, and
explicit resets. That recommendation is preserved here; the baseline does not
implement or repeat the research.

## Scripts

Scripts stay attached to the CLI. A script is a plain JavaScript ES module with
a default async function receiving `{ db, args, connect, signal, bson }`.

- `db` is the actual MongoDB driver `Db` local to the worker.
- `args` comes from JSON input inline, a file, or stdin.
- `connect({ env, db })` resolves another named alias and returns a real local `Db`.
- `signal` supports operation cancellation.
- `bson` supplies `ObjectId` and related BSON utilities. The script directory
  does not need its own MongoDB driver installation.

This is a contract sketch, not implemented code:

```js
export default async function ({ db, args, connect, signal, bson }) {
  // Future user-authored JavaScript runs here, in the worker with real driver handles.
}
```

Use no custom DSL, workflow engine, or mongosh API emulation. Ordinary awaited
script errors become structured results. A forced restart must not blindly rerun
a script, because it might already have changed data.

The default script deadline is five minutes. `--timeout` can extend it; `0`
disables the deadline. This is independent of the daemon's idle timeout.

Runner restarts are acceptable when needed. Prior research suggests resetting
when an already-used entry script changes. Changes only in imported dependencies
may require an explicit daemon reset. The exact reset, change detection, and
module loading mechanisms remain implementation decisions to review later.

## Output, export, and local history

Use machine-readable JSON envelopes with MongoDB EJSON support, explicit bounds
and truncation indicators, diagnostics on stderr, structured errors, and nonzero
exit statuses for failures. Support JSON and EJSON exports. Mongo-native
dump/restore is not a requirement.

Lightweight local operation history is on by default. Record named targets,
operation, timestamp, duration, and outcome. Do not record credentials, arguments,
script bodies, returned documents, or unsanitized errors that carry documents.

Create one history entry per application operation. Arbitrary JavaScript may make
many driver calls; history is not an audit log for each of those calls.

Routine query/export limits, history retention, and exact BSON numeric behavior
remain implementation defaults or decisions. No finalized values are claimed here.

## Planned command examples

These commands do not run in the development baseline:

```sh
runnel setup
runnel envs
runnel connections -e dint
runnel databases -e dint
runnel list -e dint -d accounts
runnel describe users -e dint -d accounts
runnel find users -e dint -d accounts --filter-file filter.json
runnel count users -e dint -d accounts
runnel aggregate users -e dint -d accounts --pipeline-file pipeline.json
runnel run compare.mjs -e dint -d accounts --args-file args.json --timeout 5m
runnel export users -e dint -d accounts --output users.ejson
runnel daemon status
runnel daemon reset
runnel daemon stop
```

## Draft catalog

This is a planning example, not a committed schema or storage contract. Names
and the secret reference are illustrative; there is no actual connection string.

```json
{
  "schemaVersion": 1,
  "settings": {
    "idleTimeoutMs": 300000,
    "scriptTimeoutMs": 300000
  },
  "environments": {
    "dint": {
      "connections": {
        "primary": {
          "provider": "mongodb",
          "secretRef": "keyring:runnel/connection-01"
        }
      },
      "databases": {
        "accounts": {
          "connection": "primary",
          "database": "revinDb_dint"
        }
      }
    }
  }
}
```

## Baseline decisions and references

The baseline follows the npm workspace, Node 24, TypeScript/ESM, Biome,
Conventional Commit, and Changesets practices read from the local Planview and
Outpost repositories. Planview's GitHub repository is
[`abijith-suresh/planview`](https://github.com/abijith-suresh/planview); its CLI's
executable is `plansplease`. Outpost is
[`abijith-suresh/outpost`](https://github.com/abijith-suresh/outpost).
Those projects were inspected read-only. App, website, and provider implementations
were not copied into Runnel.

Compatible quality and title workflows come from
[`abijith-suresh/workflows`](https://github.com/abijith-suresh/workflows/tree/0424bd486ad1c3e0bbb4d206886dec114872eb68).
The shared Release Please workflow is not appropriate for this Changesets policy.
Publication remains a separate future maintainer task.

Dependency choices were checked against npm metadata on 2026-10-06. The pinned
Effect is stable v4, supported by the official
[Effect 4.0.1 release](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.1).
No Effect v3 substitution was made. The adapter uses the
[official MongoDB Node driver](https://www.mongodb.com/docs/drivers/node/current/).
Its pinned package declares Node `>=20.19.0`, which the selected Node 24 runtime
satisfies. This verifies development compatibility without claiming compatibility
with any real database deployment. Exact dependency versions live in manifests
and the lockfile.
