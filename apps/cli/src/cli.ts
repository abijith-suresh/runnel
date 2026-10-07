#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const help = `Runnel

Named database access for agents.

Usage:
  runnel [--help | --version]
  runnel envs
  runnel connections -e <environment>
  runnel databases -e <environment>

Options:
  -h, --help     Show this help
  -v, --version  Print the package version
  -e, --env      Select an environment for offline discovery

Database commands are planned and are not implemented.
`;

async function main(): Promise<number> {
  let values: { help?: boolean; version?: boolean; env?: string };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        env: { type: "string", short: "e" },
      },
      strict: true,
      allowPositionals: true,
    }));
    const command = positionals[0];
    if (
      positionals.length > 1 ||
      (command !== undefined && !["envs", "connections", "databases"].includes(command)) ||
      (values.env !== undefined && (command === undefined || command === "envs")) ||
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
