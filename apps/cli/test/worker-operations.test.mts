import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MongoPool } from "@abijith-suresh/runnel-mongodb";
import * as Effect from "effect/Effect";
import { emptyCatalog } from "../dist/catalog.js";
import { credentialStore } from "../dist/secrets.js";
import { workerOperations } from "../dist/worker-operations.js";

type Db = Awaited<ReturnType<MongoPool["database"]>>;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "runnel-worker-op-"));
  const catalog = {
    ...emptyCatalog(),
    environments: {
      local: {
        connections: { primary: { provider: "mongodb", secretRef: "keyring:runnel/synthetic" } },
        databases: { accounts: { connection: "primary", database: "physical_accounts" } },
      },
    },
  };
  await writeFile(join(directory, "catalog.json"), JSON.stringify(catalog));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
test("worker resolves names, reads the secret, uses the physical mapping and bounds collection results", async () => {
  const { directory, cleanup } = await fixture();
  let reads = 0;
  let closed = 0;
  let visited = 0;
  const acquired: string[][] = [];
  const pool: MongoPool = {
    async database(...args) {
      acquired.push(args);
      return {
        listCollections: () => ({
          async *[Symbol.asyncIterator]() {
            for (let index = 0; index < 1100; index++) {
              visited++;
              yield { name: `c${index}`, type: "collection" };
            }
          },
          close: async () => {
            closed++;
          },
        }),
      } as unknown as Db;
    },
    close: async () => {},
  };
  const secrets = credentialStore(async () => ({
    getPassword: async () => {
      reads++;
      return "synthetic-uri";
    },
    setPassword: async () => {},
    deleteCredential: async () => false,
  }));
  const operations = workerOperations(directory, pool, secrets);
  try {
    const result = await operations.execute({ operation: "list", env: "local" });
    assert(result.ok && "collections" in result.data);
    assert.equal(result.data.env, "local");
    assert.equal(result.data.db, "accounts");
    assert.equal(result.data.collections.length, 1000);
    assert.equal(result.data.truncated, true);
    assert.equal(visited, 1001);
    assert.equal(closed, 1);
    assert.equal(reads, 1);
    assert.deepEqual(acquired, [
      [JSON.stringify(["local", "primary"]), "synthetic-uri", "physical_accounts"],
    ]);
    assert(!JSON.stringify(result).includes("synthetic-uri"));
    assert(!JSON.stringify(result).includes("keyring:"));
    const unknown = await operations.execute({ operation: "list", env: "local", db: "other" });
    assert(!unknown.ok);
    assert.equal(unknown.error.code, "DatabaseNotFound");
    assert.equal(reads, 1);
    assert.equal(acquired.length, 1);
  } finally {
    await operations.close();
    await cleanup();
  }
});
test("missing credentials fail before MongoDB pool acquisition", async () => {
  const { directory, cleanup } = await fixture();
  let acquired = false;
  const operations = workerOperations(
    directory,
    {
      database: async () => {
        acquired = true;
        throw new Error("must not be called");
      },
      close: async () => {},
    },
    credentialStore(async () => ({
      getPassword: async () => undefined,
      setPassword: async () => {},
      deleteCredential: async () => false,
    }))
  );
  try {
    const result = await operations.execute({ operation: "list", env: "local" });
    assert(!result.ok);
    assert.equal(result.error.code, "SecretNotFound");
    assert.equal(acquired, false);
  } finally {
    await operations.close();
    await cleanup();
  }
});
test("cursor errors still close the cursor and never expose returned document contents", async () => {
  const { directory, cleanup } = await fixture();
  let closed = false;
  const operations = workerOperations(
    directory,
    {
      database: async () =>
        ({
          listCollections: () => ({
            async *[Symbol.asyncIterator]() {
              yield { name: "before" };
              throw { code: 13, message: "synthetic-secret and document" };
            },
            close: async () => {
              closed = true;
            },
          }),
        }) as unknown as Db,
      close: async () => {},
    },
    { ...credentialStore(), read: () => Effect.succeed("synthetic-uri") }
  );
  try {
    const result = await operations.execute({ operation: "list", env: "local" });
    assert(!result.ok);
    assert.equal(result.error.code, "PermissionDenied");
    assert.equal(closed, true);
    assert(!JSON.stringify(result).includes("synthetic-secret"));
  } finally {
    await operations.close();
    await cleanup();
  }
});

