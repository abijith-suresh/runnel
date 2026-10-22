# Runnel

Runnel is agent-first named database access. Humans register
credentials and name targets; agents use short commands without supplying
connection strings.

Core now implements database target selection from supplied in-memory names.
It requires an explicit environment and infers a database only when that
environment has exactly one alias. The CLI supports help/version and offline
discovery of configured environments, connections, and database aliases from a
validated user-wide catalog. Running it with no arguments shows help.
Internal helpers support catalog updates, native OS credentials, and a persistent
worker with MongoDB pools. `list` now starts a local daemon and lists collections
for a configured alias. `daemon status`, `daemon reset`, and `daemon stop` manage
its lifecycle. `setup` prompts for a hidden URI, discovers databases, and
registers named aliases with credentials in OS storage. `describe`, `find`, `count`,
and `aggregate` now return bounded JSON/EJSON results. Local operation history is
on by default. `run` executes attached JavaScript with native database handles,
JSON arguments, deadline options, and cancellation without replay. `export` saves bounded JSON/EJSON arrays to new files.
`connection rotate` replaces credentials without renaming aliases. `connection remove`
and `database add`, `rename`, and `remove` manage existing catalog registrations.
MCP remains planned. See
[CLI usage](apps/cli/README.md) for implemented commands and
[CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, releases, and
local testing.

## Development

Use the exact Node and npm versions in `mise.toml`. Then run:

```sh
npm ci
npm run verify
```

`verify` checks release policy, formatting, lint, builds, strict typechecking,
release-policy tests, workspace behavior tests, and package distribution. The
packaging check runs npm pack dry runs and installs all three tarballs in a
temporary local consumer.
It does not publish or install anything globally.

| Workspace | Package | Intended ownership |
| --- | --- | --- |
| `packages/core` | `@abijith-suresh/runnel-core` | Provider contracts and shared application concepts |
| `packages/mongodb` | `@abijith-suresh/runnel-mongodb` | MongoDB adapter, depending on core |
| `apps/cli` | `@abijith-suresh/runnel` | CLI composition, executable `runnel` |

All three packages start at `0.0.1`, are configured for public npm distribution,
and use a fixed Changesets group. None has been published. The root is private.
The CLI's internal dependencies are public packages with matching exact versions,
so distribution does not depend on unpublished private workspaces. Bare npm
`runnel` is already taken; this project uses the scoped package.

## Architecture

The private root coordinates three public npm packages with TypeScript project
references building core, MongoDB, then CLI:

```text
apps/cli -> packages/mongodb -> packages/core
         -> packages/core
```

- `packages/core` — provider contracts and shared concepts. It must not import
  MongoDB, concrete providers, or the CLI; Biome enforces this.
- `packages/mongodb` — MongoDB connection pools for the worker. One client per
  registered connection: aliases share a client, independent registrations do not.
- `apps/cli` — CLI composition: catalog, daemon and persistent worker, query,
  script, export, and history commands. Native driver handles stay inside the
  worker and never cross IPC (JSON application values only).

The CLI uses a user-wide `catalog.json` (`$XDG_CONFIG_HOME/runnel` or
`~/.config/runnel` on Linux; `%APPDATA%/runnel` on Windows; an absolute
`RUNNEL_HOME` overrides it). The validated schema version 1 requires
`settings.idleTimeoutMs`, `settings.scriptTimeoutMs`, and `environments`. Each
environment holds `connections` (provider plus a `keyring:runnel/<id>` secret
reference) and named `databases` mapping a connection to a physical database
name. No credential is stored in the file. Names use 1-64 ASCII letters, digits,
underscores, or hyphens; `settings.historyEnabled` (default true) disables
history for new work. A detached local daemon starts on the first database
operation and supervises one worker with warm connection pools; five minutes of
inactivity shuts it down while active or queued work prevents it. Operation
history is on by default in a private file below the catalog directory.

All three packages are public and share a fixed Changesets group with matching
exact internal versions. The baseline has no publication, bundler, or postinstall
behavior. `npm run verify` runs release policy, formatting, lint, strict builds
and typechecks, policy and workspace tests, and isolated packaging checks without
database or credential configuration. See [CLI usage](apps/cli/README.md) and the
package READMEs for implemented command behavior.

Create a branch and a PR for every subsequent change. All releases use patch
increments, including new functionality. See [contributing](CONTRIBUTING.md) for
the workflow, checks, and release process.

## License

MIT. See [LICENSE](LICENSE).
