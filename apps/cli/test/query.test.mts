import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { MongoPool } from "@abijith-suresh/runnel-mongodb";
import * as Effect from "effect/Effect";
import { BSON, MongoOperationTimeoutError } from "mongodb";
import { emptyCatalog } from "../dist/catalog.js";
import {
  executeQuery,
  prepareQuery,
  type QueryOperation,
  queryResultBytes,
} from "../dist/mongodb-query.js";
import { buildQueryRequest } from "../dist/query-command.js";
import {
  inputLimitBytes,
  parsePipeline,
  parseQueryObject,
  QueryError,
  readQueryInput,
} from "../dist/query-input.js";
import { credentialStore } from "../dist/secrets.js";
import { databaseFailure, workerOperations } from "../dist/worker-operations.js";
import { decodeOperation, decodeResponse } from "../dist/worker-protocol.js";

type Db = Awaited<ReturnType<MongoPool["database"]>>;
const executable = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const cursor = (items: unknown[], state: { visited: number; closed: number }, error?: unknown) => ({
  async next() {
    state.visited++;
    if (error) throw error;
    return items[0] ?? null;
  },
  async *[Symbol.asyncIterator]() {
    for (const item of items) {
      state.visited++;
      yield item;
    }
    if (error) throw error;
  },
  async close() {
    state.closed++;
  },
});
const query = (operation: QueryOperation["operation"], rest: Record<string, unknown> = {}) =>
  decodeOperation({ operation, collection: "users", env: "local", ...rest }) as QueryOperation;
const runQuery = (handle: Db, request: QueryOperation) =>
  executeQuery(handle, request, "local", "accounts", prepareQuery(request));

test("JSON/EJSON inputs preserve BSON wrappers and reject invalid shapes, unsafe literals, and oversize", () => {
  const filter = parseQueryObject(
    '{"_id":{"$oid":"000000000000000000000001"},"n":{"$numberLong":"9007199254740993"}}'
  );
  assert(filter["_id"] instanceof BSON.ObjectId);
  assert(filter["n"] instanceof BSON.Long);
  assert.equal(filter["n"].toString(), "9007199254740993");
  assert.equal(parsePipeline('[{"$match":{"active":true}}]').length, 1);
  assert.deepEqual(parsePipeline("[]"), []);
  for (const input of [
    "[]",
    "null",
    "42",
    "{",
    '{"x":9007199254740993}',
    '{"x":1e999}',
    '{"$oid":"000000000000000000000001"}',
  ])
    assert.throws(() => parseQueryObject(input), QueryError);
  for (const input of ["{}", "[null]", '[{"name":"users"}]', '[{"$match":{},"$limit":1}]'])
    assert.throws(() => parsePipeline(input), QueryError);
  assert.throws(
    () => parseQueryObject(" ".repeat(inputLimitBytes + 1)),
    (error: unknown) => error instanceof QueryError && error.code === "InputTooLarge"
  );
});

test("file and stdin input reads are bounded, UTF-8 and regular-file only", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-query-input-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "filter.json");
  writeFileSync(file, '{"active":true}');
  assert.equal(await readQueryInput(file), '{"active":true}');
  assert.equal(
    await readQueryInput("-", Readable.from(['{"active":', "true}"])),
    '{"active":true}'
  );
  writeFileSync(file, Buffer.alloc(inputLimitBytes + 1, 32));
  await assert.rejects(readQueryInput(file), QueryError);
  await assert.rejects(
    readQueryInput("-", Readable.from([Buffer.alloc(inputLimitBytes + 1)])),
    QueryError
  );
  writeFileSync(file, Buffer.from([0xff]));
  await assert.rejects(readQueryInput(file), QueryError);
  await assert.rejects(readQueryInput(directory), QueryError);
  await assert.rejects(readQueryInput(join(directory, "missing")), QueryError);
  if (process.platform !== "win32") {
    const fifo = join(directory, "fifo");
    execFileSync("mkfifo", [fifo]);
    await assert.rejects(readQueryInput(fifo), QueryError);
  }
});

