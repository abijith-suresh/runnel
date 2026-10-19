# Runnel — agent brief
Named MongoDB targets in one user-wide catalog: humans register credentials once, agents run short commands without connection strings.

## The Project
Core promise: Humans register credentials and name targets once in a user-wide
catalog; agents then run short CLI commands (`list`, `describe`, `find`, `count`,
`aggregate`, `run`, `export`) without supplying a connection string. Start with a
CLI and MongoDB; MCP and other providers come later. Use Effect v4 and the
official MongoDB Node driver.

Non-goals: no MCP or other-provider package before implementation needs it; no
custom script DSL, workflow engine, or mongosh emulation; no separate read/write
approval gate (database-user permissions are authoritative); no publication,
GitHub releases, or auto-merge in the baseline.

Status: live (early stage) — core target selection, CLI setup/discovery/query/
script/export, daemon lifecycle, and operation history are implemented; MCP and
additional providers remain planned. Do not turn planned examples into
implemented commands as part of an unrelated change.

## How I Work Here
- Quality gate: `verify` — run `npm run verify` before handoff.
- Commits: Conventional Commits, enforced by `commitlint.config.mjs`
  (`@commitlint/config-conventional`). Squash merges; never commit to main.
- Add a nonempty **patch** Changeset to every ordinary PR, including docs and
  tooling. Never minor or major, even after 1.0. Release PRs use the guarded
  `npm run version:packages` command and consume existing Changesets.
- Branch with `feat/`, `fix/`, `chore/`, `docs/`, or `ci/`. Open a PR; never push
  to main, force-push, bypass hooks, auto-merge, or publish without explicit
  maintainer instruction.
- Core must not import MongoDB, concrete providers, or the CLI (Biome enforces
  this). MongoDB depends on core; the CLI composes both. Keep the three public
  versions and exact internal dependency versions aligned, and do not depend on
  private workspaces from a public unpacked artifact.
- Use npm workspaces, strict TypeScript, Node 24, ESM, and Effect v4 (never v3).
  Commit `package-lock.json`.
- Keep credentials, real URIs, returned documents, local catalogs, and operation
  histories out of the repository. Baseline checks need no database access.
- Add tests for meaningful behavior or policy, not empty modules. Update the
  document that owns the changed truth, and mark proposals and examples planned.
- Optional checks (`check:native-credentials`, `check:mongodb`, `install:local`)
  are excluded from `verify` and documented in `CONTRIBUTING.md`.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | § The Project (this file) |
| Runtime behavior | code + tests |
| Commands & deps | package.json |
| Commit rules | commitlint.config.mjs |
Code and tests are the authority; this file never overrides executable truth.

## Getting Around
- packages/core — provider contracts and shared concepts; exports `resolveDatabaseTarget` (names-only env/db selection)
- packages/mongodb — `createMongoPool`; one MongoDB client per registered connection
- apps/cli — CLI composition, catalog, daemon/worker, query/script/export commands (see apps/cli/README.md)
- scripts/ — release policy, packaging, and local-install checks
- .github/workflows/ci.yml — CI jobs and the required "Baseline verified" check
- README.md — status and architecture; CONTRIBUTING.md — development workflow
