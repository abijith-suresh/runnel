import { resolveDatabaseTarget } from "@abijith-suresh/runnel-core";
import { createMongoPool, type MongoPool } from "@abijith-suresh/runnel-mongodb";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { readCatalog } from "./catalog.js";
import { credentialStore } from "./secrets.js";
import {
  bounded,
  failure,
  nameLimit,
  type WorkerOperation,
  type WorkerResult,
} from "./worker-protocol.js";

const targetMessages = {
  EnvironmentRequired: "Specify an environment with -e or --env.",
  EnvironmentNotFound: "The named environment is not configured.",
  NoDatabases: "The environment has no database aliases. Run setup first.",
  DatabaseRequired: "Specify a database alias with -d or --db.",
  DatabaseNotFound: "The named database alias is not configured in this environment.",
};

/** Never include driver messages, URIs, documents or stacks in application errors. */
export function databaseFailure(error: unknown): WorkerResult {
  const code =
    typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === 13)
    return failure(
      "PermissionDenied",
      "The database user does not have permission for this operation."
    );
  if (code === 18)
    return failure(
      "AuthenticationFailed",
      "MongoDB rejected the configured credentials. Run setup again."
    );
  const name = error instanceof Error ? error.name : "";
  if (name === "MongoParseError")
    return failure(
      "ConnectionInvalid",
      "The MongoDB connection string is invalid. Check it and retry setup."
    );
  if (/Network|ServerSelection/.test(name))
    return failure("DatabaseUnavailable", "Cannot reach MongoDB. Check the connection and retry.");
  return failure("DatabaseOperationFailed", "MongoDB could not complete the operation.");
}

const boundedResult = (result: WorkerResult): WorkerResult => {
  try {
    bounded(result);
    return result;
  } catch {
    return failure("ResultTooLarge", "The operation result exceeds the IPC size limit.");
  }
};

export function workerOperations(
  directory: string,
  pool: MongoPool = createMongoPool(),
  secrets = credentialStore()
) {
  return {
    async execute(request: WorkerOperation): Promise<WorkerResult> {
      try {
        if (request.operation === "inspect") {
          // Human setup discovery uses an isolated client and retains no unregistered URI.
          const temporary = createMongoPool();
          try {
            const db = await temporary.database("setup", request.uri, "admin");
            const result = await db
              .admin()
              .listDatabases({ nameOnly: true, authorizedDatabases: true, timeoutMS: 10000 });
            const names = result.databases.map(({ name }) => name).sort();
            const response: WorkerResult = {
              ok: true,
              data: { databases: names.slice(0, nameLimit), truncated: names.length > nameLimit },
            };
            return boundedResult(response);
          } finally {
            await temporary.close();
          }
        }
        const resolved = await Effect.runPromise(
          Effect.gen(function* () {
            const catalog = yield* readCatalog(directory);
            const available = new Map(
              Object.entries(catalog.environments).map(([env, value]) => [
                env,
                new Set(Object.keys(value.databases)),
              ])
            );
            const selected = resolveDatabaseTarget(available, {
              ...(request.env === undefined ? {} : { env: request.env }),
              ...(request.db === undefined ? {} : { db: request.db }),
            });
            if (Result.isFailure(selected))
              return yield* Effect.fail({
                code: selected.failure._tag,
                message: targetMessages[selected.failure._tag],
              });
            const { env, db } = selected.success;
            const environment = catalog.environments[env];
            const alias = environment?.databases[db];
            const connection = alias && environment?.connections[alias.connection];
            if (!alias || !connection)
              return yield* Effect.fail({
                code: "CatalogInvalid",
                message: "The catalog mapping is invalid.",
              });
            const uri = yield* secrets.read(connection.secretRef);
            return { env, db, alias, uri };
          }).pipe(Effect.result)
        );
        if (Result.isFailure(resolved)) return { ok: false, error: resolved.failure };
        const { env, db, alias, uri } = resolved.success;
        const handle = await pool.database(
          JSON.stringify([env, alias.connection]),
          uri,
          alias.database
        );
        const cursor = handle.listCollections(
          {},
          { nameOnly: true, authorizedCollections: true, timeoutMS: 10000 }
        );
        try {
          const collections: Array<{ name: string; type: string }> = [];
          for await (const item of cursor) {
            collections.push({ name: item.name, type: item.type ?? "unknown" });
            if (collections.length > nameLimit) break;
          }
          const response: WorkerResult = {
            ok: true,
            data: {
              env,
              db,
              collections: collections.slice(0, nameLimit),
              truncated: collections.length > nameLimit,
            },
          };
          return boundedResult(response);
        } finally {
          await cursor.close();
        }
      } catch (error) {
        return databaseFailure(error);
      }
    },
    close: () => pool.close(),
  };
}