test("unreadable query inputs identify the option without exposing filenames or contents", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-input-diagnostic-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "private-input-name.json");
  for (const option of ["filter-file", "projection-file", "sort-file", "pipeline-file"] as const) {
    await assert.rejects(
      buildQueryRequest(option === "pipeline-file" ? "aggregate" : "find", "users", {
        env: "local",
        [option]: file,
      }),
      (error: unknown) =>
        error instanceof QueryError &&
        error.code === "InputUnavailable" &&
        error.message.includes(`--${option}`) &&
        !error.message.includes("private-input-name")
    );
  }
  writeFileSync(file, Buffer.from([0xff]));
  await assert.rejects(
    buildQueryRequest("find", "users", { env: "local", "filter-file": file }),
    (error: unknown) =>
      error instanceof QueryError &&
      error.code === "InputUnavailable" &&
      error.message.includes("--filter-file") &&
      !error.message.includes("private-input-name")
  );
});

test("numeric EJSON wrappers reject overflow, malformed strings, and conflicting fields before query execution", async () => {
  for (const wrapper of [
    { $numberLong: "9223372036854775808" },
    { $numberLong: "-9223372036854775809" },
    { $numberLong: "1.5" },
    { $numberLong: "junk" },
    { $numberInt: "2147483648" },
    { $numberInt: "-2147483649" },
    { $numberInt: "1.5" },
    { $numberInt: "" },
    { $numberDouble: "junk" },
    { $numberDouble: "1.5junk" },
    { $numberDouble: "1e999" },
    { $numberDouble: " 1.5" },
    { $numberDouble: "" },
    { $numberDecimal: "junk" },
    { $numberDecimal: "1e9999" },
    { $numberInt: null },
    { $numberDouble: 1.5 },
    { $numberLong: "5", extra: true },
    { $numberLong: "5", $numberInt: "5" },
  ]) {
    const input = JSON.stringify({ nested: [{ n: wrapper }] });
    assert.throws(
      () => parseQueryObject(input),
      (error: unknown) => error instanceof QueryError && error.code === "InputInvalid"
    );
    assert.throws(() => parsePipeline(JSON.stringify([{ $match: { n: wrapper } }])), QueryError);
    await assert.rejects(buildQueryRequest("find", "users", { filter: input }), QueryError);
  }
  for (const [key, text] of [
    ["$numberLong", "-9223372036854775808"],
    ["$numberLong", "9223372036854775807"],
    ["$numberInt", "-2147483648"],
    ["$numberInt", "2147483647"],
    ["$numberDouble", "1.25e2"],
    ["$numberDouble", "-0.0"],
    ["$numberDouble", "NaN"],
    ["$numberDouble", "Infinity"],
    ["$numberDouble", "-Infinity"],
    ["$numberDecimal", "1.25"],
  ] as const) {
    const parsed = parseQueryObject(JSON.stringify({ n: { [key]: text } }));
    assert.deepEqual(
      parsed["n"],
      BSON.EJSON.parse(JSON.stringify({ [key]: text }), { relaxed: false })
    );
  }
});

test("query request preparation validates options and reads one selected JSON source", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-query-command-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, "filter.json");
  writeFileSync(file, '{"active":true}');
  const result = await buildQueryRequest("find", "users", {
    env: "local",
    "filter-file": file,
    sort: '{"tier":-1}',
    projection: '{"_id":0}',
    limit: "2",
    skip: "1",
    format: "json",
  });
  assert.equal(result.operation, "find");
  assert.equal(result.env, "local");
  const prepared = prepareQuery(result);
  assert.deepEqual(prepared.sort, { tier: -1 });
  for (const values of [
    { filter: "{}", "filter-file": file },
    { "filter-file": "-", "sort-file": "-" },
    { filter: "[]" },
    { projection: "[]" },
    { sort: '{"x":0}' },
    { limit: "0" },
    { limit: "1001" },
    { limit: "1e2" },
    { skip: "-1" },
    { skip: "2147483648" },
    { format: "text" },
  ])
    await assert.rejects(buildQueryRequest("find", "users", values), QueryError);
  await assert.rejects(buildQueryRequest("aggregate", "users", {}), QueryError);
  await assert.rejects(buildQueryRequest("describe", "", {}), QueryError);
});

