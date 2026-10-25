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
import { decodeOperation, decodeResponse, type WorkerResult } from "../dist/worker-protocol.js";
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
    executors: [
      (request: ScriptOperation) => operations.execute(request),
      (request: ScriptOperation) => worker.execute(request),
    ],
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
test("script targets and cross-environment connects follow core rules with sanitized failures", async (t) => {
  for (const [body, expected] of [
    ["export default async ({connect})=>connect({db:'accounts'});", "InputInvalid"],
    ["export default async ({connect})=>connect({env:'unknown'});", "EnvironmentNotFound"],
    ["export default async ({connect})=>connect({env:'local',db:'unknown'});", "DatabaseNotFound"],
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
    assert.equal(
      code(
        await f.operations.execute({ ...f.request, env: undefined } as unknown as ScriptOperation)
      ),
      "RequestInvalid"
    );
    const { env: _env, ...withoutEnvironment } = f.request;
    assert.equal(code(await f.operations.execute(withoutEnvironment)), "EnvironmentRequired");
    assert.equal(
      code(await f.operations.execute({ ...f.request, db: "missing" })),
      "DatabaseNotFound"
    );
  }
});
test("module loading failures, invalid exports and entry edits require reset and never execute a changed module", async (t) => {
  const f = await fixture(t, "export default async ()=>({original:true});");
  assert.deepEqual(value(await f.operations.execute(f.request)), { original: true });
  await writeFile(f.path, "export default async ()=>({changed:true});");
  assert.equal(code(await f.operations.execute(f.request)), "ScriptChanged");
  assert.equal(code(await f.operations.execute(f.request)), "ScriptChanged");
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
  assert.deepEqual(decodeResponse({ type: "result", id: "id", result }), {
    type: "result",
    id: "id",
    result,
  });
});
test("nested undefined results explain how to return missing values without exposing data", async (t) => {
  for (const body of [
    "export default async ()=>({privateField:'private-content', optional:undefined});",
    "export default async ()=>['private-content', undefined];",
  ]) {
    const f = await fixture(t, body);
    for (const format of ["json", "ejson"] as const) {
      const result = await f.operations.execute({ ...f.request, format });
      assert(!result.ok);
      assert.equal(result.error.code, "ResultEncodingFailed");
      assert.match(result.error.message, /nested undefined/);
      assert.match(result.error.message, /Use null/);
      assert(!JSON.stringify(result).includes("private-content"));
      assert(!JSON.stringify(result).includes("privateField"));
    }
  }
  const f = await fixture(t, "export default async ()=>({optional:null});");
  assert.deepEqual(value(await f.operations.execute(f.request)), { optional: null });
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

test("finite CPU work and slow result preparation cannot succeed after the deadline before timers run", async (t) => {
  const f = await fixture(
    t,
    "export default async()=>{const end=performance.now()+150;while(performance.now()<end){}return true;};"
  );
  assert.equal(
    code(await f.operations.execute({ ...f.request, timeoutMs: 100 })),
    "ScriptTimedOut"
  );
  assert.equal(code(await f.worker.execute({ ...f.request, timeoutMs: 100 })), "ScriptTimedOut");
  const path = join(f.directory, "slow-result.mjs");
  await writeFile(
    path,
    "export default async()=>new Proxy({value:true},{ownKeys(target){const end=performance.now()+150;while(performance.now()<end){}return Reflect.ownKeys(target);}});"
  );
  assert.equal(
    code(await f.operations.execute({ ...f.request, path, timeoutMs: 100 })),
    "ScriptTimedOut"
  );
  const failure = join(f.directory, "late-error.mjs");
  await writeFile(
    failure,
    "export default async()=>{const end=performance.now()+150;while(performance.now()<end){}throw new Error('private late failure');};"
  );
  const result = await f.operations.execute({ ...f.request, path: failure, timeoutMs: 100 });
  assert.equal(code(result), "ScriptTimedOut");
  assert(!JSON.stringify(result).includes("private late failure"));
});

test("throwing error accessors become sanitized results and keep queued scripts in the same worker", async (t) => {
  const f = await fixture(
    t,
    `let calls=0;export default async({args})=>{
    calls++;
    if(args.kind==='code')throw {get code(){throw Error('private code diagnostic');}};
    if(args.kind==='name'){const error=new Error('private message');Object.defineProperty(error,'name',{get(){throw Error('private name diagnostic');}});throw error;}
    return {calls,pid:process.pid};
  };`
  );
  for (const kind of ["code", "name"]) {
    const result = await f.operations.execute({ ...f.request, args: JSON.stringify({ kind }) });
    assert.equal(code(result), "ScriptFailed");
    assert(!JSON.stringify(result).includes("private"));
  }
  const queued = ["code", "name", "success"].map((kind) =>
    f.worker.execute({ ...f.request, args: JSON.stringify({ kind }) })
  );
  const results = await Promise.all(queued);
  assert.equal(code(results[0]!), "ScriptFailed");
  assert.equal(code(results[1]!), "ScriptFailed");
  const last = Schema.decodeUnknownSync(Schema.JsonObject)(value(results[2]!));
  assert.deepEqual(last["calls"], { $numberInt: "3" });
  assert.deepEqual(last["pid"], { $numberInt: String(f.worker.status().pid) });
  assert.equal(f.worker.status().queued, 0);
  assert(!JSON.stringify(results).includes("private"));
});

test("script-modified application errors cannot expose arguments or documents through messages or codes", async (t) => {
  const f = await fixture(
    t,
    `export default async({connect,args})=>{try{await connect({env:'unknown'});}catch(error){error.message='private-input '+args.private;if(args.modifyCode)error.code='private-code '+args.private;throw error;}};`
  );
  for (const modifyCode of [false, true])
    for (const execute of f.executors) {
      const result = await execute({
        ...f.request,
        args: JSON.stringify({ private: "secret-value", modifyCode }),
      });
      assert.equal(code(result), modifyCode ? "ScriptFailed" : "EnvironmentNotFound");
      assert(!JSON.stringify(result).includes("private"));
      assert(!JSON.stringify(result).includes("secret-value"));
    }
});
test("result accessors cannot change validation or BSON precision; data proxies are snapshotted before encoding", async (t) => {
  const f = await fixture(t, "export default async()=>true;");
  for (const [name, body] of [
    [
      "long",
      "export default async({bson})=>{let reads=0;return {get item(){return ++reads<3?null:bson.Long.fromString('9007199254740993');}}};",
    ],
    [
      "class",
      "export default async()=>{let reads=0;return {get item(){return ++reads<2?null:new class {constructor(){this.private='forbidden';}}}}};",
    ],
    [
      "array",
      "export default async({bson})=>{const a=[];Object.defineProperty(a,'0',{get(){return bson.Long.fromString('9007199254740993');},enumerable:true});return a;};",
    ],
    [
      "scope",
      "export default async({bson})=>new bson.Code('code',{get item(){return bson.Long.fromString('9007199254740993');}});",
    ],
  ] as const) {
    const path = join(f.directory, name + ".mjs");
    await writeFile(path, body);
    for (const execute of f.executors)
      assert.equal(
        code(await execute({ ...f.request, path, format: "json" })),
        "ResultEncodingFailed"
      );
  }
  const proxy = join(f.directory, "proxy.mjs");
  await writeFile(
    proxy,
    "export default async({bson})=>new Proxy({item:null},{get(){return bson.Long.fromString('9007199254740993');}});"
  );
  for (const execute of f.executors)
    assert.deepEqual(value(await execute({ ...f.request, path: proxy, format: "json" })), {
      item: null,
    });
  const bson = join(f.directory, "bson.mjs");
  await writeFile(
    bson,
    "export default async({bson})=>({code:new bson.Code('code',{n:bson.Long.fromString('9007199254740993')}),ref:new bson.DBRef('users',new bson.ObjectId('000000000000000000000001'),'db',{n:bson.Long.fromString('9007199254740993')}),timestamp:new bson.Timestamp({t:1,i:2})});"
  );
  const result = Schema.decodeUnknownSync(Schema.JsonObject)(
    value(await f.worker.execute({ ...f.request, path: bson }))
  );
  assert.deepEqual(result["code"], {
    $code: "code",
    $scope: { n: { $numberLong: "9007199254740993" } },
  });
  assert.deepEqual(result["ref"], {
    $ref: "users",
    $id: { $oid: "000000000000000000000001" },
    $db: "db",
    n: { $numberLong: "9007199254740993" },
  });
  assert.deepEqual(result["timestamp"], { $timestamp: { t: 1, i: 2 } });
  assert.equal(
    code(await f.worker.execute({ ...f.request, path: bson, format: "json" })),
    "ResultPrecisionLoss"
  );
});

test("BSON snapshots preserve signed Int64 edges and reject payloads that EJSON round trips would coerce", async (t) => {
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
  for (const [name, body] of [
    [
      "unsigned",
      "export default async({bson})=>bson.Long.fromString('18446744073709551615',true);",
    ],
    [
      "int32",
      "export default async({bson})=>{const value=new bson.Int32(1);value.value=2147483648;return value;};",
    ],
    [
      "bits",
      "export default async({bson})=>{const value=new bson.Long(1,0,false);value.high=1.5;return value;};",
    ],
  ] as const) {
    const path = join(f.directory, name + ".mjs");
    await writeFile(path, body);
    for (const format of ["json", "ejson"] as const)
      assert.equal(
        code(await f.operations.execute({ ...f.request, path, format })),
        "ResultEncodingFailed"
      );
  }
});

test("native BSON wrappers validate payload types and invalid dates cannot produce unusable EJSON", async (t) => {
  const f = await fixture(t, "export default async()=>true;");
  for (const [name, body] of [
    [
      "symbol-accessor",
      "export default async({bson})=>new bson.BSONSymbol({get value(){return new class {constructor(){this.private='class-data';}}}});",
    ],
    [
      "symbol-class",
      "export default async({bson})=>new bson.BSONSymbol(new class {constructor(){this.private='class-data';}});",
    ],
    [
      "regexp-payload",
      "export default async({bson})=>{const value=new bson.BSONRegExp('a');value.pattern={private:'class-data'};return value;};",
    ],
    ["code-payload", "export default async({bson})=>new bson.Code('code','class-data');"],
    ["date", "export default async()=>new Date(NaN);"],
    ["uuid-bytes", "export default async({bson})=>new bson.Binary(new Uint8Array([1,2,3]),4);"],
    ["code-scope-date", "export default async({bson})=>new bson.Code('code',new Date(0));"],
  ] as const) {
    const path = join(f.directory, name + ".mjs");
    await writeFile(path, body);
    for (const format of ["json", "ejson"] as const)
      for (const execute of f.executors) {
        const result = await execute({ ...f.request, path, format });
        assert.equal(code(result), "ResultEncodingFailed");
        assert(!JSON.stringify(result).includes("class-data"));
      }
  }
  const valid = join(f.directory, "valid-wrappers.mjs");
  await writeFile(
    valid,
    "export default async({bson})=>({symbol:new bson.BSONSymbol('literal'),regex:new bson.BSONRegExp('^a','i'),decimal:bson.Decimal128.fromString('1.25'),binary:new bson.Binary(new Uint8Array([1,2,3])),uuid:new bson.UUID('00000000-0000-0000-0000-000000000001'),oid:new bson.ObjectId('000000000000000000000001'),min:new bson.MinKey(),max:new bson.MaxKey(),date:new Date(0)});"
  );
  for (const format of ["json", "ejson"] as const) {
    const result = Schema.decodeUnknownSync(Schema.JsonObject)(
      value(await f.worker.execute({ ...f.request, path: valid, format }))
    );
    assert.deepEqual(result["symbol"], { $symbol: "literal" });
    assert.deepEqual(result["regex"], { $regularExpression: { pattern: "^a", options: "i" } });
    assert.deepEqual(result["decimal"], { $numberDecimal: "1.25" });
    assert.deepEqual(result["binary"], { $binary: { base64: "AQID", subType: "00" } });
    assert.deepEqual(result["uuid"], {
      $binary: { base64: "AAAAAAAAAAAAAAAAAAAAAQ==", subType: "04" },
    });
    assert.deepEqual(result["oid"], { $oid: "000000000000000000000001" });
    assert.deepEqual(result["min"], { $minKey: 1 });
    assert.deepEqual(result["max"], { $maxKey: 1 });
    assert.deepEqual(
      result["date"],
      format === "json" ? { $date: "1970-01-01T00:00:00Z" } : { $date: { $numberLong: "0" } }
    );
  }
});

test("large JavaScript numeric results retain their IEEE754 values instead of becoming inexact Int64", async (t) => {
  const f = await fixture(t, "export default async()=>2**63;");
  const cases = [
    ["2**60", 2 ** 60],
    ["2**63", 2 ** 63],
    ["-(2**63)", -(2 ** 63)],
    ["Number.MAX_VALUE", Number.MAX_VALUE],
  ] as const;
  for (const [index, [expression, expected]] of cases.entries()) {
    const path = join(f.directory, `number-${index}.mjs`);
    await writeFile(path, `export default async()=>${expression};`);
    for (const execute of f.executors) {
      const encoded = value(await execute({ ...f.request, path, format: "ejson" }));
      assert(Object.hasOwn(Schema.decodeUnknownSync(Schema.JsonObject)(encoded), "$numberDouble"));
      const decoded: unknown = BSON.EJSON.deserialize({ value: encoded }, { relaxed: false })[
        "value"
      ];
      assert(decoded instanceof BSON.Double);
      assert(Object.is(decoded.value, expected));
      assert(Object.is(value(await execute({ ...f.request, path, format: "json" })), expected));
    }
  }
  const nested = join(f.directory, "nested-number.mjs");
  await writeFile(
    nested,
    "export default async({bson})=>({array:[2**63],code:new bson.Code('code',{n:-(2**63)}),ref:new bson.DBRef('items',new bson.ObjectId('000000000000000000000001'),undefined,{n:2**60})});"
  );
  for (const execute of f.executors) {
    const encoded = value(await execute({ ...f.request, path: nested }));
    const decoded = BSON.EJSON.deserialize({ value: encoded }, { relaxed: false })["value"];
    assert(decoded.array[0] instanceof BSON.Double);
    assert(Object.is(decoded.array[0].value, 2 ** 63));
    assert(decoded.code.scope.n instanceof BSON.Double);
    assert(Object.is(decoded.code.scope.n.value, -(2 ** 63)));
    assert(decoded.ref.fields.n instanceof BSON.Double);
    assert(Object.is(decoded.ref.fields.n.value, 2 ** 60));
  }
});

test("ObjectId snapshots validate captured bytes and native RegExp overrides cannot invoke coercion", async (t) => {
  const f = await fixture(t, "export default async()=>true;");
  for (const [index, body] of [
    ...["i0=1.5", "i1=-1", "i2=16777216", "i3=NaN", "i0='16777215'", "i0=Infinity"].map(
      (assignment) =>
        `export default async({bson})=>{const value=new bson.ObjectId('000000000000000000000001');value.${assignment};return value;};`
    ),
    ...["source", "flags"].map(
      (key) =>
        `export default async()=>{const value=/x/;Object.defineProperty(value,'${key}',{value:new class {toString(){return '${key === "source" ? "class-data" : "i"}';}}});return value;};`
    ),
  ].entries()) {
    const path = join(f.directory, `invalid-native-${index}.mjs`);
    await writeFile(path, body);
    for (const format of ["json", "ejson"] as const)
      for (const execute of f.executors) {
        const result = await execute({ ...f.request, path, format });
        assert.equal(code(result), "ResultEncodingFailed");
        assert(!JSON.stringify(result).includes("class-data"));
      }
  }
  const valid = join(f.directory, "native-snapshot.mjs");
  await writeFile(
    valid,
    "export default async({bson})=>({oid:new Proxy(new bson.ObjectId('000000000000000000000001'),{get(t,k,r){return k==='i0'?0xffffff:Reflect.get(t,k,r);}}),edge:new bson.ObjectId('ffffffffffffffffffffffff'),regex:/^a/im});"
  );
  for (const format of ["json", "ejson"] as const)
    for (const execute of f.executors)
      assert.deepEqual(value(await execute({ ...f.request, path: valid, format })), {
        oid: { $oid: "000000000000000000000001" },
        edge: { $oid: "ffffffffffffffffffffffff" },
        regex: { $regularExpression: { pattern: "^a", options: "im" } },
      });
});

test("byte snapshots reject payload overrides and copy actual native bytes without Buffer coercion", async (t) => {
  const f = await fixture(t, "export default async()=>true;");
  for (const [index, body] of [
    "export default async({bson})=>{const value=new bson.Binary(new Uint8Array([1,2,3]),4);Object.defineProperties(value.buffer,{byteLength:{get(){return 16;}},length:{get(){return 16;}}});value.position=16;return value;};",
    "export default async({bson})=>{const value=bson.Decimal128.fromString('1.25');value.bytes=new Uint8Array([1,2,3]);Object.defineProperties(value.bytes,{byteLength:{get(){return 16;}},length:{get(){return 16;}}});return value;};",
    "export default async()=>{const value=Buffer.from([1,2,3]);value.valueOf=()=>Buffer.from('changed');return value;};",
    "export default async({bson})=>{const value=new bson.Binary(new Uint8Array([1,2,3]),4);Object.defineProperties(value.buffer,{byteLength:{value:16},length:{value:16}});value.position=16;return value;};",
  ].entries()) {
    const path = join(f.directory, `modified-bytes-${index}.mjs`);
    await writeFile(path, body);
    for (const format of ["json", "ejson"] as const)
      for (const execute of f.executors) {
        const result = await execute({ ...f.request, path, format });
        assert.equal(code(result), "ResultEncodingFailed");
        assert(!JSON.stringify(result).includes("changed"));
      }
  }
  const valid = join(f.directory, "native-bytes.mjs");
  await writeFile(
    valid,
    "export default async({bson})=>({buffer:Buffer.from([1,2,3]),binary:new bson.Binary(new Uint8Array([4,5,6])),decimal:bson.Decimal128.fromString('1.25')});"
  );
  for (const format of ["json", "ejson"] as const)
    for (const execute of f.executors) {
      const encoded = value(await execute({ ...f.request, path: valid, format }));
      const decoded = BSON.EJSON.deserialize({ value: encoded }, { relaxed: false })["value"];
      assert.deepEqual(Array.from(decoded.buffer.buffer), [1, 2, 3]);
      assert.deepEqual(Array.from(decoded.binary.buffer), [4, 5, 6]);
      assert.equal(decoded.decimal.toString(), "1.25");
    }
});

test("array snapshots validate primitive lengths and index bounds before allocating or coercing", async (t) => {
  const f = await fixture(t, "export default async()=>true;");
  for (const [index, length] of [
    "new class {valueOf(){return 0;}}",
    "'0'",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "4294967296",
    "0",
    "524289",
  ].entries()) {
    const path = join(f.directory, `array-length-${index}.mjs`);
    await writeFile(
      path,
      `export default async({bson})=>new Proxy([bson.Long.fromString('9007199254740993')],{getOwnPropertyDescriptor(t,k){const d=Reflect.getOwnPropertyDescriptor(t,k);return k==='length'?{...d,value:${length}}:d;}});`
    );
    for (const format of ["json", "ejson"] as const)
      for (const execute of f.executors)
        assert.equal(
          code(await execute({ ...f.request, path, format })),
          length === "524289" ? "ResultTooLarge" : "ResultEncodingFailed"
        );
  }
  const valid = join(f.directory, "valid-array.mjs");
  await writeFile(valid, "export default async()=>[1,false,'literal',null];");
  for (const format of ["json", "ejson"] as const)
    for (const execute of f.executors)
      assert.deepEqual(value(await execute({ ...f.request, path: valid, format })), [
        format === "json" ? 1 : { $numberInt: "1" },
        false,
        "literal",
        null,
      ]);
});
