import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import fs, { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import type { MongoPool } from "@abijith-suresh/runnel-mongodb";
import * as Effect from "effect/Effect";
import { type Catalog, emptyCatalog } from "../dist/catalog.js";
import {
  addDatabase,
  removeConnection,
  removeDatabase,
  renameDatabase,
  rotateConnection,
} from "../dist/management.js";
import { credentialStore } from "../dist/secrets.js";
import { registerConnection } from "../dist/setup.js";
import { workerOperations } from "../dist/worker-operations.js";

type Db = Awaited<ReturnType<MongoPool["database"]>>;
function latch() {
  const { promise: wait, resolve: release } = Promise.withResolvers<void>();
  return { wait, release };
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "runnel-target-snapshot-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const catalog: Catalog = {
    ...emptyCatalog(),
    environments: {
      local: {
        connections: {
          primary: { provider: "mongodb", secretRef: "keyring:runnel/old" },
          other: { provider: "mongodb", secretRef: "keyring:runnel/base" },
        },
        databases: {
          shop: { connection: "primary", database: "old_shop" },
          reporting: { connection: "primary", database: "old_reports" },
          base: { connection: "other", database: "base" },
        },
      },
    },
  };
  await writeFile(join(directory, "catalog.json"), JSON.stringify(catalog));
  const values = new Map([
    ["old", "old-server"],
    ["base", "base-server"],
  ]);
  const reads: string[] = [];
  const store = (read = async (id: string) => values.get(id)) =>
    credentialStore(async (id) => ({
      getPassword: async () => {
        reads.push(id);
        return read(id);
      },
      setPassword: async (value) => {
        values.set(id, value);
      },
      deleteCredential: async () => values.delete(id),
    }));
  const rotate = () =>
    rotateConnection(
      directory,
      { env: "local", connection: "primary" },
      {
        color: false,
        ask: async () => "mongodb://new-server.invalid",
        write() {},
        progress: (_label, action) => action(new AbortController().signal),
      },
      { secrets: store(), inspect: async () => ({ ok: true }) }
    );
  return { directory, values, reads, store, rotate };
}

