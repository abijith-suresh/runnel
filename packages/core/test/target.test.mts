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
