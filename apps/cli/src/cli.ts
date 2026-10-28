#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { agentGuideTopics } from "./agent-help.js";
import type { DaemonResponse } from "./daemon-protocol.js";
import type { QueryCommand, QueryValues } from "./query-command.js";
import type { ScriptValues } from "./script-command.js";
import type { SetupResult } from "./setup.js";

const guideUsage = `guide [${agentGuideTopics.join(" | ")}]`;
const help = `Runnel

Named database access for agents.

Usage:
  runnel [--help | --version]
  runnel help [<command> [<action>]]
  runnel ${guideUsage}
  runnel skill [print | path]
  runnel setup [--env <environment>] [--test]
  runnel config
  runnel build-info
  runnel ui [--open]
  runnel settings [get | set --idle-timeout-ms <n> --script-timeout-ms <n> --history-enabled true|false]
  runnel envs
  runnel connections -e <environment>
  runnel databases -e <environment>
  runnel connection rotate | remove | default | test | databases <name> -e <environment>
  runnel database add <alias> -e <environment> --connection <name> --database <physical-name>
  runnel database rename <alias> -e <environment> --to <new-alias>
  runnel database remove <alias> -e <environment>
  runnel history
  runnel list -e <environment> [-d <database>]
  runnel describe <collection> -e <environment> [-d <database>]
  runnel find <collection> -e <environment> [--filter <json> | --filter-file <file>] [options]
  runnel count <collection> -e <environment> [--filter <json> | --filter-file <file>]
  runnel aggregate <collection> -e <environment> (--pipeline <json> | --pipeline-file <file>) [options]
  runnel run <script.mjs> -e <environment> [-d <database>] [--args-file <file>] [--timeout 5m]
  runnel export <collection> -e <environment> --output <file> [--format ejson] [--limit <n>]
  runnel daemon status | reset | stop

Options:
  -h, --help     Show this help
  -v, --version  Print the package version
  -e, --env      Select an environment
  -d, --db       Select a physical database or optional alias
  --connection  Select a connection and use physical database names

Query options:
  --filter, --filter-file          JSON/EJSON filter; file - reads stdin
  --projection, --projection-file  Find/export projection
  --sort, --sort-file              Find/export sort object with 1/-1 directions
  --pipeline, --pipeline-file      Aggregate pipeline; file - reads stdin
  --limit                         Find/aggregate/export result cap, default 100, maximum 1000
  --skip                          Find/export offset, default 0
  --format                        ejson (default) or relaxed json
  --output                        Export destination; must be a new file

Script options:
  --args, --args-file  Plain JSON arguments; file - reads stdin, default {}
  --timeout           Integer with one unit: 1500ms, 30s, 5m or 1h; 0 disables it

Run runnel help <command> or runnel <command> --help for command-specific options.
Run runnel guide for agent instructions, or runnel skill path for the bundled SKILL.md.

Scripts stay attached. Interrupting the CLI stops active script work without replay.
Exports save bounded JSON/EJSON arrays to new files with --output.
`;

