import { mongoConnectionDatabase } from "@abijith-suresh/runnel-mongodb";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  type Catalog,
  decodeCatalog,
  emptyCatalog,
  isCatalogName,
  isDatabaseName,
  readCatalog,
} from "./catalog.js";
import { updateCatalog } from "./catalog-write.js";
import { executeWithDaemon } from "./daemon-client.js";
import { credentialStore } from "./secrets.js";
import { PromptError, type SetupPrompt, terminalPrompt } from "./setup-prompt.js";

// Internal registration input, not a public catalog or wire contract.
export type Registration = {
  readonly env: string;
  readonly connection: string;
  readonly uri: string;
  readonly makeDefault?: boolean;
  readonly requireEmptyEnvironment?: boolean;
  readonly aliases: ReadonlyArray<{ readonly name: string; readonly database: string }>;
};
type SetupError = { readonly code: string; readonly message: string };
type Inspection =
  | {
      readonly ok: true;
      readonly data: { readonly databases: readonly string[]; readonly truncated: boolean };
    }
  | { readonly ok: false; readonly error: SetupError };
export type SetupResult =
  | {
      readonly ok: true;
      readonly data: {
        readonly env: string;
        readonly connection: string;
        readonly databases: readonly string[];
      };
    }
  | { readonly ok: false; readonly error: SetupError };
const conflict = (): SetupError => ({
  code: "SetupNameConflict",
  message:
    "That connection or alias already exists. Use runnel connections -e NAME, then runnel connection rotate CONNECTION -e NAME to replace credentials, or setup --env NAME --connection NEW_NAME to add another connection.",
});

function addRegistration(
  catalog: Catalog,
  input: Registration,
  reference: string,
  defaultDatabase?: string
) {
  const current = (Object.hasOwn(catalog.environments, input.env)
    ? catalog.environments[input.env]
    : undefined) ?? { connections: {}, databases: {} };
  if (
    (input.requireEmptyEnvironment && Object.keys(current.connections).length > 0) ||
    Object.hasOwn(current.connections, input.connection) ||
    input.aliases.some(({ name }) => Object.hasOwn(current.databases, name))
  )
    return Effect.fail(conflict());
  return Effect.succeed({
    ...catalog,
    environments: {
      ...catalog.environments,
      [input.env]: {
        ...current,
        ...(input.makeDefault ? { defaultConnection: input.connection } : {}),
        connections: {
          ...current.connections,
          [input.connection]: {
            provider: "mongodb" as const,
            secretRef: reference,
            ...(defaultDatabase === undefined ? {} : { defaultDatabase }),
          },
        },
        databases: {
          ...current.databases,
          ...Object.fromEntries(
            input.aliases.map(({ name, database }) => [
              name,
              { connection: input.connection, database },
            ])
          ),
        },
      },
    },
  });
}

/** Validate syntax and the URI path without creating a client or accessing the vault. */
export function connectionDatabase(uri: string): Effect.Effect<string | undefined, SetupError> {
  return Effect.try({
    try: () => {
      if (!uri || Buffer.byteLength(uri, "utf8") > 16384) throw { code: "SecretInvalid" };
      const database = mongoConnectionDatabase(uri);
      if (database !== undefined && !isDatabaseName(database)) throw { code: "ConnectionInvalid" };
      return database;
    },
    catch: (cause) => ({
      code:
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "SecretInvalid"
          ? "SecretInvalid"
          : "ConnectionInvalid",
      message: "Enter a valid MongoDB URI up to 16 KiB with a valid optional default database.",
    }),
  });
}

/** Only credential storage and a serialized catalog commit occur after input collection. */
export function registerConnection(
  directory: string,
  input: Registration,
  secrets = credentialStore()
) {
  return Effect.gen(function* () {
    if (
      !isCatalogName(input.env) ||
      !isCatalogName(input.connection) ||
      input.aliases.some(
        ({ name, database }) => !isCatalogName(name) || !isDatabaseName(database)
      ) ||
      new Set(input.aliases.map(({ name }) => name)).size !== input.aliases.length
    )
      return yield* Effect.fail({
        code: "SetupInvalid",
        message:
          "Use valid environment and connection names and uniquely named optional database aliases.",
      });
    const defaultDatabase = yield* connectionDatabase(input.uri);
    const proposed = yield* addRegistration(
      emptyCatalog(),
      input,
      "keyring:runnel/validation",
      defaultDatabase
    );
    yield* decodeCatalog(proposed);
    return yield* secrets.withStored(input.uri, (reference) =>
      updateCatalog(directory, (current) =>
        addRegistration(current, input, reference, defaultDatabase)
      ).pipe(
        Effect.map(() => ({
          env: input.env,
          connection: input.connection,
          databases: input.aliases.map(({ name }) => name),
        }))
      )
    );
  });
}