test("JSON regex predicates, siblings, DBRef records, and pipeline stages survive EJSON conversion", async () => {
  const input = {
    name: { $regex: "^a", $options: "i", $ne: "abc", $nin: ["ax"] },
    typed: { $regex: { $regularExpression: { pattern: "^b", options: "i" } }, $exists: true },
    incomplete: { $ref: "users" },
    ref: {
      $ref: "users",
      $id: { $oid: "000000000000000000000001" },
      extra: { $numberLong: "9007199254740993" },
    },
    code: { $code: "return query", $scope: { query: { $regex: "a", $ne: "abc" } } },
  };
  for (const parsed of [
    parseQueryObject(JSON.stringify(input)),
    parsePipeline(JSON.stringify([{ $match: input }]))[0]?.["$match"],
    prepareQuery(await buildQueryRequest("find", "users", { filter: JSON.stringify(input) }))
      .filter,
  ]) {
    const document = parsed as Record<string, unknown>;
    assert.deepEqual(document["name"], input.name);
    assert.deepEqual(document["incomplete"], input.incomplete);
    assert.deepEqual(document["typed"], { $regex: new BSON.BSONRegExp("^b", "i"), $exists: true });
    const ref = document["ref"] as Record<string, unknown>;
    assert(ref["$id"] instanceof BSON.ObjectId);
    assert(ref["extra"] instanceof BSON.Long);
    assert.equal(ref["extra"].toString(), "9007199254740993");
    const code = document["code"];
    assert(code instanceof BSON.Code);
    assert.deepEqual(code.scope?.["query"], input.code.$scope.query);
    const wire = BSON.deserialize(BSON.serialize(document), { promoteValues: false });
    assert.deepEqual(wire["name"], input.name);
    assert.equal(wire["typed"].$exists, true);
  }
});

