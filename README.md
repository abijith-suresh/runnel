# Runnel

Runnel is planned as agent-first named database access. Humans will register
credentials and name targets; agents will use short commands without supplying
connection strings.

Core now implements database target selection from supplied in-memory names.
It requires an explicit environment and infers a database only when that
environment has exactly one alias. No database access, credential storage,
catalog storage, daemon, worker, script runner, provider behavior, or MCP server
exists. The CLI supports `--help` and `--version`; running it with no arguments
shows help. All database commands in the design documents remain planned,
including setup and discovery. See [CLI usage](apps/cli/README.md) for the
implemented flags and local development commands.

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
