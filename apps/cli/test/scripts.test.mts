import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createMongoPool } from "@abijith-suresh/runnel-mongodb";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BSON, MongoClient } from "mongodb";
import { emptyCatalog } from "../dist/catalog.js";
import { createOperationHistory, readHistory } from "../dist/history.js";
import { createScriptRunner, prepareScript, type ScriptOperation } from "../dist/script-runner.js";
import { credentialStore } from "../dist/secrets.js";
import { workerOperations } from "../dist/worker-operations.js";
import { decodeOperation, type WorkerResult } from "../dist/worker-protocol.js";
import { createWorkerSupervisor } from "../dist/worker-supervisor.js";

async function fixture(
  t: TestContext,
  body: string,
  workerOptions: { shutdownTimeoutMs?: number } = {}
) {
  const directory = await mkdtemp(join(tmpdir(), "runnel-script-"));
  const path = join(directory, process.platform === "win32" ? "entry #%.mjs" : "entry #?.mjs");
  await writeFile(path, body);
  const catalog = {
    ...emptyCatalog(),
    environments: {
      local: {
        connections: { primary: { provider: "mongodb", secretRef: "keyring:runnel/synthetic" } },
        databases: { accounts: { connection: "primary", database: "physical_accounts" } },
      },
      other: {
        connections: { primary: { provider: "mongodb", secretRef: "keyring:runnel/synthetic2" } },
        databases: { analytics: { connection: "primary", database: "physical_analytics" } },
      },
    },
  };
  await writeFile(join(directory, "catalog.json"), JSON.stringify(catalog));
  const acquired: string[][] = [];
  const clients: MongoClient[] = [];
  const pool = createMongoPool((_uri, options) => {
    const client = new MongoClient("mongodb://127.0.0.1:1", options);
    clients.push(client);
    return client;
  });
  const operations = workerOperations(
    directory,
    {
      database: async (...args) => {
        acquired.push(args);
        return pool.database(...args);
      },
      close: () => pool.close(),
    },
    { ...credentialStore(), read: () => Effect.succeed("synthetic-uri") }
  );
  const worker = createWorkerSupervisor(directory, {
    entrypoint: new URL("./fixtures/script-worker.mjs", import.meta.url),
    ...workerOptions,
  });
  t.after(async () => {
    try {
      await worker.stop();
    } finally {
      try {
        await operations.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });
  const request: ScriptOperation = { operation: "run", env: "local", path, timeoutMs: 300000 };
  return {
    directory,
    path,
    operations,
    acquired,
    clients,
    request,
    worker,
  };
}
function value(result: WorkerResult) {
  assert(result.ok && "value" in result.data);
  return result.data.value;
}
function code(result: WorkerResult) {
  assert(!result.ok);
  return result.error.code;
}

test("scripts receive real native handles and BSON without driver imports, reuse modules and pools, and connect across environments", async (t) => {
  const f = await fixture(
    t,
    `let calls=0; const handles=[];
export default async ({db,args,connect,signal,bson}) => {
 const [a,b]=await Promise.all([connect({env:'other'}),connect({env:'local',db:'accounts'})]);
 calls++; handles.push(db);
 return {calls, args, same:db.client===b.client, warm:handles.every(x=>x.client===db.client), other:a.databaseName, oid:new bson.ObjectId('000000000000000000000001'), long:bson.Long.fromString('9007199254740993'), live:!signal.aborted};
}`
  );
  const first = value(await f.operations.execute({ ...f.request, args: '{"$oid":"literal"}' }));
  const second = Schema.decodeUnknownSync(Schema.JsonObject)(
    value(await f.operations.execute({ ...f.request, args: "null" }))
  );
  assert.deepEqual(first, {
    calls: { $numberInt: "1" },
    args: { $oid: "literal" },
    same: true,
    warm: true,
    other: "physical_analytics",
    oid: { $oid: "000000000000000000000001" },
    long: { $numberLong: "9007199254740993" },
    live: true,
  });
  assert.deepEqual(second["calls"], { $numberInt: "2" });
  assert.equal(second["args"], null);
  assert.equal(second["warm"], true);
  assert.equal(f.clients.length, 2);
  assert.deepEqual(
    new Set(f.acquired.map(([key]) => key)),
    new Set(['["local","primary"]', '["other","primary"]'])
  );
});
test("argument preflight rejects malformed, oversized and unsafe input before any pool or secret use", async (t) => {
  const f = await fixture(t, "export default async ({args})=>args;");
  for (const args of ["{", "1e999", "9007199254740993", '{"n":-9007199254740993}'])
    assert.equal(code(await f.operations.execute({ ...f.request, args })), "InputInvalid");
  assert.equal(
    code(
      await f.operations.execute({ ...f.request, args: JSON.stringify("x".repeat(256 * 1024)) })
    ),
    "InputTooLarge"
  );
  assert.equal(
    code(await f.operations.execute({ ...f.request, path: "relative.mjs" })),
    "ScriptUnavailable"
  );
  assert.equal(f.acquired.length, 0);
  for (const args of ["null", "false", "0", '"hello"', "[]", '{"$numberLong":"literal"}'])
    assert.deepEqual(prepareScript({ ...f.request, args }), JSON.parse(args));
  for (const timeoutMs of [-1, 1.5, 2147483548])
    assert.throws(() => decodeOperation({ ...f.request, timeoutMs }));
  assert.throws(() => decodeOperation({ ...f.request, unexpected: true }));
});
test("script connect and thrown errors return sanitized failure categories", async (t) => {
  for (const [body, expected] of [
    ["export default async ({connect})=>connect({env:'unknown'});", "EnvironmentNotFound"],
    [
      "export default async ()=>{throw new Error('synthetic-secret document dump')};",
      "ScriptFailed",
    ],
    [
      "export default async ()=>{throw {code:13,message:'synthetic-secret document dump'}};",
      "PermissionDenied",
    ],
  ] as const) {
    const f = await fixture(t, body);
    const result = await f.operations.execute(f.request);
    assert.equal(code(result), expected);
    assert(!JSON.stringify(result).includes("synthetic-secret"));
  }
});
test("module loading rejects invalid exports, syntax errors and missing imports", async (t) => {
  const f = await fixture(t, "export default async ()=>({original:true});");
  for (const [name, body] of [
    ["invalid.mjs", "export default 12;"],
    ["broken.mjs", "export default async () => { syntax!!! }"],
    ["imports.mjs", "import './missing.mjs'; export default async()=>1;"],
  ] as const) {
    const path = join(f.directory, name);
    await writeFile(path, body);
    assert.equal(code(await f.operations.execute({ ...f.request, path })), "ScriptInvalid");
  }
  assert.equal(
    code(await f.operations.execute({ ...f.request, path: join(f.directory, "missing.mjs") })),
    "ScriptUnavailable"
  );
});
test("entry reads are regular and bounded, including nonblocking POSIX FIFOs", async (t) => {
  const f = await fixture(t, "export default async()=>1;");
  await writeFile(f.path, "x".repeat(1024 * 1024 + 1));
  assert.equal(code(await f.operations.execute(f.request)), "ScriptUnavailable");
  if (process.platform !== "win32") {
    const path = join(f.directory, "pipe.mjs");
    execFileSync("mkfifo", [path]);
    assert.equal(code(await f.operations.execute({ ...f.request, path })), "ScriptUnavailable");
  }
});
test("script results reject native handles, cycles, functions and oversized data while retaining BSON precision", async (t) => {
  for (const [body, expected] of [
    ["export default async ({db})=>db;", "ResultEncodingFailed"],
    ["export default async ({db})=>db.collection('users').find({});", "ResultEncodingFailed"],
    ["export default async ()=>{const x={};x.x=x;return x;};", "ResultEncodingFailed"],
    ["export default async ()=>({fn:()=>1});", "ResultEncodingFailed"],
    ["export default async ()=>new Date(NaN);", "ResultEncodingFailed"],
    ["export default async ()=>({text:'x'.repeat(512*1024)});", "ResultTooLarge"],
    [
      "export default async ({bson})=>new bson.Code('code',{n:bson.Long.fromString('9007199254740993')});",
      "ResultPrecisionLoss",
    ],
  ] as const) {
    const f = await fixture(t, body);
    assert.equal(code(await f.operations.execute({ ...f.request, format: "json" })), expected);
  }
  const f = await fixture(t, "export default async ()=>undefined;");
  const result = await f.operations.execute(f.request);
  assert.equal(value(result), null);
});
test("nested undefined results explain how to return missing values without exposing data", async (t) => {
  const f = await fixture(
    t,
    "export default async ()=>({privateField:'private-content', optional:undefined});"
  );
  const result = await f.operations.execute(f.request);
  assert(!result.ok);
  assert.equal(result.error.code, "ResultEncodingFailed");
  assert.match(result.error.message, /nested undefined/);
  assert.match(result.error.message, /Use null/);
  assert(!JSON.stringify(result).includes("private-content"));
  assert(!JSON.stringify(result).includes("privateField"));
});

test("cooperative deadlines abort the signal and classify awaited rejections without returning before the script settles", async (t) => {
  const f = await fixture(
    t,
    `export default async ({signal}) => new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>setTimeout(()=>reject(new Error('private abort body')),20),{once:true});
  });`
  );
  const start = performance.now();
  const result = await f.operations.execute({ ...f.request, timeoutMs: 30 });
  assert.equal(code(result), "ScriptTimedOut");
  assert(performance.now() - start >= 45);
  assert(!JSON.stringify(result).includes("private abort"));
});
test("deadline zero allows completion and runner shutdown signals in-progress scripts", async (t) => {
  const f = await fixture(
    t,
    "export default async ()=>{await new Promise(r=>setTimeout(r,80));return true;};"
  );
  assert.equal(value(await f.operations.execute({ ...f.request, timeoutMs: 0 })), true);
  const runner = createScriptRunner();
  t.after(() => runner.close());
  const g = await fixture(
    t,
    "export default async ({signal})=>{await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return true;};"
  );
  const client = new MongoClient("mongodb://127.0.0.1:1");
  t.after(() => client.close());
  const task = runner.execute(
    { ...g.request, timeoutMs: 0 },
    async () => ({ env: "local", db: "accounts", handle: client.db("unused") }),
    async () => client.db("unused"),
    {}
  );
  await delay(60);
  runner.close();
  await assert.rejects(
    task,
    (e: unknown) => typeof e === "object" && e !== null && "code" in e && e.code === "ScriptStopped"
  );
});
test("supervisor script deadlines start on dispatch, allow zero, and discard uncooperative work without replay", async (t) => {
  const worker = createWorkerSupervisor(tmpdir(), {
    entrypoint: new URL("./fixtures/worker.mjs", import.meta.url),
    shutdownTimeoutMs: 20,
  });
  t.after(() => worker.stop());
  const base = { operation: "run", path: join(tmpdir(), "unused.mjs"), timeoutMs: 30 };
  const hang = worker.execute({ ...base, env: "hang" });
  const queued = worker.execute({ ...base, env: "second" });
  assert.equal(code(await hang), "OperationTimedOut");
  assert.equal(code(await queued), "WorkerRestarted");
  const first = worker.execute({ ...base, env: "slow", timeoutMs: 0 });
  const second = worker.execute({ ...base, env: "second", timeoutMs: 10 });
  assert((await first).ok);
  assert((await second).ok);
  assert.equal(worker.status().queued, 0);
});
test("history records one script operation and excludes paths, args, script bodies, secondary targets and returned data", async (t) => {
  const f = await fixture(
    t,
    "export default async({connect,args})=>{await connect({env:'other'});return {private:args};};"
  );
  const recorder = createOperationHistory(f.directory, f.operations);
  try {
    const { result, historyFailed } = await recorder.execute({
      ...f.request,
      args: '{"secret":"private-input"}',
    });
    assert.equal(result.ok, true);
    assert.equal(historyFailed, false);
    const entries = await readHistory(f.directory);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.operation, "run");
    assert.deepEqual(entries[0]?.targets, { env: "local", db: "accounts", connection: "primary" });
    const text = await readFile(join(f.directory, "history", "entries.json"), "utf8");
    for (const privateValue of [
      f.path,
      "private-input",
      "physical_accounts",
      "keyring:",
      "other",
      "export default",
    ])
      assert(!text.includes(privateValue));
  } finally {
    await recorder.flush();
  }
});

test("real worker reset clears ESM entry and imported modules without replaying changed or queued scripts", async (t) => {
  const f = await fixture(
    t,
    "import {name} from './dependency.mjs'; let calls=0; export default async()=>({name,calls:++calls,pid:process.pid});"
  );
  const dependency = join(f.directory, "dependency.mjs");
  await writeFile(dependency, "export const name='original';");
  const request = { ...f.request, format: "json" as const };
  const first = Schema.decodeUnknownSync(Schema.JsonObject)(value(await f.worker.execute(request)));
  assert.equal(first["name"], "original");
  assert.equal(first["calls"], 1);
  await writeFile(dependency, "export const name='new-dependency';");
  const second = Schema.decodeUnknownSync(Schema.JsonObject)(
    value(await f.worker.execute(request))
  );
  assert.equal(second["name"], "original");
  assert.equal(second["calls"], 2);
  await writeFile(
    f.path,
    "import {name} from './dependency.mjs';let calls=0;export default async()=>({name,calls:++calls,pid:process.pid,changed:true});"
  );
  assert.equal(code(await f.worker.execute(request)), "ScriptChanged");
  assert.equal(f.worker.status().pid, first["pid"]);
  await f.worker.reset();
  const third = Schema.decodeUnknownSync(Schema.JsonObject)(value(await f.worker.execute(request)));
  assert.equal(third["name"], "new-dependency");
  assert.equal(third["calls"], 1);
  assert.equal(third["changed"], true);
  assert.notEqual(third["pid"], first["pid"]);
});
test("an uncooperative real script and its queue are terminated once; startup imports also obey the active deadline", async (t) => {
  const f = await fixture(
    t,
    "import {appendFile} from 'node:fs/promises';export default async({args})=>{await appendFile(args.path,'once\\n');while(true){}};",
    { shutdownTimeoutMs: 50 }
  );
  const marker = join(f.directory, "marker.txt");
  const active = f.worker.execute({
    ...f.request,
    args: JSON.stringify({ path: marker }),
    timeoutMs: 300,
  });
  const queued = f.worker.execute({
    ...f.request,
    args: JSON.stringify({ path: marker }),
    timeoutMs: 0,
  });
  assert.equal(code(await active), "OperationTimedOut");
  assert.equal(code(await queued), "WorkerRestarted");
  assert.equal(await readFile(marker, "utf8"), "once\n");
  const path = join(f.directory, "import-hang.mjs");
  await writeFile(path, "await new Promise(()=>{});export default async()=>true;");
  assert.equal(
    code(await f.worker.execute({ ...f.request, path, timeoutMs: 50 })),
    "OperationTimedOut"
  );
  await delay(60);
  assert.equal(await readFile(marker, "utf8"), "once\n");
});

test("finite CPU work cannot succeed after the deadline before timers run", async (t) => {
  const f = await fixture(
    t,
    "export default async()=>{const end=performance.now()+150;while(performance.now()<end){}return true;};"
  );
  assert.equal(code(await f.worker.execute({ ...f.request, timeoutMs: 100 })), "ScriptTimedOut");
});

test("script results preserve signed Int64 edges and refuse inexact relaxed JSON", async (t) => {
  const f = await fixture(
    t,
    "export default async({bson})=>({min:bson.Long.MIN_VALUE,max:bson.Long.MAX_VALUE});"
  );
  assert.deepEqual(value(await f.operations.execute(f.request)), {
    min: { $numberLong: "-9223372036854775808" },
    max: { $numberLong: "9223372036854775807" },
  });
  assert.equal(
    code(await f.operations.execute({ ...f.request, format: "json" })),
    "ResultPrecisionLoss"
  );
});

test("script results preserve native BSON values", async (t) => {
  const f = await fixture(
    t,
    "export default async({bson})=>({int:new bson.Int32(7),double:new bson.Double(1.25),regex:/^a/im,decimal:bson.Decimal128.fromString('1.25'),binary:new bson.Binary(new Uint8Array([1,2,3])),buffer:Buffer.from([1,2,3]),code:new bson.Code('return n',{n:1}),ref:new bson.DBRef('users',new bson.ObjectId('000000000000000000000001'),'db'),timestamp:new bson.Timestamp({t:1,i:2}),uuid:new bson.UUID('00000000-0000-0000-0000-000000000001'),date:new Date(0)});"
  );
  assert.deepEqual(value(await f.operations.execute(f.request)), {
    int: { $numberInt: "7" },
    double: { $numberDouble: "1.25" },
    regex: { $regularExpression: { pattern: "^a", options: "im" } },
    decimal: { $numberDecimal: "1.25" },
    binary: { $binary: { base64: "AQID", subType: "00" } },
    buffer: { $binary: { base64: "AQID", subType: "00" } },
    code: { $code: "return n", $scope: { n: { $numberInt: "1" } } },
    ref: { $ref: "users", $id: { $oid: "000000000000000000000001" }, $db: "db" },
    timestamp: { $timestamp: { t: 1, i: 2 } },
    uuid: { $binary: { base64: "AAAAAAAAAAAAAAAAAAAAAQ==", subType: "04" } },
    date: { $date: { $numberLong: "0" } },
  });
});

test("large JavaScript numbers round-trip as doubles rather than inexact Int64", async (t) => {
  const f = await fixture(t, "export default async()=>({nested:[2**63]});");
  const encoded = value(await f.operations.execute(f.request));
  const decoded = BSON.EJSON.deserialize({ value: encoded }, { relaxed: false })["value"];
  assert(decoded.nested[0] instanceof BSON.Double);
  assert(Object.is(decoded.nested[0].value, 2 ** 63));
  assert.deepEqual(value(await f.operations.execute({ ...f.request, format: "json" })), {
    nested: [2 ** 63],
  });
});
