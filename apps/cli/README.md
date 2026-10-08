# Runnel CLI

`@abijith-suresh/runnel` is the scoped public CLI package, with executable name
`runnel`. Bare npm `runnel` belongs to an existing package. The CLI depends on
the matching public core and MongoDB packages, plus Effect v4.

The CLI supports information flags, offline discovery, collection listing, and
daemon lifecycle commands:

```sh
runnel --help     # also -h; no arguments show help too
runnel --version  # also -v
runnel envs
runnel connections -e local
runnel databases -e local
runnel list -e local -d accounts
runnel daemon status
runnel daemon reset
runnel daemon stop
```

Help lists available flags and marks remaining commands as planned. Version output
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

Setup, history, scripts, and other database commands remain planned. Catalog and
credential helpers are internal; there is no interactive registration command
yet. The library entry point still exports an empty
module; there is no public CLI composition API.

For local development, build at the repository root and invoke the compiled CLI:

```sh
npm run build
node apps/cli/dist/cli.js --help
node apps/cli/dist/cli.js --version
node apps/cli/dist/cli.js envs
```

Run CLI tests with `npm test --workspace @abijith-suresh/runnel`.
`npm run pack:check` checks
all package artifacts and imports in a temporary local consumer without global
installation or publication.

See [the repository](https://github.com/abijith-suresh/runnel) for planned commands
and development documentation. This package has not been published.

The catalog is `catalog.json` under `$XDG_CONFIG_HOME/runnel` or
`~/.config/runnel` on Linux, and `%APPDATA%/runnel` on Windows. An absolute
`RUNNEL_HOME` overrides that directory for isolated testing. A missing catalog
returns empty discovery results. Invalid or unreadable catalogs fail; they do
not silently become empty. The CLI currently reads only. Human setup will create
the catalog in a subsequent change. Internal atomic catalog-write and native
credential helpers are implemented, but have no standalone CLI command.
Its schema is documented in
[the current architecture](../../docs/ARCHITECTURE.md#catalog-and-offline-discovery).
