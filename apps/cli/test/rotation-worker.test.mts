import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMongoPool, type MongoPool } from "@abijith-suresh/runnel-mongodb";
import { emptyCatalog } from "../dist/catalog.js";
import { rotateConnection } from "../dist/management.js";
import { credentialStore } from "../dist/secrets.js";
import { workerOperations } from "../dist/worker-operations.js";

type Db = Awaited<ReturnType<MongoPool["database"]>>;
function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "runnel-rotation-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "catalog.json"),
    JSON.stringify({
      ...emptyCatalog(),
      environments: {
        local: {
          connections: { primary: { provider: "mongodb", secretRef: "keyring:runnel/old" } },
          databases: { shop: { connection: "primary", database: "physical_shop" } },
        },
      },
    })
  );
  const values = new Map([["old", "old-uri"]]);
  const secrets = (
    read: (identifier: string) => Promise<string | undefined> = async (id) => values.get(id)
  ) =>
    credentialStore(async (identifier) => ({
      getPassword: () => read(identifier),
      setPassword: async (value) => {
        values.set(identifier, value);
      },
      deleteCredential: async () => values.delete(identifier),
    }));
  const rotate = (store: ReturnType<typeof credentialStore>) =>
    rotateConnection(
      directory,
      { env: "local", connection: "primary" },
      {
        color: false,
        ask: async () => "new-uri",
        write() {},
        progress: (_label, action) => action(new AbortController().signal),
      },
      { secrets: store, inspect: async () => ({ ok: true }) }
    );
  return { directory, values, secrets, rotate };
}

test("a catalog reference retired during credential read resolves the current reference before execution", async (t) => {
  const f = await fixture(t);
  const reading = latch(),
    resume = latch();
  const secrets = f.secrets(async (identifier) => {
    if (identifier === "old") {
      reading.release();
      await resume.wait;
    }
    return f.values.get(identifier);
  });
  const acquired: string[] = [];
  const operations = workerOperations(
    f.directory,
    {
      database: async (_key, uri) => {
        acquired.push(uri);
        return {
          listCollections: () => ({
            async *[Symbol.asyncIterator]() {
              yield { name: "items" };
            },
            close: async () => {},
          }),
        } as unknown as Db;
      },
      close: async () => {},
    },
    secrets
  );
  const pending = operations.execute({ operation: "list", env: "local" });
  try {
    await reading.wait;
    assert.equal((await f.rotate(secrets)).ok, true);
    assert.equal(f.values.has("old"), false);
    resume.release();
    assert.equal((await pending).ok, true);
    assert.deepEqual(acquired, ["new-uri"]);
  } finally {
    resume.release();
    await pending;
    await operations.close();
  }
});

test("an active script pins its credentials while future operations refresh the pooled client", async (t) => {
  const f = await fixture(t);
  const reading = latch(),
    resume = latch();
  const clients: Array<{ uri: string; closed: boolean }> = [];
  let reads = 0;
  const pool = createMongoPool((uri) => {
    const client = { uri, closed: false };
    clients.push(client);
    return {
      db: () =>
        ({
          collection: () => ({
            aggregate: () => ({
              next: async () => ({ count: uri === "old-uri" ? 1 : 2 }),
              close: async () => {},
            }),
            countDocuments: async () => {
              if (client.closed) throw new Error("Original database handle was closed");
              if (++reads === 1) {
                reading.release();
                await resume.wait;
              }
              return uri === "old-uri" ? 1 : 2;
            },
          }),
        }) as unknown as Db,
      close: async () => {
        client.closed = true;
      },
    };
  });
  const operations = workerOperations(f.directory, pool, f.secrets());
  const path = join(f.directory, "connect.mjs");
  await writeFile(
    path,
    `export default async ({db,connect}) => {
    const before = await db.collection('items').countDocuments();
    const again = await connect({env:'local'});
    return {before, other:await again.collection('items').countDocuments(), after:await db.collection('items').countDocuments()};
  };`
  );
  const pending = operations.execute({
    operation: "run",
    env: "local",
    path,
    timeoutMs: 5000,
    format: "json",
  });
  try {
    await reading.wait;
    assert.equal((await f.rotate(f.secrets())).ok, true);
    resume.release();
    const result = await pending;
    assert(result.ok && "value" in result.data);
    assert.deepEqual(result.data.value, { before: 1, other: 1, after: 1 });
    assert.equal(clients.length, 1);
    assert.equal(clients[0]?.closed, false);
    const next = await operations.execute({
      operation: "count",
      env: "local",
      collection: "items",
    });
    assert(next.ok && "count" in next.data);
    assert.equal(next.data.count, 2);
    assert.equal(clients.length, 2);
    assert.equal(clients[0]?.closed, true);
    assert.equal(clients[1]?.uri, "new-uri");
  } finally {
    resume.release();
    await pending;
    await operations.close();
  }
});