for (const edit of ["remove and register", "rename and re-add"] as const) {
  test(`an operation pins repeated and newly visited aliases during ${edit}`, async (t) => {
    const f = await fixture(t);
    const started = latch(),
      resume = latch();
    const acquired: string[][] = [];
    const operations = workerOperations(
      f.directory,
      {
        database: async (...args) => {
          acquired.push(args);
          return {
            databaseName: args[2],
            collection: () => ({
              findOne: async () => {
                started.release();
                await resume.wait;
              },
            }),
            listCollections: () => ({ async *[Symbol.asyncIterator]() {}, close: async () => {} }),
          } as unknown as Db;
        },
        close: async () => {},
      },
      f.store()
    );
    const path = join(f.directory, "entry.mjs");
    await writeFile(
      path,
      `export default async ({db,connect}) => {
      await db.collection('barrier').findOne();
      const targets = ['shop', 'reporting', 'added', 'renamed'];
      return Promise.all(targets.map(async alias => {
        try { return (await connect({env:'local',db:alias})).databaseName; }
        catch(error) { return error.code; }
      }));
    };`
    );
    const pending = operations.execute({
      operation: "run",
      env: "local",
      db: "shop",
      path,
      timeoutMs: 5000,
      format: "json",
    });
    try {
      await started.wait;
      if (edit === "remove and register") {
        for (const alias of ["shop", "reporting"])
          assert.equal((await removeDatabase(f.directory, { env: "local", alias })).ok, true);
        assert.equal(
          (await removeConnection(f.directory, { env: "local", connection: "primary" }, f.store()))
            .ok,
          true
        );
        await Effect.runPromise(
          registerConnection(
            f.directory,
            {
              env: "local",
              connection: "primary",
              uri: "mongodb://new-server.invalid",
              aliases: [
                { name: "shop", database: "new_shop" },
                { name: "reporting", database: "new_reports" },
              ],
            },
            f.store()
          )
        );
      } else {
        assert.equal(
          (await renameDatabase(f.directory, { env: "local", alias: "shop", to: "renamed" })).ok,
          true
        );
        assert.equal(
          (
            await addDatabase(f.directory, {
              env: "local",
              alias: "shop",
              connection: "primary",
              database: "new_shop",
            })
          ).ok,
          true
        );
        assert.equal(
          (await renameDatabase(f.directory, { env: "local", alias: "reporting", to: "reports" }))
            .ok,
          true
        );
        assert.equal(
          (
            await addDatabase(f.directory, {
              env: "local",
              alias: "reporting",
              connection: "primary",
              database: "new_reports",
            })
          ).ok,
          true
        );
        assert.equal((await f.rotate()).ok, true);
      }
      assert.equal(
        (
          await addDatabase(f.directory, {
            env: "local",
            alias: "added",
            connection: "primary",
            database: "new_added",
          })
        ).ok,
        true
      );
      resume.release();
      const result = await pending;
      assert(result.ok && "value" in result.data);
      assert.deepEqual(result.data.value, [
        "old_shop",
        "old_reports",
        "DatabaseNotFound",
        "DatabaseNotFound",
      ]);
      assert.deepEqual(
        acquired.map(([, uri, name]) => [uri, name]),
        [
          ["old-server", "old_shop"],
          ["old-server", "old_shop"],
          ["old-server", "old_reports"],
        ]
      );
      const next = await operations.execute({ operation: "list", env: "local", db: "shop" });
      assert.equal(next.ok, true);
      assert.deepEqual(acquired.at(-1)?.slice(1), ["mongodb://new-server.invalid", "new_shop"]);
    } finally {
      resume.release();
      await pending;
      await operations.close();
    }
  });
}

// Keep reads of this test's catalog in promise jobs. A setImmediate barrier can
// then drain name resolution without relying on disk scheduling or timer sleeps.
function synchronousCatalogReads(t: TestContext, directory: string) {
  const open = fs.open;
  t.after(async () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (args[0] !== join(directory, "catalog.json")) return open(...args);
    const bytes = readFileSync(args[0]);
    let position = 0;
    return {
      stat: async () => statSync(args[0]),
      read: async (buffer: Buffer, offset: number, length: number) => {
        const bytesRead = bytes.copy(buffer, offset, position, position + length);
        position += bytesRead;
        return { bytesRead, buffer };
      },
      close: async () => {},
    } as Awaited<ReturnType<typeof fs.open>>;
  });
  syncBuiltinESMExports();
}

test("parallel connects share the actual missing reference and recover together after rotation", async (t) => {
  const f = await fixture(t);
  synchronousCatalogReads(t, f.directory);
  const reading = latch(),
    resumeRead = latch(),
    resumeScript = latch(),
    secondStarted = latch();
  const secrets = f.store(async (id) => {
    if (id === "old") {
      reading.release();
      await resumeRead.wait;
    }
    return f.values.get(id);
  });
  const acquired: string[][] = [];
  const operations = workerOperations(
    f.directory,
    {
      database: async (...args) => {
        acquired.push(args);
        return {
          databaseName: args[2],
          collection: (name: string) => ({
            findOne: async () => {
              if (name === "resume") await resumeScript.wait;
              else secondStarted.release();
            },
          }),
        } as unknown as Db;
      },
      close: async () => {},
    },
    secrets
  );
  const path = join(f.directory, "entry.mjs");
  await writeFile(
    path,
    `export default async ({db,connect}) => {
    const first = connect({env:'local',db:'shop'});
    await db.collection('resume').findOne();
    const second = connect({env:'local',db:'reporting'});
    await db.collection('second-started').findOne();
    return (await Promise.allSettled([first,second])).map(result =>
      result.status === 'fulfilled' ? result.value.databaseName : result.reason.code);
  };`
  );
  const pending = operations.execute({
    operation: "run",
    env: "local",
    db: "base",
    path,
    timeoutMs: 5000,
    format: "json",
  });
  try {
    await reading.wait;
    assert.equal((await f.rotate()).ok, true);
    assert.equal(f.values.has("old"), false);
    resumeScript.release();
    await secondStarted.wait;
    await setImmediate();
    assert.deepEqual(f.reads, ["base", "old"]);
    resumeRead.release();
    const result = await pending;
    assert(result.ok && "value" in result.data);
    assert.deepEqual(result.data.value, ["old_shop", "old_reports"]);
    assert.equal(f.reads.length, 3);
    assert.deepEqual(
      acquired.map(([, uri, name]) => [uri, name]),
      [
        ["base-server", "base"],
        ["mongodb://new-server.invalid", "old_shop"],
        ["mongodb://new-server.invalid", "old_reports"],
      ]
    );
  } finally {
    resumeScript.release();
    resumeRead.release();
    await pending;
    await operations.close();
  }
});

