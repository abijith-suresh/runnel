// Copied into a temporary installed consumer by pack-check. Only fake vault/provider objects.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";

const base = new URL("./node_modules/@abijith-suresh/runnel/dist/", import.meta.url);
const { setup } = await import(new URL("setup.js", base));
const { credentialStore } = await import(new URL("secrets.js", base));
const { workerOperations } = await import(new URL("worker-operations.js", base));
const { readCatalog } = await import(new URL("catalog.js", base));
const directory = fileURLToPath(new URL("./fake-setup-catalog", import.meta.url));
const stored = new Map();
const secrets = credentialStore(async (id) => ({
  setPassword: async (value) => {
    stored.set(id, value);
  },
  getPassword: async () => stored.get(id),
  deleteCredential: async () => stored.delete(id),
}));
for (const [connection, database] of [
  [undefined, "accounts"],
  ["reporting", "reports"],
]) {
  let asked = 0;
  const result = await setup(
    directory,
    {
      color: false,
      ask: async (_label, options) => {
        asked++;
        assert.equal(options.hidden, true);
        return `mongodb://synthetic:private-fixture@host.invalid/${database}?authSource=auth`;
      },
      write() {},
      progress() {
        throw new Error("Registration must not inspect MongoDB");
      },
    },
    { secrets },
    { env: "local", ...(connection === undefined ? {} : { connection }) }
  );
  assert(result.ok);
  assert.equal(asked, 1);
}
assert(!existsSync(join(directory, "daemon")));
assert(!readFileSync(join(directory, "catalog.json"), "utf8").includes("private-fixture"));
const cli = (args) => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("cli.js", base)), ...args], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { ...process.env, RUNNEL_HOME: directory },
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).data;
};
assert.equal(cli(["databases", "-e", "local"]).defaultDatabase, "accounts");
assert.deepEqual(cli(["databases", "-e", "local"]).databases, []);
if (process.platform === "win32") {
  // Exercise npm's actual .cmd shim through native PowerShell from outside the
  // consumer and source tree. Static commands only; credentials remain fake.
  const launcher = fileURLToPath(new URL("./node_modules/.bin/runnel.cmd", import.meta.url));
  for (const command of ["help setup", "connections -e local"]) {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `& $env:RUNNEL_INSTALLED_LAUNCHER ${command}; exit $LASTEXITCODE`,
      ],
      {
        cwd: tmpdir(),
        env: { ...process.env, RUNNEL_HOME: directory, RUNNEL_INSTALLED_LAUNCHER: launcher },
        encoding: "utf8",
        timeout: 15000,
        windowsHide: true,
      }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    if (command === "help setup") assert.match(result.stdout, /one|hidden URI|hidden prompt/);
    else assert.equal(JSON.parse(result.stdout).data.connections[0].defaultDatabase, "accounts");
    assert.doesNotMatch(result.stdout, /private-fixture|keyring:|secretRef/);
  }
}
const acquired = [];
const operations = workerOperations(
  directory,
  {
    database: async (...args) => {
      acquired.push(args);
      return {
        databaseName: args[2],
        listCollections: () => ({ async *[Symbol.asyncIterator]() {}, close: async () => {} }),
      };
    },
    close: async () => {},
  },
  secrets
);
try {
  const initial = await operations.execute({ operation: "list", env: "local" });
  assert(initial.ok && initial.data.db === "accounts");
  cli(["connection", "default", "reporting", "-e", "local"]);
  const next = await operations.execute({ operation: "list", env: "local", db: "unregistered" });
  assert(next.ok && next.data.db === "unregistered");
  assert.equal(acquired.at(-1)[0], JSON.stringify(["local", "reporting"]));
  const entry = fileURLToPath(new URL("./fake-connect.mjs", import.meta.url));
  writeFileSync(
    entry,
    `export default async ({db,connect}) => ({
    primary: (await connect({env:'local',connection:'primary',db:'physical'})).databaseName,
    current: db.databaseName
  });\n`
  );
  const script = await operations.execute({
    operation: "run",
    path: entry,
    env: "local",
    timeoutMs: 5000,
  });
  assert(script.ok);
  assert.deepEqual(script.data.value, { primary: "physical", current: "reports" });
  // A v1 catalog migrates through the actual installed CLI without vault access.
  const catalog = await Effect.runPromise(readCatalog(directory));
  const legacy = {
    ...catalog,
    schemaVersion: 1,
    environments: {
      local: {
        connections: { primary: { provider: "mongodb", secretRef: "keyring:runnel/legacy" } },
        databases: { old: { connection: "primary", database: "legacy_database" } },
      },
    },
  };
  writeFileSync(join(directory, "catalog.json"), JSON.stringify(legacy));
  assert.deepEqual(cli(["databases", "-e", "local"]).databases, [
    { name: "old", connection: "primary", database: "legacy_database" },
  ]);
  assert.equal(JSON.parse(readFileSync(join(directory, "catalog.json"), "utf8")).schemaVersion, 1);
  cli(["connection", "default", "primary", "-e", "local"]);
  assert.equal(JSON.parse(readFileSync(join(directory, "catalog.json"), "utf8")).schemaVersion, 2);
  assert.equal(cli(["databases", "-e", "local"]).defaultConnection, "primary");
} finally {
  await operations.close();
  const stop = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("cli.js", base)), "daemon", "stop"],
    {
      env: { ...process.env, RUNNEL_HOME: directory },
      encoding: "utf8",
      timeout: 10000,
    }
  );
  assert.equal(stop.status, 0, stop.stderr);
}