/** The ordinary two-input human registration operation, independent of terminal or UI. */
export function registerEnvironment(
  directory: string,
  input: { readonly env: string; readonly uri: string },
  secrets = credentialStore()
) {
  return registerConnection(
    directory,
    {
      ...input,
      connection: "primary",
      aliases: [],
      makeDefault: true,
      requireEmptyEnvironment: true,
    },
    secrets
  );
}

export async function setup(
  directory: string,
  suppliedPrompt?: SetupPrompt,
  dependencies: {
    inspect?: (uri: string, signal?: AbortSignal) => Promise<Inspection>;
    secrets?: ReturnType<typeof credentialStore>;
  } = {},
  options: { env?: string; connection?: string; makeDefault?: boolean; test?: boolean } = {}
): Promise<SetupResult> {
  try {
    const loaded = await Effect.runPromise(readCatalog(directory).pipe(Effect.result));
    if (Result.isFailure(loaded)) return { ok: false, error: loaded.failure };
    const prompt = suppliedPrompt ?? terminalPrompt();
    prompt.write(
      "\nRunnel setup\nSave an environment and a hidden MongoDB URI in OS credential storage.\n"
    );
    let env = options.env;
    while (env === undefined || !isCatalogName(env)) {
      if (env !== undefined) {
        if (options.env !== undefined)
          return {
            ok: false,
            error: { code: "SetupInvalid", message: "Use a valid environment name." },
          };
        prompt.write("Use a name such as local or prod-east, without spaces.\n");
      }
      env = (await prompt.ask("Environment name", { defaultValue: "local" })).trim();
    }
    const connection = options.connection ?? "primary";
    if (!isCatalogName(connection))
      return {
        ok: false,
        error: { code: "SetupInvalid", message: "Use a valid connection name." },
      };
    const current = Object.hasOwn(loaded.success.environments, env)
      ? loaded.success.environments[env]
      : undefined;
    if (
      (options.connection === undefined && Object.keys(current?.connections ?? {}).length > 0) ||
      Object.hasOwn(current?.connections ?? {}, connection)
    )
      return { ok: false, error: conflict() };
    const uri = await prompt.ask("MongoDB connection URI (hidden)", { hidden: true });
    const validated = await Effect.runPromise(connectionDatabase(uri).pipe(Effect.result));
    if (Result.isFailure(validated)) return { ok: false, error: validated.failure };
    if (options.test) {
      const inspected = await prompt.progress<Inspection>(
        "Checking connection…",
        async (signal) => {
          if (dependencies.inspect) return dependencies.inspect(uri, signal);
          const response = await executeWithDaemon(
            directory,
            { operation: "inspect", uri, testOnly: true },
            signal
          );
          return response.ok ? { ok: true, data: { databases: [], truncated: false } } : response;
        }
      );
      if (!inspected.ok) return { ok: false, error: inspected.error };
    }
    const aliases: Registration["aliases"] = [];
    const saved = await Effect.runPromise(
      (options.connection === undefined
        ? registerEnvironment(directory, { env, uri }, dependencies.secrets)
        : registerConnection(
            directory,
            {
              env,
              connection,
              uri,
              aliases,
              makeDefault: options.makeDefault === true,
            },
            dependencies.secrets
          )
      ).pipe(Effect.result)
    );
    return Result.isFailure(saved)
      ? { ok: false, error: saved.failure }
      : { ok: true, data: { env, connection, databases: aliases.map(({ name }) => name) } };
  } catch (error) {
    if (error instanceof PromptError) {
      const message =
        error.code === "SetupTerminalRequired"
          ? "Setup requires interactive stdin and stderr terminals. Credentials cannot be supplied through arguments or piped input."
          : error.code === "SetupInputTooLong"
            ? "Setup input exceeds the 16 KiB limit. No connection was registered."
            : "Setup cancelled. No connection was registered.";
      return { ok: false, error: { code: error.code, message } };
    }
    return {
      ok: false,
      error: {
        code: "SetupUnavailable",
        message: "Cannot complete setup. No connection was registered.",
      },
    };
  }
}
