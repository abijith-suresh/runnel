import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

/** Disposable, authenticated server and synthetic credentials. Never reads the user's catalog. */
export async function createAuthenticatedFixture(consumer) {
  const installed = createRequire(join(consumer, "package.json"));
  const load = (name) => import(pathToFileURL(installed.resolve(name)).href);
  const cliRoot = join(consumer, "node_modules/@abijith-suresh/runnel");
  const internal = (name) => import(pathToFileURL(join(cliRoot, "dist", `${name}.js`)).href);
  const { MongoClient, BSON } = await load("mongodb");
  const Effect = await load("effect/Effect");
  const { registerConnection } = await internal("setup");
  const { readCatalog } = await internal("catalog");
  const { credentialStore } = await internal("secrets");
  const directory = await mkdtemp(join(tmpdir(), "runnel-auth-"));
  const home = join(directory, "catalog");
  const container = `runnel-auth-${randomUUID()}`;
  const database = `runnel_check_${randomUUID().replaceAll("-", "")}`;
  const adminPassword = randomUUID();
  const readerPassword = randomUUID();
  const writerPassword = randomUUID();
  const references = new Set();
  const secrets = credentialStore();
  let started = false;
  let client;
  let stage = "container start";
  // Never surface credentials or connection strings, even inside driver messages.
  const redact = (value) => {
    let message = typeof value === "string" ? value : "";
    for (const privateValue of [adminPassword, readerPassword, writerPassword, database])
      message = message.split(privateValue).join("[redacted]");
    return message.replace(/mongodb(?:\+srv)?:\/\/\S+/gi, "[redacted-uri]");
  };
  const annotate = (error) => {
    try {
      error.fixtureStage = stage;
      error.fixtureDetail = `${error?.name ?? "Error"}${
        typeof error?.code === "string" ? ` [${redact(error.code)}]` : ""
      }: ${redact(error?.message ?? "")}`;
    } catch {
      // A frozen or exotic thrown value still keeps the outer stage message.
    }
    return error;
  };
  const podman = (args, input) => {
    const result = spawnSync("podman", args, {
      input,
      encoding: "utf8",
      timeout: 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (result.status !== 0) throw new Error("The disposable MongoDB container command failed.");
    return result.stdout.trim();
  };
  const cleanup = async () => {
    // Capture a committed reference even when an assertion failed immediately
    // after rotation, before the caller could add it to the tracked set.
    let failed = false;
    try {
      const catalog = await Effect.runPromise(readCatalog(home));
      for (const env of Object.values(catalog.environments))
        for (const connection of Object.values(env.connections))
          references.add(connection.secretRef);
    } catch {
      failed = true;
    }
    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() => {
        const stopped = spawnSync(
          process.execPath,
          [join(cliRoot, "dist/cli.js"), "daemon", "stop"],
          {
            env: { ...process.env, RUNNEL_HOME: home },
            encoding: "utf8",
            timeout: 30000,
          }
        );
        assert.equal(stopped.status, 0);
      }),
      ...[...references].map((reference) => Effect.runPromise(secrets.remove(reference))),
      ...(client ? [client.close()] : []),
    ]);
    failed ||= outcomes.some((outcome) => outcome.status === "rejected");
    if (started) {
      try {
        podman(["rm", "--force", "--volumes", container]);
      } catch {
        failed = true;
      }
    }
    await rm(directory, { recursive: true, force: true });
    if (failed) throw new Error("Cannot clean up every authenticated MongoDB fixture.");
  };
  try {
    podman([
      "run",
      "--detach",
      "--name",
      container,
      "--publish",
      "127.0.0.1::27017",
      "docker.io/mongodb/mongodb-community-server:8.0-ubuntu2204",
      "--auth",
      "--bind_ip_all",
    ]);
    started = true;
    stage = "port discovery";
    const address = podman(["port", container, "27017"]);
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    const port = Number(address.split(":")[1]);
    const base = `mongodb://127.0.0.1:${port}/?directConnection=true`;
    stage = "server readiness";
    // A client closes permanently after its first failed selection, so each attempt
    // needs its own client: the container accepts the port before mongod listens.
    const pingOnce = async () => {
      const probe = new MongoClient(base, { serverSelectionTimeoutMS: 500, timeoutMS: 1000 });
      try {
        await probe.db("admin").command({ ping: 1 });
        return true;
      } catch {
        return false;
      } finally {
        await probe.close();
      }
    };
    let ready = false;
    const readyDeadline = Date.now() + 30000;
    while (!ready && Date.now() < readyDeadline) {
      ready = await pingOnce();
      if (!ready) await delay(250);
    }
    assert(ready, "The disposable MongoDB server did not become ready.");
    // The localhost exception is used only inside our new container to create its first user.
    stage = "fixture administrator";
    podman(
      [
        "exec",
        "--interactive",
        container,
        "mongosh",
        "--quiet",
        "--eval",
        'const f = JSON.parse(require("fs").readFileSync(0, "utf8")); db.getSiblingDB("admin").createUser({user:"runnel_fixture_admin",pwd:f.password,roles:["root"]});',
      ],
      JSON.stringify({ password: adminPassword })
    );
    stage = "fixture client connection";
    const connectAdmin = async () => {
      let lastError;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        const candidate = new MongoClient(`${base}&authSource=admin`, {
          auth: { username: "runnel_fixture_admin", password: adminPassword },
          serverSelectionTimeoutMS: 5000,
          timeoutMS: 10000,
        });
        try {
          await candidate.connect();
          return candidate;
        } catch (error) {
          lastError = error;
          await candidate.close();
          await delay(250);
        }
      }
      throw lastError ?? new Error("The disposable MongoDB server did not accept credentials.");
    };
    client = await connectAdmin();
    stage = "sample documents";
    const db = client.db(database);
    await db.collection("orders").insertMany([
      {
        customer: "Ada",
        status: "paid",
        total: 40,
        serial: BSON.Long.fromString("9007199254740993"),
      },
      { customer: "Grace", status: "paid", total: 60 },
      { customer: "Ada", status: "pending", total: 25 },
      { customer: "Linus", status: "paid", total: 30 },
      { customer: "Grace", status: "cancelled", total: 10 },
      { customer: "Ada", status: "paid", total: 40 },
    ]);
    await db.collection("many").insertMany(Array.from({ length: 1100 }, (_, index) => ({ index })));
    stage = "database users";
    for (const [user, pwd, role] of [
      ["reader", readerPassword, "read"],
      ["writer", writerPassword, "readWrite"],
    ])
      await db.command({ createUser: user, pwd, roles: [{ role, db: database }] });
    const uri = (user, password) =>
      `mongodb://${user}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}?directConnection=true&authSource=${database}`;
    const uris = { reader: uri("reader", readerPassword), writer: uri("writer", writerPassword) };
    stage = "catalog registration";
    for (const env of ["readonly", "sandbox"]) {
      const catalog = await Effect.runPromise(
        registerConnection(home, {
          env,
          connection: "primary",
          uri: env === "readonly" ? uris.reader : uris.writer,
          aliases: [{ name: "shop", database }],
        })
      );
      references.add(catalog.environments[env].connections.primary.secretRef);
    }
    return {
      directory,
      home,
      database,
      cliRoot,
      client,
      Effect,
      secrets,
      references,
      uris,
      cleanup,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch {
      try {
        error.fixtureCleanupFailed = true;
      } catch {
        // Keep the original failure even when it cannot carry the note.
      }
    }
    throw annotate(error);
  }
}