for (const edit of ["remove and register", "rename an unvisited alias"] as const) {
  test(`a credential retry rejects changed connection mappings during ${edit}`, async (t) => {
    const f = await fixture(t);
    const reading = latch(),
      resume = latch();
    const secrets = f.store(async (id) => {
      if (id === "old") {
        reading.release();
        await resume.wait;
      }
      return f.values.get(id);
    });
    let acquired = 0;
    const operations = workerOperations(
      f.directory,
      {
        database: async () => {
          acquired++;
          throw new Error("No handle should be acquired");
        },
        close: async () => {},
      },
      secrets
    );
    const pending = operations.execute({ operation: "list", env: "local", db: "shop" });
    try {
      await reading.wait;
      if (edit === "remove and register") {
        for (const alias of ["shop", "reporting"])
          assert.equal((await removeDatabase(f.directory, { env: "local", alias })).ok, true);
        assert.equal(
          (await removeConnection(f.directory, { env: "local", connection: "primary" }, f.store()))
            .ok,
          true
        );
        await Effect.runPromise(
          registerConnection(
            f.directory,
            {
              env: "local",
              connection: "primary",
              uri: "mongodb://new-server.invalid",
              aliases: [{ name: "shop", database: "new_shop" }],
            },
            f.store()
          )
        );
      } else {
        assert.equal(
          (await renameDatabase(f.directory, { env: "local", alias: "reporting", to: "reports" }))
            .ok,
          true
        );
        assert.equal((await f.rotate()).ok, true);
      }
      resume.release();
      const result = await pending;
      assert(!result.ok);
      assert.equal(result.error.code, "TargetChanged");
      assert.equal(acquired, 0);
      assert.deepEqual(f.reads, ["old"]);
    } finally {
      resume.release();
      await pending;
      await operations.close();
    }
  });
}

test("credential retries stop after three distinct missing references without database work", async (t) => {
  const f = await fixture(t);
  const reading = [latch(), latch(), latch()];
  const resume = [latch(), latch(), latch()];
  const secrets = f.store(async () => {
    const index = f.reads.length - 1;
    assert(index < 3, "credential retries must be bounded");
    reading[index]?.release();
    await resume[index]?.wait;
    return undefined;
  });
  let acquired = 0;
  const operations = workerOperations(
    f.directory,
    {
      database: async () => {
        acquired++;
        throw new Error("No handle should be acquired");
      },
      close: async () => {},
    },
    secrets
  );
  const pending = operations.execute({ operation: "list", env: "local", db: "shop" });
  try {
    for (let index = 0; index < 3; index++) {
      await reading[index]?.wait;
      assert.equal((await f.rotate()).ok, true);
      resume[index]?.release();
    }
    const result = await pending;
    assert(!result.ok);
    assert.equal(result.error.code, "SecretNotFound");
    assert.equal(new Set(f.reads).size, 3);
    assert.equal(acquired, 0);
  } finally {
    for (const barrier of resume) barrier.release();
    await pending;
    await operations.close();
  }
});

