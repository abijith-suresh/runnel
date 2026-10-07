import * as Result from "effect/Result";

/** Names available to select, independent of catalog storage and provider details. */
export type DatabaseAliasesByEnvironment = ReadonlyMap<string, ReadonlySet<string>>;

export interface DatabaseTargetRequest {
  readonly env?: string;
  readonly db?: string;
}

export interface DatabaseTarget {
  readonly env: string;
  readonly db: string;
}

export type TargetSelectionError =
  | { readonly _tag: "EnvironmentRequired" }
  | { readonly _tag: "EnvironmentNotFound"; readonly env: string }
  | { readonly _tag: "NoDatabases"; readonly env: string }
  | { readonly _tag: "DatabaseRequired"; readonly env: string }
  | { readonly _tag: "DatabaseNotFound"; readonly env: string; readonly db: string };

/** Selects names only. No I/O, default environment, or name normalization is performed. */
export function resolveDatabaseTarget(
  available: DatabaseAliasesByEnvironment,
  requested: DatabaseTargetRequest
): Result.Result<DatabaseTarget, TargetSelectionError> {
  const { env } = requested;
  if (env === undefined) return Result.fail({ _tag: "EnvironmentRequired" });

  const aliases = available.get(env);
  if (aliases === undefined) return Result.fail({ _tag: "EnvironmentNotFound", env });

  const db = requested.db ?? (aliases.size === 1 ? aliases.values().next().value : undefined);
  if (db === undefined) {
    return Result.fail({ _tag: aliases.size === 0 ? "NoDatabases" : "DatabaseRequired", env });
  }
  if (!aliases.has(db)) return Result.fail({ _tag: "DatabaseNotFound", env, db });

  return Result.succeed({ env, db });
}
