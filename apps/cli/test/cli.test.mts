import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const executable = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const run = (args: string[]) =>
  spawnSync(process.execPath, [executable, ...args], {
    encoding: "utf8",
    env: { ...process.env, RUNNEL_HOME: "invalid-relative-catalog" },
  });

test("no arguments print available options on stdout", () => {
  const result = run([]);
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
});

test("command help works without operands or catalog access and lists only supported options", () => {
  const helpByCommand = new Map<string, string>();
  for (const command of ["find", "count", "run", "export", "daemon"]) {
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

test("syntax recovery distinguishes failures, redacts arguments, and never waits for stdin or creates state", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-cli-recovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const blocked = join(directory, "blocked");
  writeFileSync(blocked, "private invalid catalog path");
  const cases: [string[], RegExp, string?][] = [
    [["synthetic-secret"], /Unknown command/],
    [["find", "--filter-file", "-"], /Missing collection operand/, "find"],
    [["run", "--args-file", "-"], /Missing script operand/, "run"],
    [["find", "users", "--synthetic-secret=value"], /Unknown option/, "find"],
    [["find", "users", "--limit", "--help"], /Missing value for --limit/, "find"],
    [["find", "--help=synthetic-secret"], /Option --help does not take a value/, "find"],
    [["daemon"], /Missing daemon action/, "daemon"],
    [["database", "constructor", "-e", "local"], /Invalid database action/, "database"],
    [["connection", "remove"], /Missing connection name operand/, "connection"],
    [["setup", "--uri", "synthetic-secret"], /Unknown option/, "setup"],
    [["count", "--limit", "10", "--help"], /Unsupported option --limit/, "count"],
    [
      ["database", "remove", "shop", "--connection", "primary"],
      /Unsupported option --connection/,
      "database",
    ],
    [["list", "synthetic-secret", "-e", "local"], /Unexpected operand/, "list"],
  ];
  const home = blocked;
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
});

test("help verb prints management action usage without catalog access", () => {
  const result = run(["help", "database", "rename"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /runnel database rename <alias> -e <environment> --to <new-alias>/);
  assert(!result.stdout.includes("--connection"));
});

test("double dash and JSON option values retain their argument meaning", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-cli-values-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let index = 0;
  for (const args of [
    ["find", "--env=local", "--", "--help"],
    ["find", "users", "-elocal", "--filter", '{"name":"--help","value":-1}', "--sort", '{"n":-1}'],
  ]) {
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
      assert.equal(output.error.code, "EnvironmentNotFound", result.stdout);
      assert(!existsSync(join(home, "catalog.json")));
    } finally {
      // Syntactically valid queries reach the worker and fail on an unconfigured
      // synthetic environment. Stop that worker before removing its private home.
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
});
