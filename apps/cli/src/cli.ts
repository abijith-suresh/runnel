#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const help = `Runnel

Named database access for agents.

Usage:
  runnel [--help | --version]

Options:
  -h, --help     Show this help
  -v, --version  Print the package version

Database commands are planned and are not implemented.
`;

function main(): number {
  let values: { help?: boolean; version?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    process.stderr.write("Unsupported arguments. Run runnel --help for available options.\n");
    return 1;
  }

  if (values.help || !values.version) {
    process.stdout.write(help);
    return 0;
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

process.exitCode = main();