test("known EJSON wrapper shapes and values reject silent driver coercion before credential access", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-ejson-validation-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let reads = 0;
  const operations = workerOperations(
    directory,
    {
      database: async () => {
        throw new Error("unexpected pool access");
      },
      close: async () => {},
    },
    {
      ...credentialStore(),
      read: () => {
        reads++;
        return Effect.succeed("synthetic-secret");
      },
    }
  );
  for (const wrapper of [
    { $date: "not-a-date" },
    { $date: "2025-02-30T00:00:00Z" },
    { $date: { $numberLong: "9223372036854775807" } },
    { $date: { $numberLong: "-8640000000000001" } },
    { $date: null },
    { $binary: { base64: "!!!!", subType: "00" } },
    { $binary: { base64: "AQ", subType: "00" } },
    { $binary: { base64: "AQ==", subType: "zz" } },
    { $binary: { base64: "AQ==", subType: "100" } },
    { $binary: { base64: "AQ==", subType: "0g" } },
    { $binary: { base64: "AQ==" } },
    { $timestamp: { t: 4294967296, i: 0 } },
    { $timestamp: { t: -2147483649, i: 0 } },
    { $timestamp: { t: 0, i: 4294967296 } },
    { $timestamp: { t: 0, i: 0.5 } },
    { $code: 123 },
    { $code: "return n", $scope: [] },
    { $code: "return n", $scope: 123 },
    { $scope: {} },
    { $minKey: 0 },
    { $maxKey: "junk" },
    { $undefined: 1 },
    { $regularExpression: { pattern: "a" } },
    { $regularExpression: { pattern: "a", options: null } },
    { $regularExpression: { pattern: "a", options: "z" } },
    { $oid: null },
    { $symbol: 123 },
    ...[
      { $oid: "000000000000000000000001" },
      { $uuid: "00000000-0000-0000-0000-000000000001" },
      { $symbol: "n" },
      { $date: "2025-01-01T00:00:00Z" },
      { $timestamp: { t: 0, i: 0 } },
    ].map((wrapper) => ({ ...wrapper, extra: true })),
  ]) {
    const filter = JSON.stringify({ n: wrapper });
    assert.throws(() => parseQueryObject(filter), QueryError);
    await assert.rejects(buildQueryRequest("find", "users", { filter }), QueryError);
    const result = await operations.execute(query("find", { filter }));
    assert(!result.ok);
    assert.equal(result.error.code, "InputInvalid");
  }
  assert.equal(reads, 0);
  for (const wrapper of [
    { $date: "2024-02-29T12:30:05.125+05:30" },
    { $date: { $numberLong: "-8640000000000000" } },
    { $date: { $numberLong: "8640000000000000" } },
    { $binary: { base64: "AQ==", subType: "0" } },
    { $binary: { base64: "", subType: "80" } },
    { $timestamp: { t: 4294967295, i: 4294967295 } },
    { $code: "return n", $scope: { n: { $numberLong: "9007199254740993" } } },
    { $regularExpression: { pattern: "a", options: "im" } },
    { $minKey: 1 },
    { $maxKey: 1 },
    { $undefined: true },
    { $symbol: "n" },
    { $uuid: "00000000-0000-0000-0000-000000000001" },
    { $dbPointer: { $ref: "users", $id: { $oid: "000000000000000000000001" } } },
  ]) {
    const text = JSON.stringify({ n: wrapper });
    assert.deepEqual(parseQueryObject(text), BSON.EJSON.parse(text, { relaxed: false }));
  }
  assert.throws(() => parseQueryObject('{"nul\\u0000key":1}'), QueryError);
});

test("find applies filter/projection/sort/offset, preserves native BSON locally, and closes at the document cap", async () => {
  const state = { visited: 0, closed: 0 };
  let options: unknown;
  let filter: unknown;
  let collectionOptions: unknown;
  const handle = {
    collection(_name: string, config: unknown) {
      collectionOptions = config;
      return {
        find(input: unknown, config: unknown) {
          filter = input;
          options = config;
          return cursor(
            Array.from({ length: 4 }, (_, i) => ({
              _id: new BSON.ObjectId(),
              n: new BSON.Int32(i),
            })),
            state
          );
        },
      };
    },
  } as unknown as Db;
  const result = await runQuery(
    handle,
    query("find", {
      limit: 2,
      skip: 1,
      filter: '{"active":true}',
      projection: '{"n":1}',
      sort: '{"n":-1}',
    })
  );
  assert(result.ok && "documents" in result.data);
  assert.equal(result.data.documents.length, 2);
  assert.equal(result.data.truncationReason, "documents");
  assert.equal(state.visited, 3);
  assert.equal(state.closed, 1);
  assert.deepEqual(filter, { active: true });
  assert.deepEqual(collectionOptions, { promoteValues: false });
  const findOptions = options as {
    limit: number;
    skip: number;
    sort: unknown;
    projection: Record<string, unknown>;
    timeoutMS: number;
  };
  assert.equal(findOptions.limit, 3);
  assert.equal(findOptions.skip, 1);
  assert.equal(findOptions.timeoutMS, 10000);
  assert.deepEqual(findOptions.sort, { n: -1 });
  assert(findOptions.projection["n"] instanceof BSON.Int32);
  assert.deepEqual(result.data.documents[0]?.["n"], { $numberInt: "0" });
  assert.equal(
    typeof ((result.data.documents[0]?.["_id"] ?? {}) as Record<string, unknown>)["$oid"],
    "string"
  );
});