test("a default connection accepts physical databases and rejects invalid names before vault/pool access", async (t) => {
  const { directory, cleanup } = await fixture();
  t.after(cleanup);
  const { updateCatalog } = await import("../dist/catalog-write.js");
  await Effect.runPromise(
    updateCatalog(directory, (catalog) => {
      const env = catalog.environments["local"]!;
      return Effect.succeed({
        ...catalog,
        environments: {
          local: {
            ...env,
            defaultConnection: "primary",
            connections: {
              primary: { ...env.connections["primary"]!, defaultDatabase: "uri_default" },
            },
          },
        },
      });
    })
  );
  const acquired: string[][] = [];
  let reads = 0;
  const operations = workerOperations(
    directory,
    {
      database: async (...args) => {
        acquired.push(args);
        return {
          listCollections: () => ({ async *[Symbol.asyncIterator]() {}, close: async () => {} }),
        } as unknown as Db;
      },
      close: async () => {},
    },
    {
      ...credentialStore(),
      read: () => {
        reads++;
        return Effect.succeed("synthetic-uri");
      },
    }
  );
  t.after(() => operations.close());
  for (const [target, db, physical] of [
    [{}, "uri_default", "uri_default"],
    [{ db: "unregistered" }, "unregistered", "unregistered"],
    [{ db: "accounts" }, "accounts", "physical_accounts"],
    [{ db: "accounts", connection: "primary" }, "accounts", "accounts"],
    [{ db: "東京" }, "東京", "東京"],
  ] as const) {
    const result = await operations.execute({ operation: "list", env: "local", ...target });
    assert(result.ok && "db" in result.data && result.data.db === db);
    assert.equal(acquired.at(-1)?.[2], physical);
    assert.equal(acquired.at(-1)?.[0], JSON.stringify(["local", "primary"]));
  }
  const before = reads;
  for (const db of ["bad.name", "bad name", "x".repeat(64), "mongodb://private-value.invalid"]) {
    const result = await operations.execute({ operation: "list", env: "local", db });
    assert(!result.ok && result.error.code === "InputInvalid");
    assert.doesNotMatch(JSON.stringify(result), /private-value/);
  }
  assert.equal(reads, before);
});