const optionHelp = {
  open: "--open                    Explicitly open the browser pairing link",
  env: "-e, --env <environment>      Required environment name",
  db: "-d, --db <database>          Physical database or optional alias",
  filter: "--filter <json>              JSON/EJSON filter",
  "filter-file": "--filter-file <file>         Filter file; - reads stdin",
  projection: "--projection <json>          JSON/EJSON projection",
  "projection-file": "--projection-file <file>     Projection file; - reads stdin",
  sort: "--sort <json>                Sort object with 1/-1 directions",
  "sort-file": "--sort-file <file>           Sort file; - reads stdin",
  pipeline: "--pipeline <json>            JSON/EJSON pipeline array; may write data",
  "pipeline-file": "--pipeline-file <file>       Pipeline file; - reads stdin",
  limit: "--limit <n>                  Result cap, default 100, maximum 1000",
  skip: "--skip <n>                   Offset, default 0, maximum 2147483647",
  format: "--format ejson | json        Canonical EJSON by default; json rejects unsafe Int64",
  output: "--output <file>             New JSON/EJSON file; never replaces an existing destination",
  args: "--args <json>               Plain JSON arguments, default {}",
  "args-file": "--args-file <file>          Arguments file; - reads stdin",
  timeout: "--timeout <duration>        One integer/unit: 1500ms, 30s, 5m, 1h; 0 disables it",
  connection: "--connection <name>        Select a connection; query databases are physical names",
  default: "--default                  Make an advanced setup connection the environment default",
  test: "--test                     Test connectivity with a bounded ping before saving",
  database: "--database <physical-name> Physical MongoDB database name; access is not checked",
  to: "--to <new-alias>           New alias for rename",
  "idle-timeout-ms":
    "--idle-timeout-ms <n>      Integer milliseconds 0-2147483647; 0 disables idle expiry",
  "script-timeout-ms":
    "--script-timeout-ms <n>    Integer milliseconds 0-2147483547; 0 disables the deadline",
  "history-enabled":
    "--history-enabled true|false  Enable or disable history for newly submitted work",
} as const;
type Option = keyof typeof optionHelp;
type CommandDefinition = {
  usage: string;
  options?: readonly Option[];
  actions?: readonly string[];
  actionOptions?: Readonly<Record<string, readonly Option[]>>;
  operand?: "collection" | "script" | "connection name" | "database alias";
  defaultAction?: boolean;
};
const targetOptions = ["env", "db", "connection"] as const;
const filterOptions = ["filter", "filter-file"] as const;
const findOptions = [
  ...targetOptions,
  ...filterOptions,
  "projection",
  "projection-file",
  "sort",
  "sort-file",
  "limit",
  "skip",
  "format",
] as const;
const commands: Record<string, CommandDefinition> = {
  help: { usage: "help [<command> [<action>]]" },
  guide: {
    usage: guideUsage,
    actions: agentGuideTopics,
    defaultAction: true,
  },
  skill: { usage: "skill [print | path]", actions: ["print", "path"], defaultAction: true },
  setup: {
    usage: "setup [--env <environment>] [--connection <name>] [--default] [--test]",
    options: ["env", "connection", "default", "test"],
  },
  config: { usage: "config" },
  "build-info": { usage: "build-info" },
  ui: { usage: "ui [--open]", options: ["open"] },
  settings: {
    usage:
      "settings [get | set --idle-timeout-ms <n> --script-timeout-ms <n> --history-enabled true|false]",
    actions: ["get", "set"],
    defaultAction: true,
    actionOptions: { set: ["idle-timeout-ms", "script-timeout-ms", "history-enabled"] },
  },
  envs: { usage: "envs" },
  connections: { usage: "connections -e <environment>", options: ["env"] },
  databases: { usage: "databases -e <environment>", options: ["env"] },
  connection: {
    usage: "connection rotate | remove | default | test | databases <name> -e <environment>",
    options: ["env"],
    actions: ["rotate", "remove", "default", "test", "databases"],
    operand: "connection name",
  },
  database: {
    usage: "database add | rename | remove <alias> -e <environment> [options]",
    options: ["env"],
    actions: ["add", "rename", "remove"],
    actionOptions: { add: ["connection", "database"], rename: ["to"] },
    operand: "database alias",
  },
  history: { usage: "history" },
  list: { usage: "list -e <environment> [-d <database>]", options: targetOptions },
  describe: {
    usage: "describe <collection> -e <environment> [options]",
    options: [...targetOptions, "format"],
    operand: "collection",
  },
  find: {
    usage: "find <collection> -e <environment> [options]",
    options: findOptions,
    operand: "collection",
  },
  count: {
    usage: "count <collection> -e <environment> [options]",
    options: [...targetOptions, ...filterOptions, "format"],
    operand: "collection",
  },
  aggregate: {
    usage:
      "aggregate <collection> -e <environment> (--pipeline <json> | --pipeline-file <file>) [options]",
    options: [...targetOptions, "pipeline", "pipeline-file", "limit", "format"],
    operand: "collection",
  },
  export: {
    usage: "export <collection> -e <environment> --output <file> [options]",
    options: [...findOptions, "output"],
    operand: "collection",
  },
  run: {
    usage: "run <script.mjs> -e <environment> [options]",
    options: [...targetOptions, "format", "args", "args-file", "timeout"],
    operand: "script",
  },
  daemon: { usage: "daemon status | reset | stop", actions: ["status", "reset", "stop"] },
};
const options: NonNullable<ParseArgsConfig["options"]> = {
  ...Object.fromEntries(Object.keys(optionHelp).map((key) => [key, { type: "string" as const }])),
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  env: { type: "string", short: "e" },
  db: { type: "string", short: "d" },
  default: { type: "boolean" },
  test: { type: "boolean" },
  open: { type: "boolean" },
} as const;

