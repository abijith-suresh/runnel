# runnel — agent brief
Agent-first named database access for a CLI and MongoDB.

## The Project
Core promise: A human registers a MongoDB connection and names its databases once in a user-wide catalog. An agent then works by name — `list`, `describe`, `find`, `count`, `aggregate`, `run`, `export` — and never handles a URI. A detached local worker owns every native client and pool, so credentials stay in OS storage and driver handles never cross IPC. Start with the CLI and MongoDB; MCP and other providers come later.

Non-negotiables:
- Database-user permissions are authoritative; Runnel adds no read/write approval gate.
- No MCP or other-provider package before implementation needs it; no custom script DSL, workflow engine, or mongosh emulation.
- Never make a public unpacked artifact depend on a private workspace; keep the three published versions aligned.

Status: live, early stage. The CLI works end to end against MongoDB; MCP and additional providers are planned.

## Sources of Truth
| Fact | Where |
|---|---|
| Product intent | § The Project (this file) |
| Runtime behavior | code + tests |
| Commands & deps | package.json |
| How to work here | `CONTRIBUTING.md` |
| Commit rules | commitlint.config.mjs |

Code and tests are the authority; this file never overrides executable truth.
