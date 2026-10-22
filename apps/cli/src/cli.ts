#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { DaemonResponse } from "./daemon-protocol.js";
import type { QueryCommand, QueryValues } from "./query-command.js";
import type { ScriptValues } from "./script-command.js";
import type { SetupResult } from "./setup.js";

const help = `Runnel

Named database access for agents.

Usage:
  runnel [--help | --version]
  runnel guide [overview | query | scripts | errors | management | all]
  runnel skill [print | path]
  runnel setup
  runnel envs
  runnel connections -e <environment>
  runnel databases -e <environment>
  runnel connection rotate | remove <name> -e <environment>
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
  -d, --db       Select a database alias; inferred only when there is one

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

Run runnel <command> --help for command-specific options.
Run runnel guide for agent instructions, or runnel skill path for the bundled SKILL.md.

Scripts stay attached. Interrupting the CLI stops active script work without replay.
Exports save bounded JSON/EJSON arrays to new files with --output.
`;

const queryCommands = ["describe", "find", "count", "aggregate", "export"];
const queryOptions = [
  "filter",
  "filter-file",
  "projection",
  "projection-file",
  "sort",
  "sort-file",
  "pipeline",
  "pipeline-file",
  "limit",
  "skip",
  "format",
] as const;
const optionCommands: Record<(typeof queryOptions)[number], readonly string[]> = {
  filter: ["find", "count", "export"],
  "filter-file": ["find", "count", "export"],
  projection: ["find", "export"],
  "projection-file": ["find", "export"],
  sort: ["find", "export"],
  "sort-file": ["find", "export"],
  pipeline: ["aggregate"],
  "pipeline-file": ["aggregate"],
  limit: ["find", "aggregate", "export"],
  skip: ["find", "export"],
  format: [...queryCommands, "run"],
};
const scriptOptions = ["args", "args-file", "timeout"] as const;
const managementActions: Record<string, readonly string[]> = {
  connection: ["rotate", "remove"],
  database: ["add", "rename", "remove"],
};
const commandUsage: Record<string, string> = {
  guide: "guide [overview | query | scripts | errors | management | all | skill]",
  skill: "skill [print | path]",
  setup: "setup",
  envs: "envs",
  connections: "connections -e <environment>",
  databases: "databases -e <environment>",
  connection: "connection rotate | remove <name> -e <environment>",
  database: "database add | rename | remove <alias> -e <environment> [options]",
  history: "history",
  list: "list -e <environment> [-d <database>]",
  describe: "describe <collection> -e <environment> [options]",
  find: "find <collection> -e <environment> [options]",
  count: "count <collection> -e <environment> [options]",
  aggregate:
    "aggregate <collection> -e <environment> (--pipeline <json> | --pipeline-file <file>) [options]",
  export: "export <collection> -e <environment> --output <file> [options]",
  run: "run <script.mjs> -e <environment> [options]",
  daemon: "daemon status | reset | stop",
};
const queryOptionHelp: Record<(typeof queryOptions)[number], string> = {
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
};
function commandHelp(command: string, action?: string): string {
  const options = ["-h, --help                  Show command help"];
  if (
    [
      "connection",
      "database",
      "connections",
      "databases",
      "list",
      "run",
      ...queryCommands,
    ].includes(command)
  )
    options.push("-e, --env <environment>      Required environment name");
  if (["list", "run", ...queryCommands].includes(command))
    options.push("-d, --db <database>          Alias; inferred only when there is one");
  for (const key of queryOptions)
    if (optionCommands[key].includes(command)) options.push(queryOptionHelp[key]);
  if (command === "export")
    options.push(
      "--output <file>             New JSON/EJSON file; never replaces an existing destination"
    );
  if (command === "run")
    options.push(
      "--args <json>               Plain JSON arguments, default {}",
      "--args-file <file>          Arguments file; - reads stdin",
      "--timeout <duration>        One integer/unit: 1500ms, 30s, 5m, 1h; 0 disables it",
      "                           For 2m30s use 150s; catalog default is 5m"
    );
  if (command === "connection")
    options.push(
      "rotate                     Hidden interactive URI replacement; preserves aliases",
      "remove                     Remove an unused registration and its stored credential",
      "Remove database aliases first. These commands do not drop MongoDB data."
    );
  if (command === "database") {
    if (action === undefined || action === "add")
      options.push(
        "--connection <name>        Existing connection for a new alias",
        "--database <physical-name> Physical MongoDB database name; access is not checked"
      );
    if (action === undefined || action === "rename")
      options.push("--to <new-alias>           New alias for rename");
    options.push(
      "Only catalog aliases change. MongoDB databases and collections are not modified."
    );
  }
  const details =
    command === "run"
      ? "\nDefault-export an async function receiving { db, args, connect, signal, bson }.\nUse connect({ env, db }) for another named target. Return bounded data under\ndata.value; console output is discarded. Script args are plain JSON. Pass large\nintegers as strings and construct bson.Long.fromString(args.value) in the script.\nRun runnel guide scripts for examples and reset/cancellation rules.\n"
      : ["find", "aggregate", "export"].includes(command)
        ? "\nResults are bounded to 1000 documents and 512 KiB. Check data.truncated and\ndata.truncationReason before treating them as complete. Export is not a backup.\n"
        : command === "setup"
          ? "\nA human must run setup with interactive stdin and stderr terminals.\nCredentials are entered through a hidden prompt, never arguments or piped input.\n"
          : "";
  return `Runnel ${command}\n\nUsage:\n  runnel ${commandUsage[command]}\n\nOptions:\n  ${options.join("\n  ")}\n${details}\nOffline agent instructions: runnel guide. Bundled skill: runnel skill path.\n`;
}
async function main(): Promise<number> {
  let values: QueryValues &
    ScriptValues & {
      help?: boolean;
      version?: boolean;
      output?: string;
      connection?: string;
      database?: string;
      to?: string;
    };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        env: { type: "string", short: "e" },
        db: { type: "string", short: "d" },
        output: { type: "string" },
        connection: { type: "string" },
        database: { type: "string" },
        to: { type: "string" },
        ...Object.fromEntries(queryOptions.map((key) => [key, { type: "string" }])),
        ...Object.fromEntries(scriptOptions.map((key) => [key, { type: "string" }])),
      },
      strict: true,
      allowPositionals: true,
    });
    values = parsed.values as typeof values;
    positionals = parsed.positionals;
    const command = positionals[0];
    if (
      (!(["guide", "skill"].includes(command ?? "") && [1, 2].includes(positionals.length)) &&
        positionals.length !==
          (command !== undefined && Object.hasOwn(managementActions, command)
            ? 3
            : command === "daemon" || command === "run" || queryCommands.includes(command ?? "")
              ? 2
              : command === undefined
                ? 0
                : 1) &&
        !(
          values.help &&
          (positionals.length === 1 ||
            (command !== undefined &&
              Object.hasOwn(managementActions, command) &&
              positionals.length === 2))
        )) ||
      (command !== undefined && !Object.hasOwn(commandUsage, command)) ||
      (command === "skill" &&
        positionals[1] !== undefined &&
        !["print", "path"].includes(positionals[1])) ||
      (command === "daemon" &&
        !(values.help && positionals.length === 1) &&
        !["status", "reset", "stop"].includes(positionals[1] ?? "")) ||
      (command !== undefined &&
        Object.hasOwn(managementActions, command) &&
        !(values.help && positionals.length === 1) &&
        !managementActions[command]?.includes(positionals[1] ?? "")) ||
      (values.env !== undefined &&
        ![
          "connection",
          "database",
          "connections",
          "databases",
          "list",
          "run",
          ...queryCommands,
        ].includes(command ?? "")) ||
      (values.db !== undefined && !["list", "run", ...queryCommands].includes(command ?? "")) ||
      queryOptions.some(
        (key) => values[key] !== undefined && !optionCommands[key].includes(command ?? "")
      ) ||
      (command !== "export" && values.output !== undefined) ||
      (command !== "run" && scriptOptions.some((key) => values[key] !== undefined)) ||
      ((values.connection !== undefined || values.database !== undefined) &&
        !(command === "database" && positionals[1] === "add")) ||
      (values.to !== undefined && !(command === "database" && positionals[1] === "rename")) ||
      (values.version && command !== undefined)
    )
      throw new Error("Unsupported arguments");
  } catch {
    process.stderr.write("Unsupported arguments. Run runnel --help for available options.\n");
    return 1;
  }

  if (values.help || (positionals.length === 0 && !values.version)) {
    process.stdout.write(
      positionals[0] === undefined ? help : commandHelp(positionals[0], positionals[1])
    );
    return 0;
  }

  const command = positionals[0];
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
      result = await setup(catalogDirectory());
    } catch {
      result = {
        ok: false,
        error: { code: "CatalogInvalid", message: "Runnel configuration paths must be absolute." },
      };
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  }
  if (command === "list" || command === "daemon" || queryCommands.includes(command ?? "")) {
    const [{ catalogDirectory }, { daemonCommand, executeWithDaemon }] = await Promise.all([
      import("./catalog.js"),
      import("./daemon-client.js"),
    ]);
    let result: DaemonResponse | import("./export-command.js").ExportResponse;
    try {
      result =
        command === "daemon"
          ? await daemonCommand(catalogDirectory(), positionals[1] as "status" | "reset" | "stop")
          : values.env === undefined
            ? {
                ok: false,
                error: {
                  code: "EnvironmentRequired",
                  message: "Specify an environment with -e or --env.",
                },
              }
            : command === "export"
              ? await (await import("./export-command.js")).runExportCommand(
                  catalogDirectory(),
                  positionals[1] ?? "",
                  values
                )
              : command !== "list"
                ? await (await import("./query-command.js")).runQueryCommand(
                    catalogDirectory(),
                    command as QueryCommand,
                    positionals[1] ?? "",
                    values
                  )
                : await executeWithDaemon(catalogDirectory(), {
                    operation: "list",
                    env: values.env,
                    ...(values.db === undefined ? {} : { db: values.db }),
                  });
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