test("result bounds distinguish exact count, extra documents, byte cap, and oversized first documents", async () => {
  for (const [items, truncated, reason, size] of [
    [[{ x: 1 }, { x: 2 }], false, undefined, 2],
    [[{ x: 1 }, { x: 2 }, { x: 3 }], true, "documents", 2],
    [[{ x: "small" }, { x: "x".repeat(queryResultBytes) }], true, "bytes", 1],
    [[{ x: "x".repeat(queryResultBytes) }], true, "bytes", 0],
  ] as const) {
    const state = { visited: 0, closed: 0 };
    const handle = {
      collection: () => ({ find: () => cursor([...items], state) }),
    } as unknown as Db;
    const result = await runQuery(handle, query("find", { limit: 2 }));
    assert(result.ok && "documents" in result.data);
    assert.equal(result.data.truncated, truncated);
    assert.equal(result.data.truncationReason, reason);
    assert.equal(result.data.documents.length, size);
    assert.deepEqual(result.data.limits, { documents: 2, bytes: queryResultBytes });
    assert.equal(state.closed, 1);
  }
});

test("canonical EJSON preserves Int64/date/binary/decimal and relaxed JSON refuses unsafe Int64", async () => {
  const document = {
    n: BSON.Long.fromString("9007199254740993"),
    date: new Date(0),
    binary: new BSON.Binary(Buffer.from([1, 2])),
    decimal: BSON.Decimal128.fromString("1.25"),
    double: new BSON.Double(-0),
  };
  for (const format of ["ejson", "json"] as const) {
    const state = { visited: 0, closed: 0 };
    const handle = {
      collection: () => ({ find: () => cursor([document], state) }),
    } as unknown as Db;
    if (format === "json")
      await assert.rejects(
        runQuery(handle, query("find", { format })),
        (error: unknown) => error instanceof QueryError && error.code === "ResultPrecisionLoss"
      );
    else {
      const result = await runQuery(handle, query("find", { format }));
      assert(result.ok && "documents" in result.data);
      assert.deepEqual(result.data.documents[0]?.["n"], { $numberLong: "9007199254740993" });
      const decoded = BSON.EJSON.deserialize(result.data.documents[0] ?? {}, { relaxed: false });
      assert.equal(decoded.n.toString(), document.n.toString());
      assert.equal(decoded.date.getTime(), 0);
      assert.equal(decoded.decimal.toString(), "1.25");
      assert(Object.is(decoded.double.value, -0));
    }
    assert.equal(state.closed, 1);
  }
  const state = { visited: 0, closed: 0 };
  const handle = {
    collection: () => ({
      find: () => cursor([{ n: new BSON.Int32(1), long: BSON.Long.fromNumber(5) }], state),
    }),
  } as unknown as Db;
  const result = await runQuery(handle, query("find", { format: "json" }));
  assert(result.ok && "documents" in result.data);
  assert.deepEqual(result.data.documents[0], { n: 1, long: 5 });
});

test("aggregate passes the user's pipeline unchanged and bounds only returned documents", async () => {
  const state = { visited: 0, closed: 0 };
  let pipeline: unknown;
  const handle = {
    collection: () => ({
      aggregate(input: unknown) {
        pipeline = input;
        return cursor([], state);
      },
    }),
  } as unknown as Db;
  const request = query("aggregate", {
    pipeline: '[{"$match":{"active":true}},{"$merge":"target"}]',
    limit: 1,
  });
  const result = await runQuery(handle, request);
  assert(result.ok && "documents" in result.data);
  assert.deepEqual(pipeline, [{ $match: { active: true } }, { $merge: "target" }]);
  assert.equal(result.data.truncated, false);
  assert.equal(state.closed, 1);
});

