import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const executable = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const manifest: { version: string } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
const run = (args: string[]) =>
  spawnSync(process.execPath, [executable, ...args], { encoding: "utf8" });

test("help and no arguments print available options on stdout", () => {
  for (const args of [[], ["--help"], ["-h"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /runnel \[--help \| --version\]/);
    assert.match(result.stdout, /-h, --help/);
    assert.match(result.stdout, /-v, --version/);
    assert.match(result.stdout, /runnel list -e/);
    assert.match(result.stdout, /runnel daemon status/);
    assert.match(result.stdout, /runnel setup/);
    assert.match(result.stdout, /runnel find <collection>/);
    assert.match(result.stdout, /Exports save bounded JSON\/EJSON arrays/);
  }
});

test("command help works without operands or catalog access and lists only supported options", () => {
  const helpByCommand = new Map<string, string>();
  for (const command of [
    "guide",
    "skill",
    "setup",
    "envs",
    "connections",
    "databases",
    "connection",
    "database",
    "history",
    "list",
    "describe",
    "find",
    "count",
    "aggregate",
    "export",
    "run",
    "daemon",
  ]) {
    const result = spawnSync(process.execPath, [executable, command, "--help"], {
      encoding: "utf8",
      env: { ...process.env, RUNNEL_HOME: "invalid-relative-catalog" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, new RegExp(`Usage:\\n  runnel ${command}`));
    helpByCommand.set(command, result.stdout);
  }
  const find = run(["find", "users", "-h"]).stdout;
  for (const option of ["filter", "filter-file", "projection", "sort", "skip", "format"])
    assert(find.includes(`--${option}`));
  assert(!find.includes("--pipeline"));
  assert.equal(helpByCommand.get("count")?.includes("--limit"), false);
  const scripts = helpByCommand.get("run");
  assert(scripts);
  assert.match(scripts, /--args-file/);
  assert.match(scripts, /1500ms/);
  assert.match(scripts, /For 2m30s use 150s/);
  assert(!scripts.includes("--filter"));
  assert.match(helpByCommand.get("export") ?? "", /never replaces/);
  assert.match(run(["daemon", "status", "-h"]).stdout, /status \| reset \| stop/);
});

test("catalog management CLI updates aliases without starting a worker", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-cli-management-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "catalog.json");
  const original = {
    schemaVersion: 1,
    settings: { idleTimeoutMs: 300000, scriptTimeoutMs: 300000 },
    environments: {
      local: {
        connections: { primary: { provider: "mongodb", secretRef: "keyring:runnel/cli-test" } },
        databases: { shop: { connection: "primary", database: "physical_shop" } },
      },
    },
  };
  writeFileSync(path, JSON.stringify(original));
  const invoke = (args: string[], status = 0) => {
    const result = spawnSync(process.execPath, [executable, ...args], {
      env: { ...process.env, RUNNEL_HOME: directory },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stderr, "");
    return JSON.parse(result.stdout);
  };
  assert.equal(
    invoke(["connection", "remove", "primary", "-e", "local"], 1).error.code,
    "ConnectionInUse"
  );
  assert.equal(
    invoke(["connection", "rotate", "primary", "-e", "local"], 1).error.code,
    "SetupTerminalRequired"
  );
  invoke([
    "database",
    "add",
    "reporting",
    "-e",
    "local",
    "--connection",
    "primary",
    "--database",
    "physical_reports",
  ]);
  invoke(["database", "rename", "reporting", "-e", "local", "--to", "reports"]);
  const listed = invoke(["databases", "-e", "local"]).data.databases;
  assert.deepEqual(listed, [
    { name: "reports", connection: "primary", database: "physical_reports" },
    { name: "shop", connection: "primary", database: "physical_shop" },
  ]);
  invoke(["database", "remove", "reports", "-e", "local"]);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), original);
  assert.deepEqual(invoke(["daemon", "status"]), { ok: true, data: { running: false } });
  assert.equal(invoke(["database", "remove", "shop"], 1).error.code, "EnvironmentRequired");
  assert.equal(
    invoke(["database", "add", "missing", "-e", "local"], 1).error.code,
    "ManagementInvalid"
  );
});

