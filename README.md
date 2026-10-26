# Runnel

Runnel gives agents named access to MongoDB. A human registers an environment and a hidden
connection URI once. Agents choose physical databases at operation time; optional
aliases still work. Credentials stay in OS storage; agents use the
names without handling connection strings.

```sh
runnel setup --env local           # one hidden URI prompt in a terminal
runnel databases -e local
runnel find users -e local -d accounts --limit 10
runnel guide                       # offline agent instructions
```

The CLI supports discovery, collection metadata, bounded JSON/EJSON queries and
exports, JavaScript scripts with native database handles, registration management,
and local operation history. A detached local daemon keeps the worker and its
MongoDB pools alive between commands. Database-user permissions govern all work;
Runnel adds no read/write approval gate. MCP and other providers are planned.

See [CLI usage](apps/cli/README.md) for commands and limits,
[contributing](CONTRIBUTING.md) for local installation and development, and
[agent trials](AGENT_TRIALS.md) for observed usability and remaining limitations.

## Development

Use the exact Node and npm versions in `mise.toml`. Then run:

```sh
npm ci
npm run verify
```

`verify` checks release policy, formatting, lint, builds, strict typechecking,
policy and behavior tests, and isolated tarball installs. It needs no database
or credential configuration and does not publish or install anything globally.

| Workspace | Package | Responsibility |
| --- | --- | --- |
| `packages/core` | `@abijith-suresh/runnel-core` | In-memory database target selection |
| `packages/mongodb` | `@abijith-suresh/runnel-mongodb` | Worker-owned MongoDB connection pools |
| `apps/cli` | `@abijith-suresh/runnel` | Catalog, daemon, worker, and executable `runnel` |

All three packages are configured for public npm distribution with matching exact
versions and a fixed Changesets group. None has been published. The root is
private; unpacked artifacts depend only on public packages. Bare npm `runnel`
is already taken, so this project uses the scoped package.

## Architecture

The private root coordinates three public npm packages with TypeScript project
references building core, MongoDB, then CLI:

```text
apps/cli -> packages/mongodb -> packages/core
         -> packages/core
```

Core must not import concrete providers or the CLI. Biome rejects MongoDB imports
in core.
MongoDB pools use one client per registered connection. Aliases share a client;
independent registrations do not. Native driver handles stay inside the worker.
Only JSON application values cross IPC.

The CLI uses a user-wide `catalog.json` (`$XDG_CONFIG_HOME/runnel` or
`~/.config/runnel` on Linux; `%APPDATA%/runnel` on Windows; an absolute
`RUNNEL_HOME` overrides it). Schema version 2 requires `settings.idleTimeoutMs`,
`settings.scriptTimeoutMs`, and `environments`. Each environment holds
`connections`, optional `defaultConnection`, and optional named `databases`
represented by an empty mapping when no aliases are needed. Connections contain
provider, a `keyring:runnel/<id>` secret reference, and an optional
`defaultDatabase` from the URI path. `authSource` never selects the target database.
No credential is stored in the file. Environment, connection and alias names use
1-64 ASCII letters, digits, underscores, or hyphens, excluding `__proto__`,
`constructor`, and `prototype`. Physical database names may contain Unicode and
are validated against MongoDB's cross-platform restrictions and 63-byte limit.

Version 1 catalogs remain readable with their original alias selection behavior.
Reads never rewrite them or infer defaults. The next catalog mutation atomically
writes version 2 under the catalog lock, preserving aliases, settings and secret
references. Older Runnel binaries reject version 2 rather than discard its fields;
unknown future versions also fail closed. After this upgrade, use a version 2
compatible CLI. Stop the old daemon before switching installations. Downgrading
the catalog in place is unsupported.

`runnel config` returns redacted connection/alias metadata and effective settings,
without credentials or secret references. `runnel settings` reads settings;
`runnel settings set` updates validated timeouts/history under the catalog lock.
These reads/writes are offline and never start database work. See the
[settings behavior](apps/cli/README.md#settings) for bounds and application timing.
A detached local daemon starts on the first database operation and supervises
one worker with warm connection pools; five minutes of
inactivity shuts it down while active or queued work prevents it. Operation
history is on by default in a private file below the catalog directory.

## License

MIT. See [LICENSE](LICENSE).