test("nested BSON containers and ordinary _bsontype fields cannot bypass relaxed Int64 precision checks", async () => {
  const long = BSON.Long.fromString("9007199254740993");
  for (const value of [
    new BSON.Code("return n", { n: long }),
    new BSON.DBRef("users", new BSON.ObjectId(), undefined, { n: long }),
    // DBRef's EJSON convention allows arbitrary IDs despite its narrow constructor type.
    new BSON.DBRef("users", long as unknown as BSON.ObjectId),
    { _bsontype: undefined, n: long },
    { _bsontype: null, nested: [{ n: long }] },
    new Map([["nested", { n: long }]]),
    Object.assign(Object.create(null), { n: long }),
  ]) {
    for (const format of ["json", "ejson"] as const) {
      const state = { visited: 0, closed: 0 };
      const document = { value };
      const handle = {
        collection: () => ({ find: () => cursor([document], state) }),
      } as unknown as Db;
      if (format === "json")
        await assert.rejects(
          runQuery(handle, query("find", { format })),
          (error: unknown) => error instanceof QueryError && error.code === "ResultPrecisionLoss"
        );
      else if (
        value !== null &&
        typeof value === "object" &&
        "_bsontype" in value &&
        value._bsontype === null
      )
        // The driver cannot encode this reserved BSON marker; failure must still close the cursor.
        await assert.rejects(
          runQuery(handle, query("find", { format })),
          (error: unknown) => error instanceof QueryError && error.code === "ResultEncodingFailed"
        );
      else {
        const result = await runQuery(handle, query("find", { format }));
        assert(result.ok && "documents" in result.data);
        assert.deepEqual(
          result.data.documents[0],
          BSON.EJSON.serialize(document, { relaxed: false })
        );
        assert(
          JSON.stringify(result.data.documents[0]).includes('"$numberLong":"9007199254740993"')
        );
      }
      assert.equal(state.closed, 1);
    }
  }
});

test("driver operation deadlines produce sanitized structured timeout errors", async () => {
  const error = new MongoOperationTimeoutError("private-arguments/returned-documents/secret-uri");
  const state = { visited: 0, closed: 0 };
  const handle = {
    collection: () => ({ find: () => cursor([], state, error) }),
  } as unknown as Db;
  await assert.rejects(runQuery(handle, query("find")), (caught: unknown) => caught === error);
  assert.equal(state.closed, 1);
  assert.deepEqual(databaseFailure(error), {
    ok: false,
    error: { code: "DatabaseTimedOut", message: "MongoDB exceeded its operation deadline." },
  });
});

test("count returns exact safe integers, zero for empty, and canonical wrappers for large counts", async () => {
  for (const [value, expected] of [
    [new BSON.Int32(3), 3],
    [BSON.Long.fromNumber(5), 5],
    [BSON.Long.fromString("9007199254740993"), { $numberLong: "9007199254740993" }],
    [undefined, 0],
  ] as const) {
    const state = { visited: 0, closed: 0 };
    const handle = {
      collection: () => ({
        aggregate: () => cursor(value === undefined ? [] : [{ count: value }], state),
      }),
    } as unknown as Db;
    const result = await runQuery(handle, query("count"));
    assert(result.ok && "count" in result.data);
    assert.deepEqual(result.data.count, expected);
    assert.equal(state.closed, 1);
  }
});