function supportsOption(
  definition: CommandDefinition | undefined,
  action: string | undefined,
  key: string
) {
  if (key === "help") return true;
  if (key === "version") return definition === undefined;
  const byAction = definition?.actionOptions;
  const actionOptions =
    action !== undefined && byAction !== undefined && Object.hasOwn(byAction, action)
      ? byAction[action]
      : undefined;
  const supported = [...(definition?.options ?? []), ...(actionOptions ?? [])];
  return supported.some((option) => option === key);
}

function commandHelp(command: string, definition: CommandDefinition, action?: string): string {
  const options = ["-h, --help                  Show command help"];
  const supported = [
    ...(definition.options ?? []),
    ...(action === undefined
      ? Object.values(definition.actionOptions ?? {}).flat()
      : (definition.actionOptions?.[action] ?? [])),
  ];
  for (const key of supported)
    options.push(
      command === "setup" && key === "env"
        ? "-e, --env <environment>      Environment name; prompted when omitted"
        : command === "setup" && key === "connection"
          ? "--connection <name>        Optional name for an additional connection"
          : optionHelp[key]
    );
  if (command === "run")
    options.push("                           For 2m30s use 150s; catalog default is 5m");
  if (command === "connection")
    options.push(
      "rotate                     Hidden interactive URI replacement; preserves aliases",
      "remove                     Remove an unused registration and its stored credential",
      "default                    Select the default connection for physical database names",
      "test                       Explicit bounded ping using the registered connection",
      "databases                  Explicit bounded discovery; listing permission may be denied",
      "Remove database aliases before connection removal. These commands do not drop MongoDB data."
    );
  if (command === "database")
    options.push(
      "Only catalog aliases change. MongoDB databases and collections are not modified."
    );
  if (command === "ui")
    options.push(
      "Explicit foreground loopback manager; no database access on open or save.",
      "Browser opening is opt-in. Pairing expires after 60s; sessions after 15m.",
      "Stop manager and Stop database daemon are separate. Idle manager closes after 30m."
    );
  if (command === "settings")
    options.push(
      "Settings are read/written offline. Supply at least one setting for set.",
      "Idle changes apply at next daemon start; script defaults to the next run without --timeout.",
      "History changes apply to new submissions. Existing history and active work remain intact."
    );
  const details =
    command === "run"
      ? "\nDefault-export an async function receiving { db, args, connect, signal, bson }.\nUse connect({ env, db }) for another named target. Return bounded data under\ndata.value; console output is discarded. Script args are plain JSON. Pass large\nintegers as strings and construct bson.Long.fromString(args.value) in the script.\nRun runnel guide scripts for examples and reset/cancellation rules.\n"
      : ["find", "aggregate", "export"].includes(command)
        ? "\nResults are bounded to 1000 documents and 512 KiB. Check data.truncated and\ndata.truncationReason before treating them as complete. Export is not a backup.\n"
        : command === "setup"
          ? "\nA human must run setup with interactive stdin and stderr terminals.\nCredentials are entered through a hidden prompt, never arguments or piped input.\nSave an environment and URI with no database listing, alias or label questions.\n--test explicitly runs a bounded ping. Saving alone does not verify access.\n"
          : "";
  const usage =
    command === "connection" && action !== undefined
      ? `connection ${action} <name> -e <environment>`
      : command === "database" && action !== undefined
        ? `database ${action} <alias> -e <environment>${
            action === "add"
              ? " --connection <name> --database <physical-name>"
              : action === "rename"
                ? " --to <new-alias>"
                : ""
          }`
        : definition.usage;
  return `Runnel ${command}\n\nUsage:\n  runnel ${usage}\n\nOptions:\n  ${options.join("\n  ")}\n${details}\nOffline agent instructions: runnel guide. Bundled skill: runnel skill path.\n`;
}
async function main(): Promise<number> {
  // Tokenize without Node's diagnostics: they can include arbitrary argument values.
  // Validate every token, including repeated options, before importing runtime modules.
  const parsed = parseArgs({ options, strict: false, allowPositionals: true, tokens: true });
  const helpCommand = parsed.positionals[0] === "help";
  const positionals = helpCommand ? parsed.positionals.slice(1) : parsed.positionals;
  const command = positionals[0];
  const definition =
    command !== undefined && Object.hasOwn(commands, command) ? commands[command] : undefined;
  const fail = (message: string): number => {
    const target = definition ? `help ${command}` : "help";
    process.stderr.write(`${message} Run runnel ${target} for usage.\n`);
    return 1;
  };
  if (command !== undefined && !definition) return fail("Unknown command.");
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    const key = token.name;
    const option = Object.hasOwn(options, key) ? options[key] : undefined;
    if (option === undefined) return fail("Unknown option.");
    // Only fixed, known option names may appear in diagnostics.
    if (
      option.type === "string" &&
      (token.value === undefined ||
        (!token.inlineValue && token.value.startsWith("-") && token.value !== "-"))
    )
      return fail(
        `Missing value for --${key}. Use --${key}=<value> for values starting with a dash.`
      );
    if (option.type === "boolean" && token.value !== undefined)
      return fail(`Option --${key} does not take a value.`);
    if ((helpCommand && key !== "help") || !supportsOption(definition, positionals[1], key))
      return fail(`Unsupported option --${key} for this command or action.`);
  }
  const values = parsed.values as QueryValues &
    ScriptValues & {
      help?: boolean;
      version?: boolean;
      output?: string;
      connection?: string;
      database?: string;
      to?: string;
      default?: boolean;
      test?: boolean;
      open?: boolean;
      "idle-timeout-ms"?: string;
      "script-timeout-ms"?: string;
      "history-enabled"?: string;
    };
  const wantsHelp = helpCommand || values.help;
  const choices = definition?.actions;
  if (choices !== undefined) {
    const action = positionals[1];
    if (action !== undefined && !choices.includes(action))
      return fail(
        `Invalid ${command} ${command === "guide" ? "topic" : "action"}. Choose ${choices.join(", ")}.`
      );
    if (!wantsHelp && action === undefined && !definition?.defaultAction)
      return fail(`Missing ${command} action. Choose ${choices.join(", ")}.`);
  }
  const maximum =
    definition === undefined
      ? 0
      : 1 +
        Number(choices !== undefined) +
        Number(!helpCommand && definition.operand !== undefined);
  if (positionals.length > maximum) return fail("Unexpected operand.");
  if (!wantsHelp && definition?.operand !== undefined && positionals.length < maximum)
    return fail(`Missing ${definition.operand} operand.`);
  if (wantsHelp || (positionals.length === 0 && !values.version)) {
    process.stdout.write(
      command === undefined || definition === undefined
        ? help
        : commandHelp(command, definition, positionals[1])
    );
    return 0;
  }

  if (command === "guide" || command === "skill") {
    try {
      const { getAgentGuide, getAgentSkillPath, readAgentSkill } = await import("./agent-help.js");
      process.stdout.write(
        command === "guide"
          ? getAgentGuide(positionals[1])
          : positionals[1] === "path"
            ? `${getAgentSkillPath()}\n`
            : readAgentSkill()
      );
      return 0;
    } catch (error) {
      process.stderr.write(
        error instanceof RangeError
          ? `${error.message}\n`
          : "Cannot read the bundled agent guide. Reinstall the CLI.\n"
      );
      return 1;
    }
  }
  if (command === "build-info") {
    try {
      const { readBuildInfo } = await import("./build-info.js");
      process.stdout.write(`${JSON.stringify({ ok: true, data: readBuildInfo() })}\n`);
      return 0;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "BuildIdentityInvalid", message: "Cannot read the bounded offline Runnel build identity." } })}\n`
      );
      return 1;
    }
  }
  if (command === "ui") {
    const { catalogDirectory } = await import("./catalog.js");
    const { runManager } = await import("./ui.js");
    return runManager(catalogDirectory(), values.open);
  }
  if (command === "settings" || command === "config") {
    const [Effect, Result, { catalogDirectory }, settings] = await Promise.all([
      import("effect/Effect"),
      import("effect/Result"),
      import("./catalog.js"),
      import("./settings.js"),
    ]);
    const parsedSetting = (value: string | undefined): unknown =>
      value === undefined ? undefined : /^\d+$/.test(value) ? Number(value) : value;
    const history = values["history-enabled"];
    const patch = {
      ...(values["idle-timeout-ms"] === undefined
        ? {}
        : { idleTimeoutMs: parsedSetting(values["idle-timeout-ms"]) }),
      ...(values["script-timeout-ms"] === undefined
        ? {}
        : { scriptTimeoutMs: parsedSetting(values["script-timeout-ms"]) }),
      ...(history === undefined
        ? {}
        : { historyEnabled: history === "true" ? true : history === "false" ? false : history }),
    };
    const result = await Effect.runPromise(
      Effect.try({
        try: () => catalogDirectory(),
        catch: () => ({
          code: "CatalogInvalid",
          message: "Runnel configuration paths must be absolute.",
        }),
      }).pipe(
        Effect.flatMap((directory) =>
          command === "config"
            ? settings.getConfiguration(directory)
            : positionals[1] === "set"
              ? settings.setSettings(directory, patch)
              : settings.getSettings(directory)
        ),
        Effect.result
      )
    );
    process.stdout.write(
      `${JSON.stringify(
        Result.isFailure(result)
          ? { ok: false, error: result.failure }
          : { ok: true, data: result.success }
      )}\n`
    );
    return Result.isFailure(result) ? 1 : 0;
  }
  if (command === "connection" || command === "database") {
    const { catalogDirectory } = await import("./catalog.js");
    const management = await import("./management.js");
    let result: import("./management.js").ManagementResult<unknown>;
    try {
      if (values.env === undefined) {
        result = {
          ok: false,
          error: {
            code: "EnvironmentRequired",
            message: "Specify an environment with -e or --env.",
          },
        };
      } else {
        const directory = catalogDirectory();
        const name = positionals[2] ?? "";
        const env = values.env;
        if (command === "connection") {
          const input = { env, connection: name };
          result =
            positionals[1] === "rotate"
              ? await management.rotateConnection(directory, input)
              : positionals[1] === "default"
                ? await management.defaultConnection(directory, input)
                : positionals[1] === "test" || positionals[1] === "databases"
                  ? await management.inspectConnection(
                      directory,
                      input,
                      positionals[1] === "databases"
                    )
                  : await management.removeConnection(directory, input);
        } else {
          const input = { env, alias: name };
          result =
            positionals[1] === "add"
              ? await management.addDatabase(directory, {
                  ...input,
                  connection: values.connection ?? "",
                  database: values.database ?? "",
                })
              : positionals[1] === "rename"
                ? await management.renameDatabase(directory, { ...input, to: values.to ?? "" })
                : await management.removeDatabase(directory, input);
        }
      }
    } catch {
      result = {
        ok: false,
        error: { code: "CatalogInvalid", message: "Runnel configuration paths must be absolute." },
      };
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.ok && result.warning) process.stderr.write(`${result.warning.message}\n`);
    return result.ok ? 0 : 1;
  }
  if (command === "run") {
    const controller = new AbortController();
    let interrupted: number | undefined;
    const interrupt = () => {
      interrupted = 130;
      controller.abort();
    };
    const terminate = () => {
      interrupted = 143;
      controller.abort();
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    try {
      const [{ catalogDirectory }, { runScriptCommand }] = await Promise.all([
        import("./catalog.js"),
        import("./script-command.js"),
      ]);
      let result: DaemonResponse;
      try {
        result = await runScriptCommand(
          catalogDirectory(),
          positionals[1] ?? "",
          values,
          controller.signal
        );
      } catch {
        result = {
          ok: false,
          error: {
            code: "CatalogInvalid",
            message: "Runnel configuration paths must be absolute.",
          },
        };
      }
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if ("warning" in result && result.warning === "HistoryUnavailable")
        process.stderr.write("Cannot save local operation history.\n");
      return interrupted ?? (result.ok ? 0 : 1);
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  }
  if (command === "history") {
    const [{ catalogDirectory }, { readHistory, historyMaximumEntries, historyMaximumBytes }] =
      await Promise.all([import("./catalog.js"), import("./history.js")]);
    try {
      const entries = await readHistory(catalogDirectory());
      process.stdout.write(
        `${JSON.stringify({ ok: true, data: { entries, limits: { entries: historyMaximumEntries, bytes: historyMaximumBytes } } })}\n`
      );
      return 0;
    } catch {
      process.stdout.write(
        `${JSON.stringify({ ok: false, error: { code: "HistoryUnavailable", message: "Cannot read private Runnel operation history. Check its path, permissions, and format." } })}\n`
      );
      return 1;
    }
  }
  if (command === "setup") {
    const [{ catalogDirectory }, { setup }] = await Promise.all([
      import("./catalog.js"),
      import("./setup.js"),
    ]);
    let result: SetupResult;
    try {
      result = await setup(
        catalogDirectory(),
        undefined,
        {},
        {
          ...(values.env === undefined ? {} : { env: values.env }),
          ...(values.connection === undefined ? {} : { connection: values.connection }),
          ...(values.default === undefined ? {} : { makeDefault: values.default }),
          ...(values.test === undefined ? {} : { test: values.test }),
        }
      );
    } catch {
      result = {
        ok: false,
        error: { code: "CatalogInvalid", message: "Runnel configuration paths must be absolute." },
      };
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  }
  if (command === "list" || command === "daemon" || definition?.operand === "collection") {
    const [{ catalogDirectory }, { daemonCommand, executeWithDaemon }] = await Promise.all([
      import("./catalog.js"),
      import("./daemon-client.js"),
    ]);
    let result: DaemonResponse | import("./export-command.js").ExportResponse;
    try {
      if (command === "daemon") {
        result = await daemonCommand(
          catalogDirectory(),
          positionals[1] as "status" | "reset" | "stop"
        );
      } else if (values.env === undefined) {
        result = {
          ok: false,
          error: {
            code: "EnvironmentRequired",
            message: "Specify an environment with -e or --env.",
          },
        };
      } else if (command === "export") {
        const { runExportCommand } = await import("./export-command.js");
        result = await runExportCommand(catalogDirectory(), positionals[1] ?? "", values);
      } else if (command === "list") {
        result = await executeWithDaemon(catalogDirectory(), {
          operation: "list",
          env: values.env,
          ...(values.db === undefined ? {} : { db: values.db }),
          ...(values.connection === undefined ? {} : { connection: values.connection }),
        });
      } else {
        const { runQueryCommand } = await import("./query-command.js");
        result = await runQueryCommand(
          catalogDirectory(),
          command as QueryCommand,
          positionals[1] ?? "",
          values
        );
      }
    } catch {
      result = {
        ok: false,
        error: { code: "CatalogInvalid", message: "Runnel configuration paths must be absolute." },
      };
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if ("warning" in result && result.warning === "HistoryUnavailable")
      process.stderr.write("Cannot save local operation history.\n");
    return result.ok ? 0 : 1;
  }
  if (command === "envs" || command === "connections" || command === "databases") {
    const [Effect, Result, { catalogDirectory }, { discover }] = await Promise.all([
      import("effect/Effect"),
      import("effect/Result"),
      import("./catalog.js"),
      import("./discovery.js"),
    ]);
    const result = await Effect.runPromise(
      Effect.try({
        try: () => catalogDirectory(),
        catch: () => ({
          code: "CatalogInvalid",
          message: "Runnel configuration paths must be absolute.",
        }),
      }).pipe(
        Effect.flatMap((directory) => discover(directory, command, values.env)),
        Effect.result
      )
    );
    process.stdout.write(
      `${JSON.stringify(
        Result.isFailure(result)
          ? { ok: false, error: result.failure }
          : { ok: true, data: result.success }
      )}\n`
    );
    return Result.isFailure(result) ? 1 : 0;
  }

  try {
    const manifest: { version?: unknown } = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    );
    if (typeof manifest.version !== "string" || !manifest.version) {
      throw new Error("Missing package version");
    }
    process.stdout.write(`${manifest.version}\n`);
    return 0;
  } catch {
    process.stderr.write("Cannot read Runnel package version.\n");
    return 1;
  }
}

main()
  .then((status) => {
    process.exitCode = status;
  })
  .catch(() => {
    process.stderr.write("Cannot complete the Runnel command.\n");
    process.exitCode = 1;
  });
