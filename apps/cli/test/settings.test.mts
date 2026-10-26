import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { emptyCatalog, readCatalog } from "../dist/catalog.js";
import { daemonCommand } from "../dist/daemon-client.js";
import { startDaemon } from "../dist/daemon-server.js";
import { addDatabase } from "../dist/management.js";
import { getConfiguration, getSettings, setSettings, settingsLimits } from "../dist/settings.js";

const executable = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "runnel-settings-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}
const catalog = () => ({
  ...emptyCatalog(),
  environments: {
    local: {
      defaultConnection: "primary",
      connections: {
        primary: {
          provider: "mongodb",
          secretRef: "keyring:runnel/synthetic-private-reference",
          defaultDatabase: "accounts",
        },
      },
      databases: { shop: { connection: "primary", database: "physical_shop" } },
    },
  },
});
const cli = (home: string, args: string[]) =>
  spawnSync(process.execPath, [executable, ...args], {
    env: { ...process.env, RUNNEL_HOME: home },
    cwd: tmpdir(),
    encoding: "utf8",
    timeout: 10000,
  });

test("settings and redacted configuration reads are offline and do not create missing state", async (t) => {
  const parent = fixture(t),
    home = join(parent, "absent");
  assert.deepEqual((await Effect.runPromise(getSettings(home))).settings, {
    idleTimeoutMs: 300000,
    scriptTimeoutMs: 300000,
    historyEnabled: true,
  });
  const config = await Effect.runPromise(getConfiguration(home));
  assert.deepEqual(config.environments, []);
  assert.equal(config.applies.idleTimeoutMs, "next-daemon-start");
  for (const args of [["settings"], ["settings", "get"], ["config"], ["daemon", "status"]]) {
    const result = cli(home, args);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).ok, true);
  }
  assert(!existsSync(home));
});

test("configuration whitelists settings and named metadata without reading credentials", async (t) => {
  const home = fixture(t),
    path = join(home, "catalog.json");
  const before = JSON.stringify(catalog());
  writeFileSync(path, before);
  const result = await Effect.runPromise(getConfiguration(home));
  assert.deepEqual(result.environments, [
    {
      name: "local",
      defaultConnection: "primary",
      connections: [
        { name: "primary", provider: "mongodb", default: true, defaultDatabase: "accounts" },
      ],
      databases: [{ name: "shop", connection: "primary", database: "physical_shop" }],
    },
  ]);
  assert.equal(result.settings.historyEnabled, true);
  assert.doesNotMatch(JSON.stringify(result), /private-reference|secretRef|keyring:|mongodb:\/\//);
  assert.equal(readFileSync(path, "utf8"), before);
  assert(!existsSync(join(home, "daemon")));
});

test("supported settings validate all fields before creating state or mutating existing bytes", async (t) => {
  const parent = fixture(t),
    home = join(parent, "absent");
  for (const value of [
    null,
    [],
    {},
    { historyEnabled: "false" },
    { historyEnabled: undefined },
    { idleTimeoutMs: -1 },
    { idleTimeoutMs: 1.5 },
    { idleTimeoutMs: Infinity },
    { scriptTimeoutMs: NaN },
    { idleTimeoutMs: 2147483648 },
    { scriptTimeoutMs: 2147483548 },
    { historyEnabled: false, uri: "mongodb://private-fixture.invalid" },
  ]) {
    const result = await Effect.runPromise(setSettings(home, value).pipe(Effect.result));
    assert(
      Result.isFailure(result) && result.failure.code === "SettingsInvalid",
      JSON.stringify(value)
    );
    assert.doesNotMatch(JSON.stringify(result.failure), /private-fixture/);
    assert(!existsSync(home));
  }
  writeFileSync(join(parent, "catalog.json"), JSON.stringify(catalog()));
  const before = readFileSync(join(parent, "catalog.json"), "utf8");
  const result = await Effect.runPromise(
    setSettings(parent, { idleTimeoutMs: 1000, historyEnabled: "false" }).pipe(Effect.result)
  );
  assert(Result.isFailure(result));
  assert.equal(readFileSync(join(parent, "catalog.json"), "utf8"), before);
});

test("settings merge under the catalog lock and retain concurrent aliases, references and unrelated fields", async (t) => {
  const home = fixture(t);
  writeFileSync(join(home, "catalog.json"), JSON.stringify(catalog()));
  await Promise.all([
    Effect.runPromise(setSettings(home, { idleTimeoutMs: 1000 })),
    Effect.runPromise(setSettings(home, { historyEnabled: false })),
    addDatabase(home, {
      env: "local",
      alias: "reporting",
      connection: "primary",
      database: "reports",
    }).then((result) => assert(result.ok)),
  ]);
  const result = await Effect.runPromise(readCatalog(home));
  assert.deepEqual(result.settings, {
    idleTimeoutMs: 1000,
    scriptTimeoutMs: 300000,
    historyEnabled: false,
  });
  assert.deepEqual(
    result.environments["local"]?.connections,
    catalog().environments.local.connections
  );
  assert.equal(result.environments["local"]?.databases["reporting"]?.database, "reports");
  assert.equal(result.environments["local"]?.defaultConnection, "primary");
  assert(!existsSync(join(home, "daemon")));
  for (const field of ["idleTimeoutMs", "scriptTimeoutMs"] as const) {
    for (const value of [0, settingsLimits[field].maximum])
      assert.equal(
        (await Effect.runPromise(setSettings(home, { [field]: value }))).settings[field],
        value
      );
  }
});

test("v1 settings reads preserve bytes; supported writes migrate to v2 and future schemas are never overwritten", async (t) => {
  const home = fixture(t),
    path = join(home, "catalog.json");
  const legacy = { ...emptyCatalog(), schemaVersion: 1 };
  const before = JSON.stringify(legacy);
  writeFileSync(path, before);
  assert.equal((await Effect.runPromise(getConfiguration(home))).schemaVersion, 2);
  assert.equal(readFileSync(path, "utf8"), before);
  await Effect.runPromise(setSettings(home, { historyEnabled: false }));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).schemaVersion, 2);
  const future = JSON.stringify({ ...legacy, schemaVersion: 3 });
  writeFileSync(path, future);
  assert(
    Result.isFailure(
      await Effect.runPromise(setSettings(home, { idleTimeoutMs: 100 }).pipe(Effect.result))
    )
  );
  assert.equal(readFileSync(path, "utf8"), future);
});

