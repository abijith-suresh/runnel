# Current architecture

This document describes the development baseline and implemented core behavior.
Runtime plans live in [DESIGN.md](DESIGN.md).

## Workspaces

The private root coordinates three public npm packages. TypeScript project
references build core, MongoDB, then CLI. Each workspace emits ESM JavaScript,
declarations, declaration maps, and source maps into its own `dist/` directory.
Exports resolve to compiled files. `runnel` resolves to `apps/cli/dist/cli.js`.

```text
apps/cli -> packages/mongodb -> packages/core
         -> packages/core
```

Core declares Effect v4. MongoDB declares core, Effect v4, and the official
MongoDB driver. CLI declares core, MongoDB, and Effect v4. These dependencies
reserve the agreed boundaries; no provider adapter or provider contracts exist
yet. Core exports database target selection. The MongoDB and CLI library entry
points still export empty modules. The executable supports help/version flags
only. No database commands are implemented.

All workspaces are publishable with public access and fixed, aligned versions.
The CLI uses ordinary package dependencies rather than bundling. The future
release must make core and MongoDB available with the CLI. There are no private
runtime dependencies, custom bundlers, or postinstall behavior.

## Tooling

Node and npm are pinned in `mise.toml`; `.node-version` supports setup-node and
other version managers. TypeScript uses NodeNext and strict checks, including
exact optional properties and unchecked indexed access. The compiler includes
the DOM type library because Effect 4.0.1 declarations reference web-platform
types such as `TextDecoderOptions`. Dependency declaration checking stays enabled;
the runtime remains Node. Biome owns JavaScript,
TypeScript, and JSON formatting and lint. It also restricts concrete provider
imports from core. Markdown is reviewed as prose; Biome does not format it.

Husky, lint-staged, and commitlint follow Outpost's local workflow. CI reuses the
owner's shared quality and title workflows. The local release policy and tests
validate Changesets and actual Git version diffs. Temporary policy fixtures clear
inherited Git variables so hooks in a worktree cannot redirect fixture commands
to the caller's repository. Packaging verification checks exports, declarations,
executable destinations and shebang, then installs local
tarballs outside the workspace and checks module resolution.

Core and CLI behavior tests use Node's test runner and `.mts` files, checked with
the same strict TypeScript settings as source. `npm run verify` runs them along with release
policy tests. There are no database fixtures. Verification imports dependency
modules without creating clients or accessing credentials. No package is
published by a development command or CI workflow.

## Database target selection

`resolveDatabaseTarget` takes a read-only map of environment names to sets of
database alias names, plus requested `env` and `db` names. This names-only input
does not define catalog storage, physical database mappings, or provider contracts.

The pure function returns an Effect v4 `Result` containing selected names or a
typed selection error. Environment selection is always explicit. A missing
database is inferred only when the selected environment has exactly one alias.
Unknown environments and databases fail. Zero aliases and multiple aliases have
distinct errors when no database was supplied. Names match exactly; the function
does not trim or change case, and explicit empty strings do not trigger defaults.

The error tags describe core selection failures. They are not a finalized CLI or
IPC JSON envelope. The function performs no I/O and does not mutate supplied names
or the request. No CLI command uses it yet.

## CLI information flags

The executable uses Node's built-in `parseArgs` for `--help`/`-h` and
`--version`/`-v`. No arguments show help. Help takes precedence when both flags
are supplied. Success writes to stdout and exits with status 0. Unknown flags,
positional commands, and malformed options produce a concise stderr diagnostic
and exit with status 1, without echoing the supplied arguments.

Version output reads the owning package's `package.json` relative to the compiled
entry point, independently of the working directory. It reflects the installed
artifact's version after Changesets updates metadata. Missing or invalid version
metadata produces a stderr diagnostic and status 1 when the executable can load.

These small process and package-metadata boundaries use Node APIs directly. No
database dependencies, catalog, or daemon are initialized. Output envelopes for
future database commands remain a design task; help/version use plain text.
