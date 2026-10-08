#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { DaemonResponse } from "./daemon-protocol.js";

const help = `Runnel

Named database access for agents.

Usage:
  runnel [--help | --version]
  runnel envs
  runnel connections -e <environment>
  runnel databases -e <environment>
  runnel list -e <environment> [-d <database>]
  runnel daemon status | reset | stop

Options:
  -h, --help     Show this help
  -v, --version  Print the package version
  -e, --env      Select an environment
  -d, --db       Select a database alias; inferred only when there is one

Other database commands, setup, scripts, and history are planned.
`;

async function main(): Promise<number> {
  let values: { help?: boolean; version?: boolean; env?: string; db?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        env: { type: "string", short: "e" },
        db: { type: "string", short: "d" },
      },
      strict: true,
      allowPositionals: true,
    }));
    const command = positionals[0];
    if (
      positionals.length !== (command === "daemon" ? 2 : command === undefined ? 0 : 1) ||
      (command !== undefined &&
        !["envs", "connections", "databases", "list", "daemon"].includes(command)) ||
      (command === "daemon" && !["status", "reset", "stop"].includes(positionals[1] ?? "")) ||
      (values.env !== undefined && !["connections", "databases", "list"].includes(command ?? "")) ||
      (values.db !== undefined && command !== "list") ||
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
  if (command === "list" || command === "daemon") {
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
