# Current architecture

This document describes the development baseline. Runtime plans live in
[DESIGN.md](DESIGN.md).

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
reserve the agreed boundaries; no adapter or contracts exist yet. The library
entry points export empty modules. The executable writes a baseline notice and
sets exit status 1. It has no parser or implemented commands.

All workspaces are publishable with public access and fixed, aligned versions.
The CLI uses ordinary package dependencies rather than bundling. The future
release must make core and MongoDB available with the CLI. There are no private
runtime dependencies, custom bundlers, or postinstall behavior.

## Tooling

Node and npm are pinned in `mise.toml`; `.node-version` supports setup-node and
other version managers. TypeScript uses NodeNext and strict checks, including
exact optional properties and unchecked indexed access. Biome owns JavaScript,
TypeScript, and JSON formatting and lint. It also restricts concrete provider
imports from core. Markdown is reviewed as prose; Biome does not format it.

Husky, lint-staged, and commitlint follow Outpost's local workflow. CI reuses the
owner's shared quality and title workflows. The local release policy and tests
validate Changesets and actual Git version diffs. Packaging verification checks
exports, declarations, executable destinations and shebang, then installs local
tarballs outside the workspace and checks module resolution.

The baseline has no database fixtures or runtime tests. Verification imports
dependency modules without creating clients or accessing credentials. No package
is published by any baseline command or CI workflow.
