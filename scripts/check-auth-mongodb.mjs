import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { installLocal } from "./local-install.mjs";
import { createAuthenticatedFixture } from "./mongodb-auth-fixture.mjs";

const root = await mkdtemp(join(tmpdir(), "runnel-auth-install-"));
let fixture;
let stage = "installation";
try {
  const { directory: consumer } = installLocal(process.cwd(), join(root, "consumer"));
  stage = "authenticated fixture";
  fixture = await createAuthenticatedFixture(consumer);
  const { directory, home, cliRoot, client, database } = fixture;
  const cli = (args, error) => {
    const result = spawnSync(process.execPath, [join(cliRoot, "dist/cli.js"), ...args], {
      cwd: directory,
      env: { ...process.env, RUNNEL_HOME: home },
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(result.status, error ? 1 : 0);
    assert.equal(result.stderr, "");
    const envelope = JSON.parse(result.stdout);
    assert.equal(envelope.ok, !error);
    if (error) assert.equal(envelope.error.code, error);
    assert.equal(envelope.warning, undefined);
    return envelope.data;
  };
  stage = "authenticated reads and BSON precision";
  assert.equal(cli(["count", "orders", "-e", "readonly"]).count, 6);
  const found = cli(["find", "orders", "-e", "readonly", "--filter", '{"customer":"Ada"}']);
  assert.equal(found.documents.length, 3);
  assert.equal(found.documents[0].serial.$numberLong, "9007199254740993");
  cli(["find", "orders", "-e", "readonly", "--format", "json"], "ResultPrecisionLoss");
  const total = cli([
    "aggregate",
    "orders",
    "-e",
    "readonly",
    "--pipeline",
    '[{"$match":{"status":"paid"}},{"$group":{"_id":null,"total":{"$sum":"$total"}}}]',
    "--format",
    "json",
  ]);
  assert.equal(total.documents[0].total, 170);
  stage = "permission denial without replay";
  await writeFile(
    join(directory, "write.mjs"),
    'export default async ({db}) => await db.collection("attempts").insertOne({synthetic:true});\n'
  );
  cli(["run", "write.mjs", "-e", "readonly"], "PermissionDenied");
  assert.equal(await client.db(database).collection("attempts").countDocuments(), 0);
  cli(["run", "write.mjs", "-e", "sandbox"]);
  assert.equal(await client.db(database).collection("attempts").countDocuments(), 1);
  cli(
    ["aggregate", "orders", "-e", "readonly", "--pipeline", '[{"$out":"denied_output"}]'],
    "PermissionDenied"
  );
  assert.equal(await client.db(database).collection("denied_output").countDocuments(), 0);
  stage = "credential rotation and warm pool refresh";
  const { rotateConnection } = await import(
    pathToFileURL(join(cliRoot, "dist/management.js")).href
  );
  const { readCatalog } = await import(pathToFileURL(join(cliRoot, "dist/catalog.js")).href);
  const rotate = async (uri) => {
    const result = await rotateConnection(
      home,
      { env: "sandbox", connection: "primary" },
      {
        color: false,
        write() {},
        ask: async () => uri,
        progress: (_label, work) => work(new AbortController().signal),
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.warning, undefined);
    const catalog = await fixture.Effect.runPromise(readCatalog(home));
    fixture.references.add(catalog.environments.sandbox.connections.primary.secretRef);
    assert.equal(catalog.environments.sandbox.databases.shop.database, database);
  };
  const workerPid = cli(["daemon", "status"]).worker.pid;
  await rotate(fixture.uris.reader);
  cli(["run", "write.mjs", "-e", "sandbox"], "PermissionDenied");
  assert.equal(cli(["count", "orders", "-e", "sandbox"]).count, 6);
  await rotate(fixture.uris.writer);
  cli(["run", "write.mjs", "-e", "sandbox"]);
  assert.equal(await client.db(database).collection("attempts").countDocuments(), 2);
  assert.equal(cli(["daemon", "status"]).worker.pid, workerPid);
  stage = "catalog lifecycle without physical database changes";
  cli([
    "database",
    "add",
    "extra",
    "-e",
    "sandbox",
    "--connection",
    "primary",
    "--database",
    database,
  ]);
  cli(["database", "rename", "extra", "-e", "sandbox", "--to", "renamed"]);
  assert.equal(cli(["count", "orders", "-e", "sandbox", "-d", "renamed"]).count, 6);
  cli(["connection", "remove", "primary", "-e", "sandbox"], "ConnectionInUse");
  cli(["database", "remove", "renamed", "-e", "sandbox"]);
  stage = "truncation and export";
  const exported = cli([
    "export",
    "many",
    "-e",
    "readonly",
    "--limit",
    "1000",
    "--output",
    "many.ejson",
  ]);
  assert.equal(exported.truncated, true);
  assert.equal(exported.truncationReason, "documents");
  assert.equal(JSON.parse(await readFile(join(directory, "many.ejson"), "utf8")).length, 1000);
  stage = "expired credential and recovery";
  await client.db(database).command({ updateUser: "reader", pwd: "expired-synthetic-password" });
  cli(["daemon", "reset"]);
  cli(["count", "orders", "-e", "readonly"], "AuthenticationFailed");
  assert.equal(cli(["count", "orders", "-e", "sandbox"]).count, 6);
  stage = "history redaction";
  const history = JSON.stringify(cli(["history"]).entries);
  for (const privateValue of [database, ...Object.values(fixture.uris), "Ada", "write.mjs"])
    assert(!history.includes(privateValue));
  process.stdout.write(
    "Installed CLI authenticated reads, denied writes, rotation, pool refresh, alias lifecycle, BSON, truncation, expired credentials, recovery and history passed.\n"
  );
} catch (error) {
  const fixtureStage = typeof error?.fixtureStage === "string" ? ` (${error.fixtureStage})` : "";
  const detail = typeof error?.fixtureDetail === "string" ? `: ${error.fixtureDetail}` : "";
  const cleanupNote = error?.fixtureCleanupFailed === true ? " Fixture cleanup also failed." : "";
  process.stderr.write(
    `Authenticated MongoDB check failed during ${stage}${fixtureStage}${detail}.${cleanupNote}\n`
  );
  process.exitCode = 1;
} finally {
  try {
    await fixture?.cleanup();
  } catch {
    process.stderr.write("Authenticated MongoDB fixture cleanup failed.\n");
    process.exitCode = 1;
  }
  await rm(root, { recursive: true, force: true });
}