for (const change of ["default connection", "URI database"] as const) {
  test(`credential recovery refuses changed ${change} before acquiring any pool`, async (t) => {
    const f = await fixture(t);
    const { updateCatalog } = await import("../dist/catalog-write.js");
    const edit = (changed: boolean) =>
      updateCatalog(f.directory, (catalog) => {
        const env = catalog.environments["local"]!;
        return Effect.succeed({
          ...catalog,
          environments: {
            local: {
              ...env,
              defaultConnection: changed && change === "default connection" ? "other" : "primary",
              connections: {
                ...env.connections,
                primary: {
                  ...env.connections["primary"]!,
                  defaultDatabase:
                    changed && change === "URI database" ? "new_database" : "old_database",
                },
              },
            },
          },
        });
      });
    await Effect.runPromise(edit(false));
    let acquired = 0;
    let reads = 0;
    const operations = workerOperations(
      f.directory,
      {
        database: async () => {
          acquired++;
          throw new Error("Must not acquire");
        },
        close: async () => {},
      },
      f.store(async () => {
        reads++;
        await Effect.runPromise(edit(true));
        return undefined;
      })
    );
    t.after(() => operations.close());
    const result = await operations.execute({ operation: "list", env: "local" });
    assert(!result.ok && result.error.code === "TargetChanged");
    assert.equal(reads, 1);
    assert.equal(acquired, 0);
  });
}

test("scripts pin default and physical selection across a concurrent default change", async (t) => {
  const f = await fixture(t);
  const { updateCatalog } = await import("../dist/catalog-write.js");
  const { defaultConnection } = await import("../dist/management.js");
  await Effect.runPromise(
    updateCatalog(f.directory, (catalog) => {
      const env = catalog.environments["local"]!;
      return Effect.succeed({
        ...catalog,
        environments: {
          local: {
            ...env,
            defaultConnection: "primary",
            connections: {
              primary: { ...env.connections["primary"]!, defaultDatabase: "primary_database" },
              other: { ...env.connections["other"]!, defaultDatabase: "other_database" },
            },
          },
        },
      });
    })
  );
  const started = latch(),
    resume = latch();
  const acquired: string[][] = [];
  const operations = workerOperations(
    f.directory,
    {
      database: async (...args) => {
        acquired.push(args);
        return {
          databaseName: args[2],
          collection: () => ({
            findOne: async () => {
              started.release();
              await resume.wait;
            },
          }),
          listCollections: () => ({ async *[Symbol.asyncIterator]() {}, close: async () => {} }),
        } as unknown as Db;
      },
      close: async () => {},
    },
    f.store()
  );
  t.after(() => operations.close());
  const path = join(f.directory, "default-entry.mjs");
  await writeFile(
    path,
    `export default async ({db,connect}) => {
    await db.collection('barrier').findOne();
    return [(await connect({env:'local'})).databaseName,
      (await connect({env:'local',db:'unregistered'})).databaseName,
      (await connect({env:'local',connection:'other',db:'explicit'})).databaseName];
  };`
  );
  const running = operations.execute({ operation: "run", env: "local", path, timeoutMs: 5000 });
  try {
    await started.wait;
    assert((await defaultConnection(f.directory, { env: "local", connection: "other" })).ok);
  } finally {
    resume.release();
  }
  const result = await running;
  assert(result.ok && "value" in result.data);
  assert.deepEqual(result.data.value, ["primary_database", "unregistered", "explicit"]);
  assert.equal(acquired[1]?.[0], JSON.stringify(["local", "primary"]));
  assert.equal(acquired[2]?.[0], JSON.stringify(["local", "primary"]));
  const next = await operations.execute({ operation: "list", env: "local" });
  assert(next.ok && "db" in next.data && next.data.db === "other_database");
});
