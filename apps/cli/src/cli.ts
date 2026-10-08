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
  runnel setup
  runnel envs
  runnel connections -e <environment>
  runnel databases -e <environment>
  runnel history
  runnel list -e <environment> [-d <database>]
  runnel describe <collection> -e <environment> [-d <database>]
  runnel find <collection> -e <environment> [--filter-file <file>] [--limit <n>]
  runnel count <collection> -e <environment> [--filter-file <file>]
  runnel aggregate <collection> -e <environment> --pipeline-file <file> [--limit <n>]
  runnel run <script.mjs> -e <environment> [-d <database>] [--args-file <file>] [--timeout 5m]
  runnel daemon status | reset | stop

Options:
  -h, --help     Show this help
  -v, --version  Print the package version
  -e, --env      Select an environment
  -d, --db       Select a database alias; inferred only when there is one

Query options:
  --filter, --filter-file          JSON/EJSON filter; file - reads stdin
  --projection, --projection-file  Find projection
  --sort, --sort-file              Find sort object with 1/-1 directions
  --pipeline, --pipeline-file      Aggregate pipeline; file - reads stdin
  --limit                         Find/aggregate result cap, default 100, maximum 1000
  --skip                          Find offset, default 0
  --format                        ejson (default) or relaxed json

Script options:
  --args, --args-file  Plain JSON arguments; file - reads stdin, default {}
  --timeout           Whole ms/s/m/h duration or 0 to disable; catalog default is 5m

Scripts stay attached. Interrupting the CLI stops active script work without replay.
Exports are planned.
`;

const queryCommands = ["describe", "find", "count", "aggregate"];
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
  filter: ["find", "count"],
  "filter-file": ["find", "count"],
  projection: ["find"],
  "projection-file": ["find"],
  sort: ["find"],
  "sort-file": ["find"],
  pipeline: ["aggregate"],
  "pipeline-file": ["aggregate"],
  limit: ["find", "aggregate"],
  skip: ["find"],
  format: [...queryCommands, "run"],
};
const scriptOptions = ["args", "args-file", "timeout"] as const;
async function main(): Promise<number> {
  let values: QueryValues & ScriptValues & { help?: boolean; version?: boolean };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        env: { type: "string", short: "e" },
        db: { type: "string", short: "d" },
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
      positionals.length !==
        (command === "daemon" || command === "run" || queryCommands.includes(command ?? "")
          ? 2
          : command === undefined
            ? 0
            : 1) ||
      (command !== undefined &&
        ![
          "setup",
          "envs",
          "connections",
          "databases",
          "history",
          "list",
          "daemon",
          "run",
          ...queryCommands,
        ].includes(command)) ||
      (command === "daemon" && !["status", "reset", "stop"].includes(positionals[1] ?? "")) ||
      (values.env !== undefined &&
        !["connections", "databases", "list", "run", ...queryCommands].includes(command ?? "")) ||
      (values.db !== undefined && !["list", "run", ...queryCommands].includes(command ?? "")) ||
      queryOptions.some(
        (key) => values[key] !== undefined && !optionCommands[key].includes(command ?? "")
      ) ||
      (command !== "run" && scriptOptions.some((key) => values[key] !== undefined)) ||
      (values.version && command !== undefined)
    )
      throw new Error("Unsupported arguments");
  } catch {
    process.stderr.write("Unsupported arguments. Run runnel --help for available options.\n");
    return 1;
  }

  if (values.help || (positionals.length === 0 && !values.version)) {
    process.stdout.write(help);
    return 0;
  }

  const command = positionals[0];
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
    let result: DaemonResponse;
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