test("count rejects invalid/inexact results and closes its cursor on next failures", async () => {
  for (const value of [
    "private-document-value",
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    BSON.Long.fromNumber(-1),
  ]) {
    const state = { visited: 0, closed: 0 };
    const handle = {
      collection: () => ({ aggregate: () => cursor([{ count: value }], state) }),
    } as unknown as Db;
    await assert.rejects(runQuery(handle, query("count")), QueryError);
    assert.equal(state.closed, 1);
  }
  const unsafe = { visited: 0, closed: 0 };
  const largeCount = {
    collection: () => ({
      aggregate: () => cursor([{ count: BSON.Long.fromString("9007199254740993") }], unsafe),
    }),
  } as unknown as Db;
  await assert.rejects(
    runQuery(largeCount, query("count", { format: "json" })),
    (error: unknown) => error instanceof QueryError && error.code === "ResultPrecisionLoss"
  );
  assert.equal(unsafe.closed, 1);
  const state = { visited: 0, closed: 0 };
  const handle = {
    collection: () => ({ aggregate: () => cursor([], state, { code: 13 }) }),
  } as unknown as Db;
  await assert.rejects(runQuery(handle, query("count")));
  assert.equal(state.closed, 1);
});

test("describe returns bounded metadata/indexes and always closes both cursors; views skip indexes", async () => {
  for (const type of ["collection", "view"]) {
    const metadata = { visited: 0, closed: 0 };
    const indexes = { visited: 0, closed: 0 };
    const handle = {
      listCollections: () => cursor([{ name: "users", type, options: {} }], metadata),
      collection: () => ({
        listIndexes: () => cursor([{ name: "_id_", key: { _id: 1 } }], indexes),
      }),
    } as unknown as Db;
    const result = await runQuery(handle, query("describe"));
    assert(result.ok && "indexes" in result.data);
    assert.equal(result.data.metadata["type"], type);
    assert.equal(result.data.indexes.length, type === "view" ? 0 : 1);
    assert.equal(metadata.closed, 1);
    assert.equal(indexes.closed, type === "view" ? 0 : 1);
  }
  const metadata = { visited: 0, closed: 0 };
  const handle = {
    listCollections: () => cursor([], metadata),
    collection: () => ({}),
  } as unknown as Db;
  await assert.rejects(
    runQuery(handle, query("describe")),
    (error: unknown) => error instanceof QueryError && error.code === "CollectionNotFound"
  );
  assert.equal(metadata.closed, 1);
});

test("describe closes metadata and index cursors on errors and reports byte truncation", async () => {
  for (const stage of ["metadata", "indexes", "bytes"] as const) {
    const metadata = { visited: 0, closed: 0 };
    const indexes = { visited: 0, closed: 0 };
    const handle = {
      listCollections: () =>
        cursor(
          [{ name: "users", type: "collection", options: {} }],
          metadata,
          stage === "metadata" ? new Error("synthetic-failure") : undefined
        ),
      collection: () => ({
        listIndexes: () =>
          cursor(
            [{ name: "x", extra: "x".repeat(queryResultBytes) }],
            indexes,
            stage === "indexes" ? new Error("synthetic-failure") : undefined
          ),
      }),
    } as unknown as Db;
    // next() throws before returning the metadata when selected; indexes must yield before an error.
    if (stage === "indexes") {
      const failing = {
        ...handle,
        collection: () => ({
          listIndexes: () => cursor([], indexes, new Error("synthetic-failure")),
        }),
      } as unknown as Db;
      await assert.rejects(runQuery(failing, query("describe")));
    } else if (stage === "metadata") await assert.rejects(runQuery(handle, query("describe")));
    else {
      const result = await runQuery(handle, query("describe"));
      assert(result.ok && "indexes" in result.data);
      assert.equal(result.data.indexes.length, 0);
      assert.equal(result.data.truncationReason, "bytes");
    }
    assert.equal(metadata.closed, 1);
    assert.equal(indexes.closed, stage === "metadata" ? 0 : 1);
  }
});

