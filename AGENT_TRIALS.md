# Installed CLI agent trials

DeepSeek V4.1 Flash through OpenCode tried isolated local tarball installations
on Linux with Node 24.19.0. Trials used synthetic MongoDB data and native
credential entries in a private catalog. Agents received named access, not URIs,
and were prohibited from reading source, catalog files, or credential storage.
These are observed trials, not a benchmark or a guarantee for every agent.

## Baseline

An offline trial exercised about 35 invocations without a registered connection.
The agent found the installed README only by inspecting the package directory.
There was no skill or guide command, and help did not point to documentation.
The script function contract and large-integer argument handling were especially
hard to discover. Query validation errors named several unrelated constraints
instead of identifying the failing option.

A separate live trial completed discovery, filtered queries, aggregation,
exports, scripts across named targets, and allowed and denied writes. It
calculated paid revenue of 170, preserved the Int64 value 9007199254740993, and
recognized that one bounded export of a 1100-document collection was incomplete.
It needed the package README to learn the script contract and result budgets.

## Updated CLI

A fresh agent found `runnel guide` and `runnel skill path` directly from help,
located and used the installed `SKILL.md`, and completed the same data tasks.
The agent used `connect({ env, db })` on its first attempt, preserved the exact
large integer, checked export truncation, and demonstrated a permitted write and
a denied write through separate credential registrations. It also added,
renamed, queried through, and removed a temporary alias, restoring the catalog.
Its own scripts and exports were removed after the trial.

The resulting changes include offline guide topics, a bundled skill, script
contract and truncation details in help, and specific limit/format diagnostics.
The skill explains that environment names do not imply isolated databases and
that collection `info.readOnly` metadata does not describe user permissions.

## Remaining limitations

An empty result from `find`, `count`, or `export` does not distinguish a missing
collection from an empty one. This follows MongoDB behavior. Use `list` or
`describe` to establish that the intended collection exists before interpreting
an empty result. `describe` does not infer document schemas; sampling can miss
fields and types. A successful bounded export still requires checking
`truncated`, and pagination has no snapshot guarantee while data changes.

The trials did not validate native Windows terminal behavior. Independent code
review separately found two credential-rotation races; regression tests cover
stale credential resolution and preserving an active script's database handle.
