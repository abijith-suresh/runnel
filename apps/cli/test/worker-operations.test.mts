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
