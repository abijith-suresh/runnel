import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { type Catalog, isCatalogName, isDatabaseName, readCatalog } from "./catalog.js";
import { acquireCatalogLock, updateCatalog } from "./catalog-write.js";
import { executeWithDaemon } from "./daemon-client.js";
import { credentialStore } from "./secrets.js";
import { PromptError, type SetupPrompt, terminalPrompt } from "./setup-prompt.js";

export type ManagementError = { readonly code: string; readonly message: string };
export type ManagementWarning = {
  readonly code: "SecretCleanupFailed";
  readonly message: string;
};
export type ManagementResult<A> =
  | { readonly ok: true; readonly data: A; readonly warning?: ManagementWarning }
  | { readonly ok: false; readonly error: ManagementError };
export type ConnectionTarget = { readonly env: string; readonly connection: string };
export type DatabaseTarget = { readonly env: string; readonly alias: string };
type Secrets = ReturnType<typeof credentialStore>;
type Environment = Catalog["environments"][string];

const messages = {
  ManagementInvalid: "Use valid environment, connection and alias names and a valid database name.",
  ManagementUnavailable: "Cannot complete the catalog operation.",
  EnvironmentNotFound: "The named environment is not configured.",
  ConnectionNotFound: "The named connection is not configured in this environment.",
  ConnectionInUse: "Remove this connection's database aliases before removing the connection.",
  ConnectionChanged:
    "The connection changed while rotating it. Retry with its current registration.",
  DatabaseNotFound: "The named database alias is not configured in this environment.",
  DatabaseNameConflict: "A database alias with the new name already exists in this environment.",
  SecretInvalid: "The connection URI is empty or exceeds the 16 KiB input limit.",
  AuthenticationFailed:
    "MongoDB rejected the replacement credentials. The connection was not changed.",
  ConnectionInvalid: "The replacement MongoDB connection string is invalid.",
  DatabaseUnavailable: "Cannot reach MongoDB. Check the replacement connection and retry.",
  DatabaseTimedOut: "MongoDB exceeded its operation deadline. The connection was not changed.",
  InspectionFailed: "Cannot check the replacement connection. The connection was not changed.",
} as const;
const error = (code: keyof typeof messages): ManagementError => ({ code, message: messages[code] });
const cleanupWarning = (): ManagementWarning => ({
  code: "SecretCleanupFailed",
  message:
    "The catalog change was saved, but an obsolete credential could not be removed from OS storage.",
});

function environment(catalog: Catalog, env: string) {
  const value = Object.hasOwn(catalog.environments, env) ? catalog.environments[env] : undefined;
  return value ? Effect.succeed(value) : Effect.fail(error("EnvironmentNotFound"));
}

function connectionIn(env: Environment, name: string) {
  const value = Object.hasOwn(env.connections, name) ? env.connections[name] : undefined;
  return value ? Effect.succeed(value) : Effect.fail(error("ConnectionNotFound"));
}

function databaseIn(env: Environment, name: string) {
  const value = Object.hasOwn(env.databases, name) ? env.databases[name] : undefined;
  return value ? Effect.succeed(value) : Effect.fail(error("DatabaseNotFound"));
}

function updateEnvironment<E>(
  directory: string,
  name: string,
  update: (current: Environment) => Effect.Effect<Environment, E>
) {
  return updateCatalog(directory, (catalog) =>
    Effect.gen(function* () {
      const current = yield* environment(catalog, name);
      const next = yield* update(current);
      return { ...catalog, environments: { ...catalog.environments, [name]: next } };
    })
  );
}

async function run<A>(action: Effect.Effect<A, ManagementError>): Promise<ManagementResult<A>> {
  try {
    const result = await Effect.runPromise(action.pipe(Effect.result));
    return Result.isFailure(result)
      ? { ok: false, error: result.failure }
      : { ok: true, data: result.success };
  } catch {
    return { ok: false, error: error("ManagementUnavailable") };
  }
}

