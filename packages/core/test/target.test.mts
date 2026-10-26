import assert from "node:assert/strict";
import test from "node:test";
import * as Result from "effect/Result";
import { type DatabaseAliasesByEnvironment, resolveDatabaseTarget } from "../dist/index.js";

const available: DatabaseAliasesByEnvironment = new Map([
  ["dint", new Set(["accounts"])],
  ["production", new Set(["accounts", "events"])],
  ["empty", new Set<string>()],
]);

test("requires an explicit environment even when there is only one environment", () => {
  assert.deepEqual(
    resolveDatabaseTarget(new Map([["dint", new Set(["accounts"])]]), { db: "accounts" }),
    Result.fail({ _tag: "EnvironmentRequired" })
  );
});

test("rejects an unknown environment without searching other environments", () => {
  assert.deepEqual(
    resolveDatabaseTarget(available, { env: "unknown", db: "accounts" }),
    Result.fail({ _tag: "EnvironmentNotFound", env: "unknown" })
  );
});

test("infers the database when the selected environment has exactly one alias", () => {
  assert.deepEqual(
    resolveDatabaseTarget(available, { env: "dint" }),
    Result.succeed({ env: "dint", db: "accounts" })
  );
});

test("requires the database when the selected environment has multiple aliases", () => {
  assert.deepEqual(
    resolveDatabaseTarget(available, { env: "production" }),
    Result.fail({ _tag: "DatabaseRequired", env: "production" })
  );
});

test("reports an environment with no database aliases", () => {
  assert.deepEqual(
    resolveDatabaseTarget(available, { env: "empty" }),
    Result.fail({ _tag: "NoDatabases", env: "empty" })
  );
});

test("accepts an explicit alias in an environment with multiple aliases", () => {
  assert.deepEqual(
    resolveDatabaseTarget(available, { env: "production", db: "events" }),
    Result.succeed({ env: "production", db: "events" })
  );
});

test("an explicit database never falls back to another alias or environment", () => {
  for (const [env, db] of [
    ["dint", "events"],
    ["production", "unknown"],
    ["empty", "accounts"],
  ] as const) {
    assert.deepEqual(
      resolveDatabaseTarget(available, { env, db }),
      Result.fail({ _tag: "DatabaseNotFound", env, db })
    );
  }
});

test("matches names exactly and does not treat empty values as omitted", () => {
  for (const env of ["", "DINT", " dint "]) {
    assert.deepEqual(
      resolveDatabaseTarget(available, { env }),
      Result.fail({ _tag: "EnvironmentNotFound", env })
    );
  }
  for (const db of ["", "ACCOUNTS", " accounts "]) {
    assert.deepEqual(
      resolveDatabaseTarget(available, { env: "dint", db }),
      Result.fail({ _tag: "DatabaseNotFound", env: "dint", db })
    );
  }
});

// Registration-aware selection preserves the legacy resolver above as a public API.
test("default connections select physical databases while aliases retain precedence", async () => {
  const { resolveConnectionTarget } = await import("../dist/index.js");
  const available = new Map([
    [
      "local",
      {
        defaultConnection: "primary",
        connections: new Map([
          ["primary", { defaultDatabase: "uri_database" }],
          ["other", { defaultDatabase: "other_database" }],
        ]),
        databases: new Map([["accounts", { connection: "other", database: "physical_accounts" }]]),
      },
    ],
  ]);
  for (const [requested, expected] of [
    [
      { env: "local" },
      { env: "local", db: "uri_database", connection: "primary", database: "uri_database" },
    ],
    [
      { env: "local", db: "new_database" },
      { env: "local", db: "new_database", connection: "primary", database: "new_database" },
    ],
    [
      { env: "local", db: "accounts" },
      { env: "local", db: "accounts", connection: "other", database: "physical_accounts" },
    ],
    [
      { env: "local", db: "accounts", connection: "primary" },
      { env: "local", db: "accounts", connection: "primary", database: "accounts" },
    ],
    [
      { env: "local", connection: "other" },
      { env: "local", db: "other_database", connection: "other", database: "other_database" },
    ],
  ] as const) {
    assert.deepEqual(resolveConnectionTarget(available, requested), Result.succeed(expected));
  }
});

test("legacy alias inference stays intact and physical selection never guesses a connection", async () => {
  const { resolveConnectionTarget } = await import("../dist/index.js");
  const available = new Map([
    [
      "local",
      {
        connections: new Map([
          ["primary", {}],
          ["other", {}],
        ]),
        databases: new Map([
          ["accounts", { connection: "primary", database: "physical_accounts" }],
        ]),
      },
    ],
  ]);
  assert.deepEqual(
    resolveConnectionTarget(available, { env: "local" }),
    Result.succeed({
      env: "local",
      db: "accounts",
      connection: "primary",
      database: "physical_accounts",
    })
  );
  assert.deepEqual(
    resolveConnectionTarget(available, { env: "local", db: "unregistered" }),
    Result.fail({ _tag: "DatabaseNotFound", env: "local", db: "unregistered" })
  );
  assert.deepEqual(
    resolveConnectionTarget(available, { env: "local", connection: "primary" }),
    Result.fail({ _tag: "DatabaseRequired", env: "local" })
  );
  assert.deepEqual(
    resolveConnectionTarget(available, { env: "local", connection: "missing", db: "accounts" }),
    Result.fail({ _tag: "ConnectionNotFound", env: "local" })
  );
  assert.deepEqual(
    resolveConnectionTarget(available, { db: "accounts" }),
    Result.fail({ _tag: "EnvironmentRequired" })
  );
});
