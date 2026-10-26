import assert from "node:assert/strict";
import test from "node:test";
import type { Db } from "mongodb";
import { createMongoPool } from "../dist/index.js";

function fixture() {
  const clients: Array<{
    names: string[];
    closed: boolean;
  }> = [];
  const pool = createMongoPool(() => {
    const item = { names: [] as string[], closed: false };
    clients.push(item);
    return {
      db: (name) => {
        item.names.push(name ?? "");
        return { databaseName: name } as Db;
      },
      close: async () => {
        item.closed = true;
      },
    };
  });
  return { pool, clients };
}
test("database aliases share a connection client; independently registered URIs do not", async () => {
  const { pool, clients } = fixture();
  try {
    const first = await pool.database("env/primary", "synthetic-uri", "accounts");
    const second = await pool.database("env/primary", "synthetic-uri", "analytics");
    assert.equal(first.databaseName, "accounts");
    assert.equal(second.databaseName, "analytics");
    assert.equal(clients.length, 1);
    await pool.database("other/primary", "synthetic-uri", "accounts");
    assert.equal(clients.length, 2);
    assert.deepEqual(clients[0]?.names, ["accounts", "analytics"]);
  } finally {
    await pool.close();
  }
  assert(clients.every((client) => client.closed));
});
test("parallel connects share creation and shutdown rejects later acquisition", async () => {
  const { pool, clients } = fixture();
  await Promise.all(
    Array.from({ length: 2 }, (_, index) => pool.database("same", "synthetic", String(index)))
  );
  assert.equal(clients.length, 1);
  const beforeShutdown = pool.database("same", "synthetic", "last");
  const closed = pool.close();
  const afterShutdown = pool.database("same", "synthetic", "late");
  await beforeShutdown;
  await closed;
  await assert.rejects(afterShutdown, /closed/);
  await pool.close();
});
test("close attempts every client even if one close fails", async () => {
  let closed = 0;
  const pool = createMongoPool(() => ({
    db: (name) => ({ databaseName: name }) as Db,
    close: async () => {
      closed++;
      if (closed === 1) throw new Error("synthetic-secret");
    },
  }));
  await pool.database("one", "uri", "db");
  await pool.database("two", "uri", "db");
  await assert.rejects(pool.close(), { message: "Cannot close all MongoDB clients." });
  assert.equal(closed, 2);
  await assert.rejects(pool.database("three", "uri", "db"), /closed/);
  await pool.close();
  assert.equal(closed, 3);
  await pool.close();
  assert.equal(closed, 3);
});
test("failed replacement retains the old client for a later shutdown attempt", async () => {
  let created = 0;
  let closed = 0;
  const pool = createMongoPool(() => {
    created++;
    return {
      db: (name) => ({ databaseName: name }) as Db,
      close: async () => {
        if (++closed === 1) throw new Error("synthetic close failure");
      },
    };
  });
  await pool.database("key", "old-uri", "db");
  await assert.rejects(pool.database("key", "new-uri", "db"), /synthetic close failure/);
  assert.equal(created, 1);
  await pool.close();
  assert.equal(closed, 2);
  assert.equal(created, 1);
});
test("retrying a failed replacement closes the old client before creating its successor", async () => {
  const clients: Array<{ closed: number }> = [];
  const pool = createMongoPool(() => {
    const current = { closed: 0 };
    clients.push(current);
    return {
      db: (name) => ({ databaseName: name }) as Db,
      close: async () => {
        current.closed++;
        if (clients[0] === current && current.closed === 1)
          throw new Error("synthetic close failure");
      },
    };
  });
  await pool.database("key", "old-uri", "db");
  await assert.rejects(pool.database("key", "new-uri", "db"), /synthetic close failure/);
  await pool.database("key", "new-uri", "db");
  assert.equal(clients.length, 2);
  assert.equal(clients[0]?.closed, 2);
  await pool.close();
  assert.equal(clients[1]?.closed, 1);
});
test("client creation failure does not poison subsequent pool acquisition", async () => {
  let attempts = 0;
  const pool = createMongoPool(() => {
    if (++attempts === 1) throw new Error("synthetic failure");
    return { db: (name) => ({ databaseName: name }) as Db, close: async () => {} };
  });
  await assert.rejects(pool.database("key", "uri", "db"), /synthetic failure/);
  assert.equal((await pool.database("key", "uri", "db")).databaseName, "db");
  await pool.close();
});

test("offline URI parsing distinguishes its default database from authSource", async () => {
  const { mongoConnectionDatabase } = await import("../dist/index.js");
  for (const [uri, database] of [
    ["mongodb://user:synthetic@host.invalid/accounts?authSource=admin", "accounts"],
    ["mongodb://host.invalid/?authSource=admin", undefined],
    ["mongodb+srv://cluster.invalid/reports?authSource=auth", "reports"],
    ["mongodb://host.invalid/%E6%9D%B1%E4%BA%AC", "東京"],
    ["mongodb://[::1]:27017/accounts", "accounts"],
    ["mongodb://host.invalid:65535,other.invalid:27017/accounts", "accounts"],
    ["mongodb://%2Ftmp%2Frunnel-fixture.sock/accounts", "accounts"],
  ] as const)
    assert.equal(mongoConnectionDatabase(uri), database);
  for (const uri of [
    "https://host.invalid",
    "mongodb://",
    "mongodb://host.invalid/%ZZ",
    "mongodb://u:synthetic%ZZ@host.invalid",
    "mongodb://host.invalid:bogus/accounts",
    "mongodb://host.invalid:99999/accounts",
    "mongodb://host.invalid:0/accounts",
    "mongodb://[not-an-ip]:27017/accounts",
    "mongodb://host.invalid,,other.invalid/accounts",
  ]) {
    assert.throws(
      () => mongoConnectionDatabase(uri),
      (error: unknown) =>
        error instanceof Error && error.message === "The MongoDB connection string is invalid."
    );
  }
});
