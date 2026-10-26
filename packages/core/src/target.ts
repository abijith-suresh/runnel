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

export interface ConnectionTargetRequest extends DatabaseTargetRequest {
  /** An explicit connection selects physical names, bypassing aliases. */
  readonly connection?: string;
}

export interface EnvironmentTargets {
  readonly defaultConnection?: string;
  readonly connections: ReadonlyMap<string, { readonly defaultDatabase?: string }>;
  readonly databases: ReadonlyMap<
    string,
    { readonly connection: string; readonly database: string }
  >;
}

export interface ConnectionTarget extends DatabaseTarget {
  readonly connection: string;
  readonly database: string;
}

export type ConnectionSelectionError =
  | TargetSelectionError
  | { readonly _tag: "ConnectionRequired"; readonly env: string }
  | { readonly _tag: "ConnectionNotFound"; readonly env: string };

/** Resolve a pinned configuration without I/O or inferring a connection for legacy catalogs. */
export function resolveConnectionTarget(
  available: ReadonlyMap<string, EnvironmentTargets>,
  requested: ConnectionTargetRequest
): Result.Result<ConnectionTarget, ConnectionSelectionError> {
  const { env } = requested;
  if (env === undefined) return Result.fail({ _tag: "EnvironmentRequired" });
  const selected = available.get(env);
  if (selected === undefined) return Result.fail({ _tag: "EnvironmentNotFound", env });
  const physical = (connection: string, db?: string) => {
    const entry = selected.connections.get(connection);
    if (entry === undefined)
      return Result.fail<ConnectionSelectionError>({ _tag: "ConnectionNotFound", env });
    const database = db ?? entry.defaultDatabase;
    return database === undefined
      ? Result.fail<ConnectionSelectionError>({ _tag: "DatabaseRequired", env })
      : Result.succeed({ env, db: database, connection, database });
  };
  if (requested.connection !== undefined) return physical(requested.connection, requested.db);

  let db = requested.db;
  if (db === undefined && selected.defaultConnection !== undefined) {
    const connection = selected.connections.get(selected.defaultConnection);
    if (connection?.defaultDatabase !== undefined)
      return physical(selected.defaultConnection, connection.defaultDatabase);
  }
  db ??= selected.databases.size === 1 ? selected.databases.keys().next().value : undefined;
  if (db !== undefined) {
    const alias = selected.databases.get(db);
    if (alias !== undefined) return Result.succeed({ env, db, ...alias });
    if (selected.defaultConnection !== undefined) return physical(selected.defaultConnection, db);
    return Result.fail({ _tag: "DatabaseNotFound", env, db });
  }
  if (selected.defaultConnection !== undefined)
    return Result.fail({ _tag: "DatabaseRequired", env });
  return Result.fail({
    _tag:
      selected.connections.size > 1 && selected.databases.size === 0
        ? "ConnectionRequired"
        : selected.databases.size === 0
          ? "NoDatabases"
          : "DatabaseRequired",
    env,
  });
}
