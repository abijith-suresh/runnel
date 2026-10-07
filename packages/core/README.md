# Runnel core

`@abijith-suresh/runnel-core` is a public package boundary for future provider
contracts and shared application concepts. It must not import concrete providers
or applications. Effect v4 is declared for future orchestration.

Core exports `resolveDatabaseTarget`. Supply a read-only map of environment names
to sets of database alias names, and the requested `env` and optional `db`:

```ts
import { resolveDatabaseTarget } from "@abijith-suresh/runnel-core";

const names = new Map([["dint", new Set(["accounts"])]]);
const result = resolveDatabaseTarget(names, { env: "dint" });
// Result.succeed({ env: "dint", db: "accounts" })
```

The function returns an [Effect v4 Result](https://effect.website/docs/v4/data-types/result).
It always requires an environment and infers the database only when that
environment has exactly one alias. Explicit names must match exactly. Failures
use `EnvironmentRequired`, `EnvironmentNotFound`, `NoDatabases`, `DatabaseRequired`,
or `DatabaseNotFound` tags, with relevant requested names. Use `Result.isSuccess`
or `Result.isFailure` to narrow the result and access its `success` or `failure`.

This is an in-memory selection API, not a persisted catalog schema or CLI error
envelope. It performs no I/O and has no provider contracts or database behavior.
Build with `npm run build` at the repository root; run its tests with
`npm test --workspace @abijith-suresh/runnel-core`.

See [the repository](https://github.com/abijith-suresh/runnel) for design and
development documentation. This package has not been published.
