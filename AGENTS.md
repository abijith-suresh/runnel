# runnel — agent brief
Agent-first named database access for a CLI and MongoDB.

## The Project
Core promise: A human registers an environment and a hidden MongoDB URI once in a user-wide catalog. That environment has a default connection; an agent chooses a physical database at operation time, or uses the URI's default database. Optional aliases and advanced multiple connections remain supported. Agents use `list`, `describe`, `find`, `count`, `aggregate`, `run`, `export` and never handle a URI. A detached local worker owns every native client and pool, so credentials stay in OS storage and driver handles never cross IPC. Saving registration needs no database enumeration or live connection. Start with the CLI and MongoDB; MCP and other providers come later.

Non-negotiables:
- Database-user permissions are authoritative; Runnel adds no read/write approval gate.
- No MCP or other-provider package before implementation needs it; no custom script DSL, workflow engine, or mongosh emulation.
- Never make a public unpacked artifact depend on a private workspace; keep the three published versions aligned.

Status: live, early stage. The CLI works end to end against MongoDB and ships an explicitly started local human management UI with redacted configuration/settings. Normal worker teardown uses bounded private IPC to await client close and actual child exit. Active cancellation and broken workers can require forced termination without replay. MCP and additional providers are planned.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | § The Project (this file) |
| Runtime behavior | code + tests |
| Commands & deps | package.json |
| How to work here | `CONTRIBUTING.md` |
| Commit rules | commitlint.config.mjs |

Code and tests are the authority; this file never overrides executable truth.
