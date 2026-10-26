# Runnel core

`@abijith-suresh/runnel-core` selects database targets from supplied environment
configuration. It performs no I/O and does not import concrete providers or applications.

Pass `resolveDatabaseTarget` a read-only map of environment names to sets of
database alias names, the requested `env`, and an optional `db`:

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

Build with `npm run build` at the repository root; run its tests with
`npm test --workspace @abijith-suresh/runnel-core`.

See [the repository](https://github.com/abijith-suresh/runnel) for design and
development documentation. This package has not been published.

`resolveConnectionTarget` accepts a map of environment names to `EnvironmentTargets`.
Each supplies `connections` and `databases` maps and an optional `defaultConnection`.
It returns `{ env, db, connection, database }`, preserving an alias in `db` while
`database` identifies the physical target. Explicit aliases take precedence over
physical selection through the default connection. An explicit `connection`
selects physical names and bypasses aliases. Omission of `db` uses the default
connection's `defaultDatabase`, then a sole alias; an explicit connection uses
only its own default database. It never invents a default connection for legacy
configuration. The original `resolveDatabaseTarget` API above stays unchanged.
Provider-specific physical name validation belongs to the caller.
