import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Called by pack-check only. Resolve every runtime dependency from the installed consumer.
const consumer = resolve(process.argv[2]);
const installed = createRequire(join(consumer, "package.json"));
const load = (name) => import(pathToFileURL(installed.resolve(name)).href);
const cliRoot = join(consumer, "node_modules/@abijith-suresh/runnel");
const internal = (name) => import(pathToFileURL(join(cliRoot, "dist", `${name}.js`)).href);
const Effect = await load("effect/Effect");
const { MongoClient, BSON } = await load("mongodb");
const { registerConnection } = await internal("setup");
const { credentialStore } = await internal("secrets");
const { readCatalog } = await internal("catalog");
const directory = await mkdtemp(join(tmpdir(), "runnel-mongodb-"));
const home = join(directory, "catalog");
const uri = `mongodb://127.0.0.1:${process.env.RUNNEL_TEST_MONGODB_PORT}/?directConnection=true`;
const names = [0, 1].map((index) => `runnel_check_${randomUUID().replaceAll("-", "")}_${index}`);
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000, timeoutMS: 10000 });
const secrets = credentialStore();
const references = [];
let connected = false;
let stage = "connection";
let failure = false;
const cli = (args, error, input) => {
  stage = args[0];
  const child = spawnSync(process.execPath, [join(cliRoot, "dist/cli.js"), ...args], {
    cwd: directory,
    env: { ...process.env, RUNNEL_HOME: home },
    encoding: "utf8",
    timeout: 30000,
    input,
  });
  assert.equal(child.status, error ? 1 : 0);
  assert.equal(child.stderr, "");
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, !error);
  if (error) assert.equal(result.error.code, error);
  else assert.equal(result.warning, undefined);
  return result.data;
};
try {
  await client.connect();
  connected = true;
  const first = client.db(names[0]);
  const second = client.db(names[1]);
  await first.collection("users").insertMany([
    { name: "Ada", active: true, serial: BSON.Long.fromString("9007199254740993") },
    { name: "Grace", active: true },
    { name: "Linus", active: false },
  ]);
  await second.collection("events").insertOne({ kind: "synthetic" });
  stage = "registration";
  for (const [env, aliases] of [
    [
      "local",
      [
        { name: "accounts", database: names[0] },
        { name: "analytics", database: names[1] },
      ],
    ],
    ["other", [{ name: "analytics", database: names[1] }]],
  ]) {
    const catalog = await Effect.runPromise(
      registerConnection(home, { env, connection: "primary", uri, aliases })
    );
    references.push(catalog.environments[env].connections.primary.secretRef);
  }
  assert(!(await readFile(join(home, "catalog.json"), "utf8")).includes(uri));
  assert.deepEqual(
    cli(["envs"]).environments.map(({ name }) => name),
    ["local", "other"]
  );
  assert.equal(cli(["connections", "-e", "local"]).connections[0].provider, "mongodb");
  assert.equal(cli(["databases", "-e", "local"]).databases.length, 2);
  cli(["list"], "EnvironmentRequired");
  cli(["list", "-e", "local"], "DatabaseRequired");
  cli(["list", "-e", "local", "-d", "missing"], "DatabaseNotFound");
  const target = ["-e", "local", "-d", "accounts"];
  assert(cli(["list", ...target]).collections.some(({ name }) => name === "users"));
  assert.equal(cli(["list", "-e", "other"]).db, "analytics");
  const initialPid = cli(["daemon", "status"]).worker.pid;
  assert.equal(cli(["describe", "users", ...target]).metadata.name, "users");
  await writeFile(join(directory, "filter.json"), '{"active":true}\n');
  const found = cli([
    "find",
    "users",
    ...target,
    "--filter-file",
    "filter.json",
    "--sort",
    '{"name":1}',
    "--limit",
    "1",
  ]);
  assert.equal(found.documents[0].serial.$numberLong, "9007199254740993");
  assert.equal(found.truncated, true);
  assert.equal(found.truncationReason, "documents");
  assert.equal(
    cli(["count", "users", ...target, "--filter-file", "-"], undefined, '{"active":true}').count,
    2
  );
  await writeFile(
    join(directory, "pipeline.json"),
    '[{"$match":{"active":true}},{"$count":"total"}]\n'
  );
  assert.equal(
    cli(["aggregate", "users", ...target, "--pipeline-file", "pipeline.json", "--format", "json"])
      .documents[0].total,
    2
  );
  cli(["find", "users", ...target, "--format", "json"], "ResultPrecisionLoss");
  const script = join(directory, "compare #%.mjs");
  await writeFile(
    script,
    `let runs = 0;
export default async ({ db, args, connect, signal, bson }) => {
  const other = await connect({ env: "other" });
  return {
    runs: ++runs,
    users: await db.collection("users").countDocuments(args.filter, { signal }),
    events: await other.collection("events").countDocuments({}, { signal }),
    id: new bson.ObjectId("0123456789abcdef01234567"),
  };
};\n`
  );
  const run = ["run", script, ...target, "--format", "json"];
  const compared = cli([...run, "--args", '{"filter":{"active":true}}']).value;
  assert.equal(compared.users, 2);
  assert.equal(compared.events, 1);
  assert.equal(compared.runs, 1);
  assert.equal(compared.id.$oid, "0123456789abcdef01234567");
  await writeFile(join(directory, "args.json"), '{"filter":{}}\n');
  assert.equal(cli([...run, "--args-file", "args.json"]).value.runs, 2);
  assert.equal(cli([...run, "--args-file", "-"], undefined, '{"filter":{}}').value.runs, 3);
  assert.equal(cli(["daemon", "status"]).worker.pid, initialPid);
  await writeFile(script, "export default async ({ db }) => ({ name: db.databaseName });\n");
  cli(run, "ScriptChanged");
  cli(["daemon", "reset"]);
  assert.equal(cli(run).value.name, names[0]);
  assert.notEqual(cli(["daemon", "status"]).worker.pid, initialPid);
  const exported = cli(["export", "users", ...target, "--limit", "2", "--output", "users.ejson"]);
  assert.equal(exported.documents, 2);
  assert.equal(exported.truncated, true);
  const contents = await readFile(join(directory, "users.ejson"), "utf8");
  assert.equal(JSON.parse(contents).length, 2);
  cli(["export", "users", ...target, "--output", "users.ejson"], "OutputExists");
  assert.equal(await readFile(join(directory, "users.ejson"), "utf8"), contents);
  const entries = cli(["history"]).entries;
  assert.equal(entries.length, 15);
  assert.equal(entries.filter(({ operation }) => operation === "run").length, 5);
  assert(entries.some(({ outcome }) => outcome.code === "ScriptChanged"));
  const history = JSON.stringify(entries);
  for (const excluded of [
    uri,
    ...names,
    ...references,
    script,
    "Ada",
    "9007199254740993",
    "users.ejson",
    "active",
  ])
    assert(!history.includes(excluded));
  cli(["daemon", "stop"]);
  assert.equal(cli(["daemon", "status"]).running, false);
  assert.equal(cli(["envs"]).environments.length, 2);
  assert.equal(cli(["daemon", "status"]).running, false);
  const catalog = await Effect.runPromise(readCatalog(home));
  assert.equal(Object.keys(catalog.environments).length, 2);
} catch {
  failure = true;
  process.stderr.write(`Installed MongoDB smoke check failed during ${stage}.\n`);
} finally {
  stage = "cleanup";
  try {
    const cleanup = await Promise.allSettled([
      Promise.resolve().then(() => cli(["daemon", "stop"])),
      ...references.map(async (reference) =>
        assert.equal(await Effect.runPromise(secrets.remove(reference)), true)
      ),
      ...(connected ? names.map((name) => client.db(name).dropDatabase()) : []),
    ]);
    assert(cleanup.every(({ status }) => status === "fulfilled"));
  } catch {
    failure = true;
    process.stderr.write("Installed MongoDB smoke check cleanup failed.\n");
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}
if (failure) process.exitCode = 1;
else
  process.stdout.write(
    "Installed CLI MongoDB queries, native scripts, resets, exports, offline discovery, history and cleanup passed.\n"
  );
