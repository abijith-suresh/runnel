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
JSON arguments, deadline options, and cancellation without replay. `export` saves bounded JSON/EJSON arrays to new files. MCP remains planned. See
[CLI usage](apps/cli/README.md) for implemented commands and
[the development milestone](docs/DEVELOPMENT.md) for ongoing work.
The [local testing guide](docs/LOCAL_TESTING.md) covers manual use and the optional
installed-package MongoDB check.

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

Create a branch and a PR for every subsequent change. All releases use patch
increments, including new functionality. See [contributing](CONTRIBUTING.md),
[release policy](docs/RELEASING.md), [current architecture](docs/ARCHITECTURE.md),
and [the agreed product design](docs/DESIGN.md).

## License

MIT. See [LICENSE](LICENSE).
