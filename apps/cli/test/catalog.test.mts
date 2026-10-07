import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { catalogDirectory, decodeCatalog, emptyCatalog, readCatalog } from "../dist/catalog.js";

const executable = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const fixture = () => ({
  ...emptyCatalog(),
  environments: {
    work: {
      connections: { primary: { provider: "mongodb", secretRef: "keyring:runnel/fixture-01" } },
      databases: { accounts: { connection: "primary", database: "fixture_accounts" } },
    },
    empty: { connections: {}, databases: {} },
  },
});
const decode = (value: unknown) => Effect.runPromise(decodeCatalog(value).pipe(Effect.result));

test("catalog schema accepts named mappings and empty environments", async () => {
  const input = fixture();
  const result = await decode(input);
  assert(Result.isSuccess(result));
  assert.deepEqual(result.success, input);
});

test("catalog validation rejects unknown fields, secrets, names, providers, and dangling aliases", async () => {
  const env = fixture().environments.work;
  const invalid = [
    null,
    {},
    [],
    { ...fixture(), schemaVersion: 2 },
    { ...fixture(), uri: "mongodb://sensitive.invalid" },
    { ...fixture(), settings: { idleTimeoutMs: -1, scriptTimeoutMs: 300000 } },
    { ...fixture(), settings: { idleTimeoutMs: 1.5, scriptTimeoutMs: 300000 } },
    { ...fixture(), settings: { idleTimeoutMs: 300000, scriptTimeoutMs: 2147483648 } },
    { ...fixture(), environments: { "bad name": env } },
    { ...fixture(), environments: { constructor: env } },
    {
      ...fixture(),
      environments: {
        work: {
          ...env,
          connections: {
            primary: { provider: "postgres", secretRef: "keyring:runnel/fixture-01" },
          },
        },
      },
    },
    {
      ...fixture(),
      environments: {
        work: {
          ...env,
          connections: {
            primary: { provider: "mongodb", secretRef: "mongodb://sensitive.invalid" },
          },
        },
      },
    },
    {
      ...fixture(),
      environments: {
        work: {
          ...env,
          connections: {
            primary: { ...env.connections.primary, uri: "mongodb://sensitive.invalid" },
          },
        },
      },
    },
    {
      ...fixture(),
      environments: {
        work: { ...env, databases: { accounts: { connection: "missing", database: "fixture" } } },
      },
    },
    {
      ...fixture(),
      environments: {
        work: {
          ...env,
          databases: {
            accounts: { connection: "primary", database: "mongodb://sensitive.invalid" },
          },
        },
      },
    },
    JSON.parse(
      '{"schemaVersion":1,"settings":{"idleTimeoutMs":1,"scriptTimeoutMs":1},"environments":{"__proto__":{"connections":{},"databases":{}}}}'
    ),
  ];
  for (const input of invalid) {
    const result = await decode(input);
    assert(Result.isFailure(result), JSON.stringify(input));
    assert.equal(result.failure.code, "CatalogInvalid");
    assert.doesNotMatch(JSON.stringify(result.failure), /sensitive|mongodb:\/\//);
  }
});

test("physical database names obey cross-platform restrictions and UTF-8 byte limits", async () => {
  for (const database of [
    "bad name",
    " ",
    "bad\tname",
    "bad:name",
    "bad*name",
    "x".repeat(64),
    "é".repeat(32),
  ]) {
    const input = fixture();
    input.environments.work.databases.accounts.database = database;
    const result = await decode(input);
    assert(Result.isFailure(result), database);
    assert.equal(result.failure.code, "CatalogInvalid");
  }
  for (const database of ["x".repeat(63), "é".repeat(31)]) {
    const input = fixture();
    input.environments.work.databases.accounts.database = database;
    assert(Result.isSuccess(await decode(input)), database);
  }
});

test("configuration location is user-wide and supports platform-specific roots and absolute override", () => {
  const home = join(tmpdir(), "example-home");
  const base = join(tmpdir(), "example-config");
  assert.equal(catalogDirectory({}, "linux", home), join(home, ".config", "runnel"));
  assert.equal(catalogDirectory({ XDG_CONFIG_HOME: base }, "linux", home), join(base, "runnel"));
  assert.equal(catalogDirectory({}, "win32", home), join(home, "AppData", "Roaming", "runnel"));
  assert.equal(catalogDirectory({ APPDATA: base }, "win32", home), join(base, "runnel"));
  assert.equal(catalogDirectory({ RUNNEL_HOME: base }, "linux", home), base);
  for (const environment of [
    { RUNNEL_HOME: "relative" },
    { RUNNEL_HOME: "" },
    { XDG_CONFIG_HOME: "relative" },
  ]) {
    assert.throws(() => catalogDirectory(environment, "linux", home));
  }
});

test("missing catalogs are empty and do not create files", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-missing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const missing = join(directory, "missing");
  assert.deepEqual(await Effect.runPromise(readCatalog(missing)), emptyCatalog());
  assert.equal(existsSync(missing), false);
});

