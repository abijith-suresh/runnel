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
    inspect?: (uri: string, signal?: AbortSignal) => Promise<Inspection>;
    secrets?: ReturnType<typeof credentialStore>;
  } = {}
): Promise<SetupResult> {
  try {
    const prompt = suppliedPrompt ?? terminalPrompt();
    const paint = (value: string, code: string) =>
      prompt.color ? `\u001b[${code}m${value}\u001b[0m` : value;
    prompt.write(`\n${paint("Runnel setup", "1")}\n`);
    prompt.write(
      "An environment groups your databases. A connection names the MongoDB URI. An alias is the short name you use in commands.\n"
    );
    const loaded = await Effect.runPromise(readCatalog(directory).pipe(Effect.result));
    if (Result.isFailure(loaded)) return { ok: false, error: loaded.failure };
    const catalog = loaded.success;
    const names = Object.keys(catalog.environments).sort();
    prompt.write(`${paint("Step 1 of 3", "36")}  Choose where to save this connection\n`);
    if (names.length) {
      prompt.write("Configured environments\n");
      names.forEach((name, index) => {
        prompt.write(`  ${index + 1}. ${name}\n`);
      });
    }
    const askName = async (label: string, used: readonly string[], defaultValue?: string) => {
      for (;;) {
        const value = (
          await prompt.ask(label, defaultValue === undefined ? {} : { defaultValue })
        ).trim();
        if (isCatalogName(value) && !used.includes(value)) return value;
        prompt.write("Choose a new name, such as local, prod-east, or analytics_2. No spaces.\n");
      }
    };
    let env = "";
    for (;;) {
      const environmentInput = await prompt.ask(
        names.length
          ? "Environment number or name (use new:NAME for a numeric name)"
          : "Environment name",
        names.includes("local") || names.length === 0 ? { defaultValue: "local" } : {}
      );
      const envChoice = environmentInput.trim();
      const explicitName = envChoice.match(/^new:(.*)$/);
      const candidate = explicitName
        ? explicitName[1]
        : names.includes(envChoice)
          ? envChoice
          : /^\d+$/.test(envChoice)
            ? names[Number(envChoice) - 1]
            : envChoice;
      if (candidate && isCatalogName(candidate)) {
        env = candidate;
        break;
      }
      prompt.write("Choose a listed number or a name such as local or prod-east. No spaces.\n");
    }
    const current = (Object.hasOwn(catalog.environments, env)
      ? catalog.environments[env]
      : undefined) ?? { connections: {}, databases: {} };
    const connection = await askName(
      "Connection name (labels this MongoDB URI)",
      Object.keys(current.connections),
      Object.hasOwn(current.connections, "primary") ? undefined : "primary"
    );
    const uri = await prompt.ask("MongoDB connection URI (hidden)", { hidden: true });
    if (!uri || Buffer.byteLength(uri, "utf8") > 16384)
      return {
        ok: false,
        error: {
          code: "SecretInvalid",
          message: "The connection URI is empty or exceeds the 16 KiB setup input limit.",
        },
      };
    prompt.write(`${paint("Step 2 of 3", "36")}  Check the connection and find databases\n`);
    const inspected = await prompt.progress<Inspection>("Checking connection…", async (signal) => {
      if (dependencies.inspect) return dependencies.inspect(uri, signal);
      const response = await executeWithDaemon(directory, { operation: "inspect", uri }, signal);
      if (!response.ok) return { ok: false, error: response.error };
      if (
        "databases" in response.data &&
        Array.isArray(response.data.databases) &&
        "truncated" in response.data &&
        typeof response.data.truncated === "boolean"
      )
        return {
          ok: true,
          data: { databases: response.data.databases, truncated: response.data.truncated },
        };
      return {
        ok: false,
        error: { code: "SetupUnavailable", message: "Cannot inspect this connection." },
      };
    });
    let databases: readonly string[] = [];
    if (!inspected.ok) {
      if (inspected.error.code !== "PermissionDenied") return { ok: false, error: inspected.error };
      prompt.write("This user cannot list databases. You can enter database names manually.\n");
    } else if ("databases" in inspected.data) {
      databases = inspected.data.databases.filter(isDatabaseName);
      prompt.write(`${paint("Connection ready", "32")}\n`);
      if (inspected.data.truncated)
        prompt.write("The list was shortened. You can still enter an unlisted name manually.\n");
    } else {
      return {
        ok: false,
        error: { code: "SetupUnavailable", message: "Cannot inspect this connection." },
      };
    }
    prompt.write(`${paint("Step 3 of 3", "36")}  Choose databases and command aliases\n`);
    prompt.write("Press Enter to use each database name as its alias. You can change it.\n");
    for (const [index, name] of databases.entries())
      prompt.write(`  ${index + 1}. ${JSON.stringify(name)}\n`);
    if (!databases.length)
      prompt.write("No database names were listed. Manual entry does not check access.\n");
    prompt.write("Choose one or more numbers separated by commas. Enter m to add a name.\n");
    const selected: string[] = [];
    for (;;) {
      const selection = (
        await prompt.ask(
          selected.length
            ? "More numbers, m for a name, or Enter to finish"
            : "Database numbers or m for a name"
        )
      ).trim();
      if (!selection && selected.length) break;
      if (!selection) {
        prompt.write("Choose at least one database. Press Ctrl+C to cancel.\n");
        continue;
      }
      if (selection.toLowerCase() === "m") {
        const database = (await prompt.ask("Database name in MongoDB")).trim();
        if (!isDatabaseName(database)) {
          prompt.write("Enter a valid database name.\n");
          continue;
        }
        if (selected.includes(database)) {
          prompt.write("That database is already selected.\n");
          continue;
        }
        selected.push(database);
      } else {
        const choices = selection.split(",").map((part) => part.trim());
        const picked = choices.map((choice) =>
          /^\d+$/.test(choice) ? databases[Number(choice) - 1] : undefined
        );
        if (picked.some((database) => database === undefined)) {
          prompt.write("Use listed numbers separated by commas, or m to enter a name.\n");
          continue;
        }
        const unique = [...new Set(picked as string[])];
        const additions = unique.filter((database) => !selected.includes(database));
        if (additions.length === 0) {
          prompt.write("Those databases are already selected.\n");
          continue;
        }
        selected.push(...additions);
      }
    }
    const aliases: Array<{ name: string; database: string }> = [];
    for (const database of selected) {
      const usedAliases = [...Object.keys(current.databases), ...aliases.map(({ name }) => name)];
      const aliasDefault =
        isCatalogName(database) && !usedAliases.includes(database) ? database : undefined;
      const name = await askName(
        `Alias for ${JSON.stringify(database)}`,
        usedAliases,
        aliasDefault
      );
      aliases.push({ name, database });
    }
    prompt.write("\nReview\n");
    prompt.write(`  Environment: ${env}\n  Connection:  ${connection}\n`);
    for (const { name, database } of aliases)
      prompt.write(`  ${name} -> ${JSON.stringify(database)}\n`);
    const confirm = (await prompt.ask("Save these aliases? y/N")).trim().toLowerCase();
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