/** Cleanup uses the writer's lock without putting vault side effects in its pure updater. */
async function cleanObsoleteSecret(
  directory: string,
  reference: string,
  secrets: Secrets
): Promise<ManagementWarning | undefined> {
  try {
    const cleaned = await Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.tryPromise({
          try: () => acquireCatalogLock(directory),
          catch: () => error("ManagementUnavailable"),
        }),
        (owner) =>
          Effect.gen(function* () {
            const catalog = yield* readCatalog(owner.directory);
            const referenced = Object.values(catalog.environments).some((env) =>
              Object.values(env.connections).some((item) => item.secretRef === reference)
            );
            if (referenced) return;
            if (owner.state.compromised) return yield* Effect.fail(error("ManagementUnavailable"));
            yield* secrets.remove(reference);
          }),
        (owner) =>
          Effect.tryPromise({
            try: () => owner.release(),
            catch: () => error("ManagementUnavailable"),
          })
      ).pipe(Effect.uninterruptible, Effect.result)
    );
    return Result.isFailure(cleaned) ? cleanupWarning() : undefined;
  } catch {
    return cleanupWarning();
  }
}

export async function addDatabase(
  directory: string,
  input: DatabaseTarget & { readonly connection: string; readonly database: string }
): Promise<ManagementResult<typeof input>> {
  return run(
    Effect.gen(function* () {
      if (
        ![input.env, input.alias, input.connection].every(isCatalogName) ||
        !isDatabaseName(input.database)
      )
        return yield* Effect.fail(error("ManagementInvalid"));
      yield* updateEnvironment(directory, input.env, (current) =>
        Effect.gen(function* () {
          yield* connectionIn(current, input.connection);
          if (Object.hasOwn(current.databases, input.alias))
            return yield* Effect.fail(error("DatabaseNameConflict"));
          return {
            ...current,
            databases: {
              ...current.databases,
              [input.alias]: { connection: input.connection, database: input.database },
            },
          };
        })
      );
      return {
        env: input.env,
        alias: input.alias,
        connection: input.connection,
        database: input.database,
      };
    })
  );
}

export async function renameDatabase(
  directory: string,
  input: DatabaseTarget & { readonly to: string }
): Promise<ManagementResult<typeof input>> {
  return run(
    Effect.gen(function* () {
      if (![input.env, input.alias, input.to].every(isCatalogName))
        return yield* Effect.fail(error("ManagementInvalid"));
      yield* updateEnvironment(directory, input.env, (current) =>
        Effect.gen(function* () {
          const alias = yield* databaseIn(current, input.alias);
          if (Object.hasOwn(current.databases, input.to))
            return yield* Effect.fail(error("DatabaseNameConflict"));
          const databases = { ...current.databases };
          delete databases[input.alias];
          databases[input.to] = alias;
          return { ...current, databases };
        })
      );
      return { env: input.env, alias: input.alias, to: input.to };
    })
  );
}

export async function removeDatabase(
  directory: string,
  input: DatabaseTarget
): Promise<ManagementResult<DatabaseTarget>> {
  return run(
    Effect.gen(function* () {
      if (![input.env, input.alias].every(isCatalogName))
        return yield* Effect.fail(error("ManagementInvalid"));
      yield* updateEnvironment(directory, input.env, (current) =>
        Effect.gen(function* () {
          yield* databaseIn(current, input.alias);
          const databases = { ...current.databases };
          delete databases[input.alias];
          return { ...current, databases };
        })
      );
      return { env: input.env, alias: input.alias };
    })
  );
}