test("catalog reads fail safely on malformed, oversized, and unreadable files", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-invalid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "catalog.json");
  for (const content of [
    "{private-secret",
    " ".repeat(1024 * 1024 + 1),
    JSON.stringify({ ...fixture(), schemaVersion: 9 }),
  ]) {
    writeFileSync(path, content);
    const result = await Effect.runPromise(readCatalog(directory).pipe(Effect.result));
    assert(Result.isFailure(result));
    assert.equal(result.failure.code, "CatalogInvalid");
    assert.doesNotMatch(JSON.stringify(result.failure), /private-secret/);
  }
  rmSync(path);
  mkdirSync(path);
  const result = await Effect.runPromise(readCatalog(directory).pipe(Effect.result));
  assert(Result.isFailure(result));
  assert.equal(result.failure.code, "CatalogInvalid");
});

test("a FIFO catalog fails without waiting for a writer", {
  skip: process.platform === "win32",
}, (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-fifo-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("mkfifo", [join(directory, "catalog.json")]);
  const result = spawnSync(process.execPath, [executable, "envs"], {
    env: { ...process.env, RUNNEL_HOME: directory },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).error.code, "CatalogInvalid");
});

test("offline CLI discovery lists sorted names and mappings without secret references", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-discovery-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "catalog.json"), JSON.stringify(fixture()));
  const run = (args: string[]) =>
    spawnSync(process.execPath, [executable, ...args], {
      cwd: tmpdir(),
      env: { ...process.env, RUNNEL_HOME: directory },
      encoding: "utf8",
      timeout: 5000,
    });
  const cases = [
    { args: ["envs"], data: { environments: [{ name: "empty" }, { name: "work" }] } },
    {
      args: ["connections", "-e", "work"],
      data: { connections: [{ name: "primary", provider: "mongodb" }] },
    },
    {
      args: ["databases", "--env", "work"],
      data: {
        databases: [{ name: "accounts", connection: "primary", database: "fixture_accounts" }],
      },
    },
    { args: ["connections", "-e", "empty"], data: { connections: [] } },
    { args: ["databases", "-e", "empty"], data: { databases: [] } },
  ];
  for (const { args, data } of cases) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, data });
    assert.doesNotMatch(result.stdout, /keyring|secretRef|fixture-01/);
  }
  for (const { args, code } of [
    { args: ["connections"], code: "EnvironmentRequired" },
    { args: ["databases"], code: "EnvironmentRequired" },
    { args: ["databases", "-e", "missing"], code: "EnvironmentNotFound" },
    { args: ["connections", "-e", "constructor"], code: "EnvironmentNotFound" },
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, result.stderr);
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.error.code, code);
    assert.equal(result.stderr, "");
  }
});

test("offline CLI reports catalog failures without reflecting their contents", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-error-envelope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "catalog.json"), '{"uri":"mongodb://private-secret.invalid"}');
  const result = spawnSync(process.execPath, [executable, "envs"], {
    env: { ...process.env, RUNNEL_HOME: directory },
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, "CatalogInvalid");
  assert.doesNotMatch(result.stdout + result.stderr, /private-secret|mongodb:\/\//);
});