test("worker query validation and name resolution fail before credential or pool access", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-query-worker-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let reads = 0;
  let acquisitions = 0;
  const operations = workerOperations(
    directory,
    {
      async database() {
        acquisitions++;
        throw Error("unexpected");
      },
      async close() {},
    },
    {
      ...credentialStore(),
      read: () => {
        reads++;
        return Effect.succeed("synthetic-secret");
      },
    }
  );
  for (const filter of [
    "[]",
    '{"n":{"$numberLong":"9223372036854775808"}}',
    '{"n":{"$numberInt":"2147483648"}}',
    '{"n":{"$numberDouble":"junk"}}',
  ]) {
    const invalid = await operations.execute(query("find", { filter }));
    assert(!invalid.ok);
    assert.equal(invalid.error.code, "InputInvalid");
  }
  const unknown = await operations.execute(query("find"));
  assert(!unknown.ok);
  assert.equal(unknown.error.code, "EnvironmentNotFound");
  assert.equal(reads, 0);
  assert.equal(acquisitions, 0);
});

test("worker sanitizes query driver/encoding errors after closing the cursor", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-query-errors-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, "catalog.json"),
    JSON.stringify({
      ...emptyCatalog(),
      environments: {
        local: {
          connections: { primary: { provider: "mongodb", secretRef: "keyring:runnel/fake" } },
          databases: { accounts: { connection: "primary", database: "physical_accounts" } },
        },
      },
    })
  );
  for (const [code, expected] of [
    [13, "PermissionDenied"],
    [2, "QueryInvalid"],
    [50, "DatabaseTimedOut"],
    [26, "CollectionNotFound"],
  ] as const) {
    const state = { visited: 0, closed: 0 };
    const handle = {
      collection: () => ({
        find: () =>
          cursor([{ x: "returned-document" }], state, {
            code: new BSON.Int32(code),
            message: "secret-uri/private-arguments/returned-documents",
          }),
      }),
    } as unknown as Db;
    const operations = workerOperations(
      directory,
      { database: async () => handle, close: async () => {} },
      { ...credentialStore(), read: () => Effect.succeed("synthetic-secret") }
    );
    const result = await operations.execute(query("find"));
    assert(!result.ok);
    assert.equal(result.error.code, expected);
    assert.equal(state.closed, 1);
    assert(!JSON.stringify(result).includes("returned"));
    assert(!JSON.stringify(result).includes("secret"));
  }
});

test("query IPC codecs reject unsupported options and accept JSON-only application results", () => {
  for (const request of [
    { operation: "find", collection: "users", limit: 0 },
    { operation: "find", collection: "users", rawHandle: {} },
    { operation: "aggregate", collection: "users" },
    { operation: "count", collection: "users", format: "bson" },
  ])
    assert.throws(() => decodeOperation(request));
  const data = {
    env: "local",
    db: "accounts",
    collection: "users",
    format: "ejson",
    documents: [{ n: { $numberLong: "5" } }],
    truncated: false,
    limits: { documents: 100, bytes: queryResultBytes },
  };
  assert.doesNotThrow(() =>
    decodeResponse({ type: "result", id: "test", result: { ok: true, data } })
  );
  for (const bad of [
    { ...data, extra: true },
    { ...data, limits: { documents: -1, bytes: 0 } },
    { ...data, documents: Array.from({ length: 1001 }, () => ({})) },
  ])
    assert.throws(() =>
      decodeResponse({ type: "result", id: "test", result: { ok: true, data: bad } })
    );
});

test("CLI missing environments and invalid input fail without creating a daemon or catalog", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-query-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const home = join(directory, "missing");
  for (const [args, code] of [
    [["find", "users"], "EnvironmentRequired"],
    [["count", "users"], "EnvironmentRequired"],
    [["aggregate", "users", "-e", "local"], "InputInvalid"],
    [["find", "users", "-e", "local", "--filter", "[]"], "InputInvalid"],
    [["find", "users", "-e", "local", "--limit", "0"], "InputInvalid"],
    [["describe", "users", "-e", "local", "--format", "text"], "InputInvalid"],
  ] as const) {
    const result = spawnSync(process.execPath, [executable, ...args], {
      env: { ...process.env, RUNNEL_HOME: home },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    assert.equal(JSON.parse(result.stdout).error.code, code);
    assert(!existsSync(home));
  }
});
