# Runnel CLI

`@abijith-suresh/runnel` is the scoped public CLI package, with executable name
`runnel`. Bare npm `runnel` belongs to an existing package. The CLI depends on
the matching public core and MongoDB packages, plus Effect v4.

The CLI supports information flags, human setup, offline discovery, collection listing, and
daemon lifecycle commands:

```sh
runnel --help     # also -h; no arguments show help too
runnel --version  # also -v
runnel setup
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

History, scripts, and other database commands remain planned. The library entry point still exports an empty
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