test("missing credentials recover by rotating the existing connection, preserving aliases and defaults", async (t) => {
  const { registerConnection } = await import("../dist/setup.js");
  const { rotateConnection } = await import("../dist/management.js");
  const { readCatalog } = await import("../dist/catalog.js");
  const directory = await mkdtemp(join(tmpdir(), "runnel-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const values = new Map<string, string>();
  const secrets = credentialStore(async (id) => ({
    getPassword: async () => values.get(id),
    setPassword: async (value) => {
      values.set(id, value);
    },
    deleteCredential: async () => values.delete(id),
  }));
  await Effect.runPromise(
    registerConnection(
      directory,
      {
        env: "local",
        connection: "primary",
        uri: "mongodb://old.invalid/accounts?authSource=admin",
        makeDefault: true,
        aliases: [{ name: "reporting", database: "reports" }],
      },
      secrets
    )
  );
  const before = await Effect.runPromise(readCatalog(directory));
  values.clear();
  let calls = 0;
  const operations = workerOperations(
    directory,
    {
      database: async (_key, uri, database) => {
        calls++;
        assert.equal(uri, "mongodb://replacement.invalid/accounts?authSource=auth");
        assert.equal(database, "accounts");
        return {
          listCollections: () => ({ async *[Symbol.asyncIterator]() {}, close: async () => {} }),
        } as unknown as Db;
      },
      close: async () => {},
    },
    secrets
  );
  t.after(() => operations.close());
  const missing = await operations.execute({ operation: "list", env: "local" });
  assert(!missing.ok && missing.error.code === "SecretNotFound");
  assert.match(missing.error.message, /connection rotate NAME -e ENV/);
  assert.doesNotMatch(missing.error.message, /setup again/);
  assert.equal(calls, 0);
  const result = await rotateConnection(
    directory,
    { env: "local", connection: "primary" },
    {
      color: false,
      ask: async (_label, options) => {
        assert.equal(options?.hidden, true);
        return "mongodb://replacement.invalid/accounts?authSource=auth";
      },
      write() {},
      progress: (_label, action) => action(new AbortController().signal),
    },
    { secrets, inspect: async () => ({ ok: true }) }
  );
  assert(result.ok);
  const after = await Effect.runPromise(readCatalog(directory));
  assert.equal(after.environments["local"]?.defaultConnection, "primary");
  assert.deepEqual(after.environments["local"]?.databases, before.environments["local"]?.databases);
  assert.deepEqual(after.settings, before.settings);
  assert.notEqual(
    after.environments["local"]?.connections["primary"]?.secretRef,
    before.environments["local"]?.connections["primary"]?.secretRef
  );
  assert((await operations.execute({ operation: "list", env: "local" })).ok);
  assert.equal(calls, 1);
});

test("explicit connection testing uses a bounded isolated ping and never lists databases", async (t) => {
  const { directory, cleanup } = await fixture();
  t.after(cleanup);
  let closed = 0;
  let pings = 0;
  const operations = workerOperations(
    directory,
    {
      database: async () => {
        throw new Error("Registered pools must stay untouched");
      },
      close: async () => {},
    },
    {
      ...credentialStore(),
      read: () => {
        throw new Error("Must not read stored credentials");
      },
    },
    () => ({
      database: async (key, uri, database) => {
        assert.equal(key, "setup");
        assert.equal(uri, "mongodb://synthetic.invalid");
        assert.equal(database, "admin");
        return {
          command: async (command: unknown, options: unknown) => {
            pings++;
            assert.deepEqual(command, { ping: 1 });
            assert.deepEqual(options, { timeoutMS: 10000 });
          },
          admin: () => {
            throw new Error("Must not enumerate");
          },
        } as unknown as Db;
      },
      close: async () => {
        closed++;
      },
    })
  );
  t.after(() => operations.close());
  assert.deepEqual(
    await operations.execute({
      operation: "inspect",
      uri: "mongodb://synthetic.invalid",
      testOnly: true,
    }),
    { ok: true, data: { databases: [], truncated: false } }
  );
  assert.equal(pings, 1);
  assert.equal(closed, 1);
});

test("registered connection tests and discovery use named worker targets without aliases or replay", async (t) => {
  const { directory, cleanup } = await fixture();
  t.after(cleanup);
  const { updateCatalog } = await import("../dist/catalog-write.js");
  await Effect.runPromise(
    updateCatalog(directory, (catalog) =>
      Effect.succeed({
        ...catalog,
        environments: { local: { ...catalog.environments["local"]!, databases: {} } },
      })
    )
  );
  let pings = 0,
    enumerations = 0,
    reads = 0,
    denied = false;
  const acquired: string[][] = [];
  const operations = workerOperations(
    directory,
    {
      database: async (...args) => {
        acquired.push(args);
        return {
          command: async (command: unknown, options: unknown) => {
            pings++;
            assert.deepEqual(command, { ping: 1 });
            assert.deepEqual(options, { timeoutMS: 10000 });
          },
          admin: () => ({
            listDatabases: async (options: unknown) => {
              enumerations++;
              assert.deepEqual(options, {
                nameOnly: true,
                authorizedDatabases: true,
                timeoutMS: 10000,
              });
              if (denied) throw { code: 13, message: "private-uri-and-driver-message" };
              return { databases: Array.from({ length: 1001 }, (_, i) => ({ name: `db_${i}` })) };
            },
          }),
        } as unknown as Db;
      },
      close: async () => {},
    },
    {
      ...credentialStore(),
      read: () => {
        reads++;
        return Effect.succeed("synthetic-private-uri");
      },
    },
    () => {
      throw new Error("Registered operations must use their connection pool");
    }
  );
  t.after(() => operations.close());
  const target = { operation: "inspectConnection" as const, env: "local", connection: "primary" };
  assert.deepEqual(await operations.execute({ ...target, testOnly: true }), {
    ok: true,
    data: { databases: [], truncated: false },
  });
  assert.equal(enumerations, 0);
  const listed = await operations.execute(target);
  assert(listed.ok && "databases" in listed.data);
  assert.equal(listed.data.databases.length, 1000);
  assert.equal(listed.data.truncated, true);
  assert.doesNotMatch(JSON.stringify(listed), /synthetic-private-uri|keyring|secretRef/);
  denied = true;
  const refusal = await operations.execute(target);
  assert(!refusal.ok && refusal.error.code === "PermissionDenied");
  assert.doesNotMatch(JSON.stringify(refusal), /private-uri|driver-message/);
  assert((await operations.execute({ ...target, testOnly: true })).ok);
  assert.equal(pings, 2);
  assert.equal(enumerations, 2);
  assert.equal(reads, 4);
  assert(
    acquired.every(
      (args) => args[0] === JSON.stringify(["local", "primary"]) && args[2] === "admin"
    )
  );
});
