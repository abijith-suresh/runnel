import { resolveDatabaseTarget } from "@abijith-suresh/runnel-core";
import { createMongoPool, type MongoPool } from "@abijith-suresh/runnel-mongodb";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { BSON } from "mongodb";
import { readCatalog } from "./catalog.js";
import { executeQuery, prepareQuery } from "./mongodb-query.js";
import { QueryError } from "./query-input.js";
import { createScriptRunner, prepareScript } from "./script-runner.js";
import { credentialStore } from "./secrets.js";
import {
  bounded,
  decodeOperation,
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

const operationMessages = {
  ...targetMessages,
  CatalogInvalid: "The catalog mapping or schema is invalid. Check names and secret references.",
  CatalogUnavailable: "Cannot read the Runnel catalog. Check its path, permissions, and format.",
  SecretNotFound: "The configured credential is missing. Run setup again.",
  SecretUnavailable: "OS credential storage is unavailable or locked. Unlock it and retry.",
  SecretReferenceInvalid: "The credential reference is invalid.",
  SecretInvalid: "The connection secret is empty or exceeds the size limit.",
  InputInvalid: "The operation input is invalid. Check JSON values, names, and option shapes.",
  InputTooLarge: "The operation input exceeds its allowed size.",
  CollectionNotFound: "The named collection does not exist.",
  ResultPrecisionLoss: "Use --format ejson to preserve this BSON Int64 value.",
  ResultEncodingFailed:
    "Return JSON/BSON data without native handles, accessors, functions, cycles, or unsupported classes.",
  ResultTooLarge: "The operation result exceeds its allowed size. Return a bounded result.",
  ScriptUnavailable:
    "Cannot read the JavaScript entry script. Use an absolute regular .mjs or .js file up to 1 MiB.",
  ScriptInvalid:
    "Cannot load the JavaScript module and its imports. Default-export a function and reset after fixing it.",
  ScriptChanged: "The loaded entry script changed. Reset the worker before running it again.",
  ScriptTimedOut: "The script exceeded its deadline. It was not retried.",
  ScriptStopped: "The script runner was stopped. The script was not retried.",
  ScriptScopeEnded: "The script operation has already ended.",
} as const;

/** Never include driver messages, URIs, documents or stacks in application errors. */
export function databaseFailure(error: unknown): WorkerResult {
  try {
    if (error instanceof QueryError) {
      // Scripts can catch and mutate application errors; never copy their messages.
      const code = error.code;
      if (typeof code === "string" && Object.hasOwn(operationMessages, code))
        return failure(code, operationMessages[code as keyof typeof operationMessages]);
      return failure("DatabaseOperationFailed", "The operation could not be completed.");
    }
    const rawCode =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    // promoteValues:false preserves query BSON values, including numeric server error fields.
    const code =
      rawCode instanceof BSON.Int32 || rawCode instanceof BSON.Double
        ? rawCode.value
        : rawCode instanceof BSON.Long
          ? rawCode.toNumber()
          : rawCode;
    if (code === 26) return failure("CollectionNotFound", "The named collection does not exist.");
    if (code === 50) return failure("DatabaseTimedOut", "MongoDB exceeded its operation deadline.");
    if ([2, 9, 14, 72].includes(code as number))
      return failure(
        "QueryInvalid",
        "MongoDB rejected the query or pipeline. Check its operators and values."
      );
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
    if (name === "MongoOperationTimeoutError")
      return failure("DatabaseTimedOut", "MongoDB exceeded its operation deadline.");
    if (name === "MongoInvalidArgumentError")
      return failure("QueryInvalid", "The query arguments are invalid.");
    if (name === "MongoParseError")
      return failure(
        "ConnectionInvalid",
        "The MongoDB connection string is invalid. Check it and retry setup."
      );
    if (/Network|ServerSelection/.test(name))
      return failure(
        "DatabaseUnavailable",
        "Cannot reach MongoDB. Check the connection and retry."
      );
  } catch {
    // Arbitrary awaited JavaScript errors may have throwing accessors or coercions.
  }
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
  const scripts = createScriptRunner();
  const database = async (target: { env?: string; db?: string }) => {
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
          ...(target.env === undefined ? {} : { env: target.env }),
          ...(target.db === undefined ? {} : { db: target.db }),
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
    if (Result.isFailure(resolved))
      throw new QueryError(resolved.failure.code, resolved.failure.message);
    const { env, db, alias, uri } = resolved.success;
    const handle = await pool.database(
      JSON.stringify([env, alias.connection]),
      uri,
      alias.database
    );

    return { env, db, handle };
  };
  return {
    async execute(input: WorkerOperation): Promise<WorkerResult> {
      try {
        let decoded: WorkerOperation;
        try {
          decoded = decodeOperation(input);
        } catch {
          return failure(
            "RequestInvalid",
            "The operation request is invalid or exceeds the IPC size limit."
          );
        }
        const request = decoded;
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
        const scriptArgs = request.operation === "run" ? prepareScript(request) : undefined;
        const prepared =
          request.operation === "list" || request.operation === "run"
            ? undefined
            : prepareQuery(request);
        if (request.operation === "run")
          return boundedResult(
            await scripts.execute(
              request,
              () => database(request),
              async (target) => (await database(target)).handle,
              scriptArgs === undefined ? {} : scriptArgs
            )
          );
        const { env, db, handle } = await database(request);
        if (request.operation !== "list")
          return boundedResult(await executeQuery(handle, request, env, db, prepared ?? {}));
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
        const result = databaseFailure(error);
        return input.operation === "run" &&
          !result.ok &&
          result.error.code === "DatabaseOperationFailed"
          ? failure(
              "ScriptFailed",
              "The script failed. Its error details were omitted; it was not retried."
            )
          : result;
      }
    },
    close: () => {
      scripts.close();
      return pool.close();
    },
  };
}