export async function removeConnection(
  directory: string,
  input: ConnectionTarget,
  secrets: Secrets = credentialStore()
): Promise<ManagementResult<ConnectionTarget>> {
  let obsolete: string | undefined;
  const result = await run(
    Effect.gen(function* () {
      if (![input.env, input.connection].every(isCatalogName))
        return yield* Effect.fail(error("ManagementInvalid"));
      yield* updateEnvironment(directory, input.env, (current) =>
        Effect.gen(function* () {
          const connection = yield* connectionIn(current, input.connection);
          if (Object.values(current.databases).some((item) => item.connection === input.connection))
            return yield* Effect.fail(error("ConnectionInUse"));
          const connections = { ...current.connections };
          delete connections[input.connection];
          obsolete = connection.secretRef;
          return { ...current, connections };
        })
      );
      return { env: input.env, connection: input.connection };
    })
  );
  if (!result.ok || !obsolete) return result;
  const warning = await cleanObsoleteSecret(directory, obsolete, secrets);
  return warning ? { ...result, warning } : result;
}

type Inspection = { readonly ok: true } | { readonly ok: false; readonly error: ManagementError };

/** Read credentials only through the hidden prompt; snapshot before any interactive work. */
export async function rotateConnection(
  directory: string,
  input: ConnectionTarget,
  suppliedPrompt?: SetupPrompt,
  dependencies: {
    readonly secrets?: Secrets;
    readonly inspect?: (uri: string, signal?: AbortSignal) => Promise<Inspection>;
  } = {}
): Promise<ManagementResult<ConnectionTarget>> {
  if (![input.env, input.connection].every(isCatalogName))
    return { ok: false, error: error("ManagementInvalid") };
  const loaded = await run(
    Effect.gen(function* () {
      const catalog = yield* readCatalog(directory);
      return yield* connectionIn(yield* environment(catalog, input.env), input.connection);
    })
  );
  if (!loaded.ok) return loaded;
  const expected = loaded.data;
  const secrets = dependencies.secrets ?? credentialStore();
  try {
    const prompt = suppliedPrompt ?? terminalPrompt();
    prompt.write(`Rotate connection ${input.connection} in environment ${input.env}.\n`);
    const uri = await prompt.ask("Replacement MongoDB connection URI (hidden)", { hidden: true });
    if (!uri || Buffer.byteLength(uri, "utf8") > 16384)
      return { ok: false, error: error("SecretInvalid") };
    const inspected = await prompt.progress<Inspection>("Checking connection…", (signal) =>
      dependencies.inspect
        ? dependencies.inspect(uri, signal)
        : executeWithDaemon(directory, { operation: "inspect", uri }, signal)
    );
    if (!inspected.ok && inspected.error.code !== "PermissionDenied") {
      const code = inspected.error.code;
      return {
        ok: false,
        error: error(
          code === "AuthenticationFailed" ||
            code === "ConnectionInvalid" ||
            code === "DatabaseUnavailable" ||
            code === "DatabaseTimedOut"
            ? code
            : "InspectionFailed"
        ),
      };
    }
    const saved = await run(
      secrets.withStored(uri, (reference) =>
        updateEnvironment(directory, input.env, (current) =>
          Effect.gen(function* () {
            const connection = yield* connectionIn(current, input.connection);
            if (
              connection.provider !== expected.provider ||
              connection.secretRef !== expected.secretRef
            )
              return yield* Effect.fail(error("ConnectionChanged"));
            return {
              ...current,
              connections: {
                ...current.connections,
                [input.connection]: { ...connection, secretRef: reference },
              },
            };
          })
        ).pipe(Effect.map(() => ({ env: input.env, connection: input.connection })))
      )
    );
    if (!saved.ok) return saved;
    // This runs after withStored succeeds. Cleanup must never roll back the live new secret.
    const warning = await cleanObsoleteSecret(directory, expected.secretRef, secrets);
    return warning ? { ...saved, warning } : saved;
  } catch (cause) {
    if (cause instanceof PromptError)
      return {
        ok: false,
        error: {
          code: cause.code,
          message:
            cause.code === "SetupTerminalRequired"
              ? "Connection rotation requires interactive stdin and stderr terminals. Credentials cannot be supplied through arguments or piped input."
              : cause.code === "SetupInputTooLong"
                ? "Rotation input exceeds the 16 KiB limit. The connection was not changed."
                : "Connection rotation cancelled. The connection was not changed.",
        },
      };
    return { ok: false, error: error("ManagementUnavailable") };
  }
}
