# Agent instructions

## Scope and sources of truth

Runnel currently implements in-memory database target selection in core and CLI
help/version flags. The MongoDB adapter remains a packaging stub. Additional
product work needs an explicit task. Do not turn planned examples into implemented commands as part of
an unrelated change.

| Document or code | Responsibility |
| --- | --- |
| `README.md` | Current status and repository navigation |
| `docs/DESIGN.md` | Agreed product intent, planned commands, unresolved decisions |
| `docs/ARCHITECTURE.md` | Current package and build architecture |
| `CONTRIBUTING.md` | Development commands and PR process |
| `docs/RELEASING.md` | Patch-only release process and publication boundaries |
| Manifests and `package-lock.json` | Dependency and tool versions |
| `.github/workflows/` and `scripts/` | Executable CI and release-policy truth |

Implementation and tests determine actual behavior. Design documents do not
promise that a feature already exists. Preserve that distinction in prose.

## Development rules

- Work in this bound repository. Do not modify Planview, Outpost, or workflows
  while using them as references.
- Use branches and PRs after the initial bootstrap. Never push directly to main,
  force-push main, bypass hooks, auto-merge a PR, or publish without an explicit
  maintainer instruction.
- Run `npm run verify` before pushing. Use Conventional Commits and the PR template.
- Add a nonempty patch Changeset to every ordinary PR, including feature additions.
  Do not use minor or major bumps, even after 1.0. Release PRs use the guarded
  `npm run version:packages` command and consume existing Changesets.
- Use npm workspaces, strict TypeScript, Node 24, and ESM. Commit the lockfile.
- Use Effect v4. Check official documentation for v4 API changes before product
  implementation. Do not substitute v3 or introduce an Effect demo as product code.
- Core owns provider contracts and shared concepts and must not import MongoDB,
  concrete providers, or the CLI. MongoDB depends on core; the CLI composes both.
- Keep the three public versions and exact internal dependency versions aligned.
  Do not add dependencies on private workspaces to a public unpacked artifact.
- Keep credentials, real URIs, returned documents, local catalogs, and operation
  histories out of the repository. Baseline checks need no DB access.
- Add tests for meaningful behavior or policy enforcement, not empty modules.
- Update the document that owns the changed truth. Keep prose plain and mark
  proposals, examples, and unresolved decisions as planned.

The current scope does not include credentials, catalog persistence, database
access, daemon/worker behavior, provider behavior, scripts, MCP, or another provider.
Core selects environment and database alias names from supplied in-memory names.
The adapter remains a packaging stub. The CLI supports only help/version and has
no database commands or integration with core target selection yet.
