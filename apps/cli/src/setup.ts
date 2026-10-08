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
  message: "A connection or alias with that name already exists. Choose new names and retry setup.",
});

function addRegistration(catalog: Catalog, input: Registration, reference: string) {
  const current = (Object.hasOwn(catalog.environments, input.env)
    ? catalog.environments[input.env]
    : undefined) ?? { connections: {}, databases: {} };
  if (
    Object.hasOwn(current.connections, input.connection) ||
    input.aliases.some(({ name }) => Object.hasOwn(current.databases, name))
  )
    return Effect.fail(conflict());
  return Effect.succeed({
    ...catalog,
    environments: {
      ...catalog.environments,
      [input.env]: {
        connections: {
          ...current.connections,
          [input.connection]: { provider: "mongodb" as const, secretRef: reference },
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
      input.aliases.length === 0 ||
      new Set(input.aliases.map(({ name }) => name)).size !== input.aliases.length
    )
      return yield* Effect.fail({
        code: "SetupInvalid",
        message: "Register at least one uniquely named database alias.",
      });
    const proposed = yield* addRegistration(emptyCatalog(), input, "keyring:runnel/validation");
    yield* decodeCatalog(proposed);
    return yield* secrets.withStored(input.uri, (reference) =>
      updateCatalog(directory, (current) => addRegistration(current, input, reference))
    );
  });
}

export async function setup(
  directory: string,
  suppliedPrompt?: SetupPrompt,
  dependencies: {
    inspect?: (uri: string) => Promise<Inspection>;
    secrets?: ReturnType<typeof credentialStore>;
  } = {}
): Promise<SetupResult> {
  try {
    const prompt = suppliedPrompt ?? terminalPrompt();
    const loaded = await Effect.runPromise(readCatalog(directory).pipe(Effect.result));
    if (Result.isFailure(loaded)) return { ok: false, error: loaded.failure };
    const catalog = loaded.success;
    const names = Object.keys(catalog.environments).sort();
    if (names.length) prompt.write(`Configured environments: ${names.join(", ")}\n`);
    const askName = async (label: string, used: readonly string[], defaultValue?: string) => {
      for (;;) {
        const value = (
          await prompt.ask(label, defaultValue === undefined ? {} : { defaultValue })
        ).trim();
        if (isCatalogName(value) && !used.includes(value)) return value;
        prompt.write(
          "Use a new name with 1-64 ASCII letters, digits, underscores, or hyphens. Reserved names are unavailable.\n"
        );
      }
    };
    const env = await askName("Environment name", []);
    const current = (Object.hasOwn(catalog.environments, env)
      ? catalog.environments[env]
      : undefined) ?? { connections: {}, databases: {} };
    const connection = await askName(
      "New connection name",
      Object.keys(current.connections),
      Object.hasOwn(current.connections, "primary") ? undefined : "primary"
    );
    const uri = await prompt.ask("MongoDB URI (hidden)", { hidden: true });
    if (!uri || Buffer.byteLength(uri, "utf8") > 16384)
      return {
        ok: false,
        error: {
          code: "SecretInvalid",
          message: "The connection URI is empty or exceeds the 16 KiB setup input limit.",
        },
      };
    prompt.write("Checking accessible databases...\n");
    const inspected = dependencies.inspect
      ? await dependencies.inspect(uri)
      : await executeWithDaemon(directory, { operation: "inspect", uri });
    let databases: readonly string[] = [];
    if (!inspected.ok) {
      if (inspected.error.code !== "PermissionDenied") return { ok: false, error: inspected.error };
      prompt.write(
        "This database user cannot list databases. Enter physical database names manually.\n"
      );
    } else if ("databases" in inspected.data) {
      databases = inspected.data.databases.filter(isDatabaseName);
      if (inspected.data.truncated)
        prompt.write("Discovery was truncated. Unlisted databases can be entered manually.\n");
    } else {
      return {
        ok: false,
        error: { code: "SetupUnavailable", message: "Cannot inspect this connection." },
      };
    }
    for (const [index, name] of databases.entries())
      prompt.write(`${index + 1}. ${JSON.stringify(name)}\n`);
    if (!databases.length)
      prompt.write(
        "No accessible names were listed. Manual registration does not verify database access.\n"
      );
    const aliases: Array<{ name: string; database: string }> = [];
    for (;;) {
      const selection = (
        await prompt.ask("Database number or physical name; m for manual entry; blank to finish")
      ).trim();
      if (!selection) {
        if (aliases.length) break;
        prompt.write("Select at least one database before saving. Ctrl+C cancels setup.\n");
        continue;
      }
      const database =
        selection === "m"
          ? await prompt.ask("Physical database name")
          : /^\d+$/.test(selection)
            ? databases[Number(selection) - 1]
            : selection;
      if (database === undefined || !isDatabaseName(database)) {
        prompt.write(
          "Select a listed number or enter a valid physical database name. Use m for names that are numbers or m.\n"
        );
        continue;
      }
      const name = await askName(
        "Database alias",
        [...Object.keys(current.databases), ...aliases.map(({ name }) => name)],
        isCatalogName(database) ? database : undefined
      );
      aliases.push({ name, database });
      prompt.write(`Selected ${env}/${name} -> ${JSON.stringify(database)}\n`);
    }
    const confirm = (
      await prompt.ask(
        `Save ${connection} in ${env} with ${aliases.length} database alias(es)? y/N`
      )
    )
      .trim()
      .toLowerCase();
    if (confirm !== "y" && confirm !== "yes")
      return {
        ok: false,
        error: {
          code: "SetupCancelled",
          message: "Setup cancelled. No connection was registered.",
        },
      };
    const saved = await Effect.runPromise(
      registerConnection(directory, { env, connection, uri, aliases }, dependencies.secrets).pipe(
        Effect.result
      )
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