test("CLI settings parse exact milliseconds/booleans and reject unsupported or private input without starting services", (t) => {
  const home = fixture(t);
  const result = cli(home, [
    "settings",
    "set",
    "--idle-timeout-ms",
    "0",
    "--script-timeout-ms",
    "12345",
    "--history-enabled",
    "false",
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout).data.settings, {
    idleTimeoutMs: 0,
    scriptTimeoutMs: 12345,
    historyEnabled: false,
  });
  const before = readFileSync(join(home, "catalog.json"), "utf8");
  for (const args of [
    ["settings", "set"],
    ["settings", "set", "--script-timeout-ms=private-fixture"],
    ["settings", "set", "--history-enabled", "yes"],
    ["settings", "get", "--history-enabled", "false"],
  ]) {
    const invalid = cli(home, args);
    assert.equal(invalid.status, 1);
    assert.doesNotMatch(invalid.stdout + invalid.stderr, /private-fixture/);
    assert.equal(readFileSync(join(home, "catalog.json"), "utf8"), before);
  }
  assert(!existsSync(join(home, "daemon")));
});

test("idle setting changes affect the next daemon and offline inspection does not keep the current daemon alive", {
  timeout: 5000,
}, async (t) => {
  const home = fixture(t);
  await Effect.runPromise(setSettings(home, { idleTimeoutMs: 700 }));
  const daemon = await startDaemon(home);
  t.after(() => daemon.stop());
  const status = await daemonCommand(home, "status");
  assert(status.ok && "worker" in status.data && status.data.worker.pid === undefined);
  await Effect.runPromise(setSettings(home, { idleTimeoutMs: 0 }));
  await Effect.runPromise(getConfiguration(home));
  await daemon.closed;
  assert.equal((await Effect.runPromise(getSettings(home))).settings.idleTimeoutMs, 0);
  const replacement = await startDaemon(home);
  t.after(() => replacement.stop());
  const next = await daemonCommand(home, "status");
  assert(next.ok && "running" in next.data && next.data.running);
  await replacement.stop();
});