test("catalog management rejects unsupported actions and misplaced flags", () => {
  for (const args of [
    ["connection", "remove"],
    ["connection", "drop", "primary"],
    ["database", "rename", "shop", "--database", "other"],
    ["database", "remove", "shop", "--connection", "primary"],
    ["connection", "rotate", "primary", "--uri", "synthetic-secret"],
    ["find", "orders", "--to", "other"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.doesNotMatch(result.stderr, /synthetic-secret/);
  }
  for (const args of [
    ["connection", "rotate", "--help"],
    ["database", "rename", "--help"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("version flags print the owning package version", () => {
  for (const args of [["--version"], ["-v"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${manifest.version}\n`);
  }
});

test("help takes precedence when both information flags are supplied", () => {
  for (const args of [
    ["--help", "--version"],
    ["--version", "--help"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, run(["--help"]).stdout);
  }
});

test("syntax recovery distinguishes failures, redacts arguments, and never waits for stdin or creates state", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-cli-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const blocked = join(directory, "blocked");
  writeFileSync(blocked, "private invalid catalog path");
  const cases: [string[], RegExp, string?][] = [
    [["synthetic-secret"], /Unknown command/],
    [["synthetic-secret", "--help"], /Unknown command/],
    [["help", "synthetic-secret"], /Unknown command/],
    [["find"], /Missing collection operand/, "find"],
    [["describe"], /Missing collection operand/, "describe"],
    [["count"], /Missing collection operand/, "count"],
    [["aggregate"], /Missing collection operand/, "aggregate"],
    [["export"], /Missing collection operand/, "export"],
    [["run"], /Missing script operand/, "run"],
    [["find", "--filter-file", "-"], /Missing collection operand/, "find"],
    [["run", "--args-file", "-"], /Missing script operand/, "run"],
    [["find", "users", "--synthetic-secret=value"], /Unknown option/, "find"],
    [["find", "users", "-synthetic-secret"], /Unknown option/, "find"],
    [["setup", "--uri", "synthetic-secret"], /Unknown option/, "setup"],
    [["--help", "--synthetic-secret"], /Unknown option/],
    [["find", "users", "--limit"], /Missing value for --limit/, "find"],
    [["find", "users", "--limit", "--help"], /Missing value for --limit/, "find"],
    [["find", "users", "--limit", "--synthetic-secret"], /Missing value for --limit/, "find"],
    [["find", "users", "-e"], /Missing value for --env/, "find"],
    [["run", "synthetic-secret.mjs", "--timeout", "--help"], /Missing value for --timeout/, "run"],
    [["find", "--help=synthetic-secret"], /Option --help does not take a value/, "find"],
    [["find", "--help=synthetic-secret", "--help"], /Option --help does not take a value/, "find"],
    [["--help=true"], /Option --help does not take a value/],
    [["daemon"], /Missing daemon action/, "daemon"],
    [["daemon", "synthetic-secret", "--help"], /Invalid daemon action/, "daemon"],
    [["connection"], /Missing connection action/, "connection"],
    [["connection", "remove"], /Missing connection name operand/, "connection"],
    [["connection", "synthetic-secret", "primary"], /Invalid connection action/, "connection"],
    [["database", "rename"], /Missing database alias operand/, "database"],
    [["database", "synthetic-secret", "shop", "--help"], /Invalid database action/, "database"],
    [["skill", "synthetic-secret"], /Invalid skill action/, "skill"],
    [["guide", "synthetic-secret", "--help"], /Invalid guide topic/, "guide"],
    [["help", "database", "synthetic-secret"], /Invalid database action/, "database"],
    [["setup", "-e", "synthetic-secret"], /Unsupported option --env/, "setup"],
    [["daemon", "status", "-e", "local"], /Unsupported option --env/, "daemon"],
    [["envs", "-d", "synthetic-secret"], /Unsupported option --db/, "envs"],
    [["count", "--limit", "10", "--help"], /Unsupported option --limit/, "count"],
    [["envs", "--format", "ejson"], /Unsupported option --format/, "envs"],
    [["find", "users", "--to", "synthetic-secret"], /Unsupported option --to/, "find"],
    [
      ["database", "rename", "shop", "--database", "synthetic-secret"],
      /Unsupported option --database/,
      "database",
    ],
    [
      ["database", "remove", "shop", "--connection", "primary"],
      /Unsupported option --connection/,
      "database",
    ],
    [["find", "users", "--version"], /Unsupported option --version/, "find"],
    [["help", "find", "--limit", "10"], /Unsupported option --limit/, "find"],
    [["--env", "synthetic-secret"], /Unsupported option --env/],
    [["list", "synthetic-secret", "-e", "local"], /Unexpected operand/, "list"],
    [["run", "synthetic-secret.mjs", "extra", "--help"], /Unexpected operand/, "run"],
    [["help", "find", "synthetic-secret"], /Unexpected operand/, "find"],
    [["--version", "find", "synthetic-secret"], /Unsupported option --version/, "find"],
    [["--version", "synthetic-secret"], /Unknown command/],
  ];
  for (const home of [blocked, join(directory, "missing")]) {
    for (const [args, category, command] of cases) {
      const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(process.execPath, [executable, ...args], {
            env: { ...process.env, RUNNEL_HOME: home },
            stdio: ["pipe", "pipe", "pipe"],
            timeout: 3000,
          });
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString();
          });
          child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString();
          });
          child.once("error", reject);
          child.once("close", (status) => resolve({ status, stdout, stderr }));
          // Deliberately leave stdin open. Syntax errors must not consume input.
        }
      );
      assert.equal(result.status, 1, JSON.stringify(args));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, category);
      assert(
        result.stderr.includes(
          `Run runnel help${command === undefined ? "" : ` ${command}`} for usage.`
        )
      );
      assert.doesNotMatch(result.stderr, /synthetic-secret|mongodb:|CatalogInvalid/);
      assert.deepEqual(readdirSync(directory), ["blocked"]);
      assert.equal(readFileSync(blocked, "utf8"), "private invalid catalog path");
    }
  }
});

test("help verb matches command help and management action help without runtime imports", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-cli-lazy-help-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // Copy only the CLI. Any eager runtime import would fail in this directory.
  const copied = join(directory, "cli.mjs");
  copyFileSync(executable, copied);
  for (const args of [
    [],
    ["help"],
    ["--help"],
    ["help", "help"],
    ...[
      "guide",
      "skill",
      "setup",
      "envs",
      "connections",
      "databases",
      "connection",
      "database",
      "history",
      "list",
      "describe",
      "find",
      "count",
      "aggregate",
      "export",
      "run",
      "daemon",
    ].flatMap((command) => [
      ["help", command],
      [command, "--help"],
    ]),
    ...[
      ["connection", "rotate"],
      ["connection", "remove"],
      ["database", "add"],
      ["database", "rename"],
      ["database", "remove"],
    ].flatMap((target) => [
      ["help", ...target],
      [...target, "--help"],
    ]),
  ]) {
    const result = spawnSync(process.execPath, [copied, ...args], {
      env: { ...process.env, RUNNEL_HOME: "invalid-relative-catalog" },
      encoding: "utf8",
      timeout: 3000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Usage:/);
    assert.equal(result.stdout, run(args).stdout);
  }
  assert.equal(run(["help"]).stdout, run([]).stdout);
  assert.equal(run(["help", "find"]).stdout, run(["find", "--help"]).stdout);
  const rename = run(["help", "database", "rename"]).stdout;
  assert.match(rename, /runnel database rename <alias> -e <environment> --to <new-alias>/);
  assert(!rename.includes("--connection"));
  const add = run(["help", "database", "add"]).stdout;
  assert.match(add, /--connection <name> --database <physical-name>/);
  assert(!add.includes("--to"));
});

test("double dash, equals, short options and JSON/stdin strings retain their argument meaning", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-cli-values-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let index = 0;
  for (const [args, code, message] of [
    [
      ["find", "users", "-e", "local", "--limit=-1", "--filter-file", "-"],
      "InputInvalid",
      /--limit/,
    ],
    [["find", "users", "-elocal", "--skip=-1", "--filter-file", "-"], "InputInvalid", /--skip/],
    [
      ["run", "entry.mjs", "-e", "local", "--timeout=-1s", "--args-file", "-"],
      "InputInvalid",
      /--timeout/,
    ],
    [["find", "-e", "local", "--", "--help"], "EnvironmentNotFound", /setup/],
    [["find", "-e", "local", "--", "-users"], "EnvironmentNotFound", /setup/],
    [
      [
        "find",
        "users",
        "--env=-local",
        "--filter",
        '{"name":"--help","active":true}',
        "--sort",
        '{"n":-1}',
      ],
      "EnvironmentNotFound",
      /setup/,
    ],
    [["find", "users", "-e", "local", "--filter-file", "-"], "EnvironmentNotFound", /setup/],
    [
      ["run", "entry.mjs", "-e", "local", "--timeout=0", "--args-file", "-"],
      "EnvironmentNotFound",
      /setup/,
    ],
  ] as const) {
    const home = join(directory, `missing-${index++}`);
    const result = spawnSync(process.execPath, [executable, ...args], {
      env: { ...process.env, RUNNEL_HOME: home },
      encoding: "utf8",
      timeout: 15000,
      input: '{"flag":"--help","value":-1}',
    });
    try {
      assert.ifError(result.error);
      assert.equal(
        result.signal,
        null,
        `CLI terminated by ${result.signal}: ${JSON.stringify(args)}`
      );
      assert.equal(result.status, 1, result.stderr);
      assert.equal(result.stderr, "");
      const output = JSON.parse(result.stdout);
      assert.equal(output.error.code, code, result.stdout);
      assert.match(output.error.message, message);
      if (code === "InputInvalid") assert(!existsSync(home));
      assert(!existsSync(join(home, "catalog.json")));
    } finally {
      // Syntactically valid queries reach the worker and fail on an unconfigured
      // synthetic environment. Stop that worker before removing its private home.
      if (code === "EnvironmentNotFound") {
        const stopped = spawnSync(process.execPath, [executable, "daemon", "stop"], {
          env: { ...process.env, RUNNEL_HOME: home },
          encoding: "utf8",
          timeout: 10000,
        });
        assert.ifError(stopped.error);
        assert.equal(stopped.signal, null, `Daemon stop terminated by ${stopped.signal}`);
        assert.equal(stopped.status, 0, stopped.stderr);
      }
    }
  }
});

test("version comes from the artifact's package metadata regardless of cwd", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-cli-version-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "dist"));
  const copied = join(directory, "dist/cli.js");
  copyFileSync(executable, copied);
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ type: "module", version: "0.0.42" })
  );
  const result = spawnSync(process.execPath, [copied, "--version"], {
    cwd: tmpdir(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "0.0.42\n");
});

test("invalid package metadata produces a concise error and nonzero exit", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-cli-metadata-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "dist"));
  const copied = join(directory, "dist/cli.mjs");
  copyFileSync(executable, copied);
  for (const metadata of [undefined, "{", "{}", '{"version":42}', '{"version":""}']) {
    const file = join(directory, "package.json");
    if (metadata === undefined) rmSync(file, { force: true });
    else writeFileSync(file, metadata);
    const result = spawnSync(process.execPath, [copied, "--version"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Cannot read Runnel package version.\n");
  }
});
