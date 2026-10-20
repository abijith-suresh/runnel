# runnel — agent brief
Agent-first named database access for a CLI and MongoDB.

## The Project
Core promise: A human registers a MongoDB connection and names its databases once
in a user-wide catalog. An agent then works by name — `list`, `describe`, `find`,
`count`, `aggregate`, `run`, `export` — and never handles a URI. A detached local
worker owns every native client and pool, so credentials stay in OS storage and
driver handles never cross IPC. Start with the CLI and MongoDB; MCP and other
providers come later.

Non-negotiables:
- Database-user permissions are authoritative; Runnel adds no read/write approval
  gate.
- No MCP or other-provider package before implementation needs it; no custom
  script DSL, workflow engine, or mongosh emulation.
- Never make a public unpacked artifact depend on a private workspace; keep the
  three published versions aligned.
- Do not turn planned examples into implemented commands as part of an unrelated
  change.

Status: live, early stage. The CLI works end to end against MongoDB; MCP and
additional providers are planned.

## How I Work Here
- Verification: run `npm run verify` before handoff, and add focused tests for
  the behavior you change.
- Commits: Conventional Commits; squash merges; never commit to main. Branch for
  every change and open a PR. Do not force-push main, bypass hooks, auto-merge,
  or publish without an explicit maintainer instruction.
- Every ordinary PR adds a nonempty patch Changeset, including docs and tooling.
  Never a minor or major, even after 1.0. Release PRs use the guarded
  `npm run version:packages` and consume existing Changesets.
- Effect v4 is the agreed effect system: check the official v4 docs before
  implementing, and never substitute v3 or ship an Effect demo as product code.
- Keep credentials, real URIs, returned documents, local catalogs, and operation
  histories out of the repository. Baseline checks need no database access.
- Update the document that owns the changed truth, and mark proposals, examples,
  and unresolved decisions as planned.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | § The Project (this file) |
| Runtime behavior | code + tests |
| Commands & deps | package.json |
| Commit rules | commitlint.config.mjs |

Code and tests are the authority; this file never overrides executable truth.
