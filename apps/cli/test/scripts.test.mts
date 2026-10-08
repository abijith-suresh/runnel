import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createMongoPool } from "@abijith-suresh/runnel-mongodb";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { MongoClient } from "mongodb";
import { emptyCatalog } from "../dist/catalog.js";
import { createOperationHistory, readHistory } from "../dist/history.js";
import { createScriptRunner, prepareScript, type ScriptOperation } from "../dist/script-runner.js";
import { credentialStore } from "../dist/secrets.js";
import { workerOperations } from "../dist/worker-operations.js";
import { decodeOperation, decodeResponse, type WorkerResult } from "../dist/worker-protocol.js";
import { createWorkerSupervisor } from "../dist/worker-supervisor.js";

async function fixture(body: string) {
  const directory = await mkdtemp(join(tmpdir(), "runnel-script-"));
  const path = join(directory, "entry #?.mjs");
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
  const request: ScriptOperation = { operation: "run", env: "local", path, timeoutMs: 300000 };
  return {
    directory,
    path,
    operations,
    acquired,
    clients,
    request,
    cleanup: async () => {
      await operations.close();
      await rm(directory, { recursive: true, force: true });
    },
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

test("scripts receive real native handles and BSON without driver imports, reuse modules and pools, and connect across environments", async () => {
  const f = await fixture(`let calls=0; const handles=[];
export default async ({db,args,connect,signal,bson}) => {
 const [a,b]=await Promise.all([connect({env:'other'}),connect({env:'local',db:'accounts'})]);
 calls++; handles.push(db);
 return {calls, args, same:db.client===b.client, warm:handles.every(x=>x.client===db.client), other:a.databaseName, oid:new bson.ObjectId('000000000000000000000001'), long:bson.Long.fromString('9007199254740993'), live:!signal.aborted};
}`);
  try {
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
  } finally {
    await f.cleanup();
  }
});
test("argument preflight rejects malformed, oversized and unsafe input before any pool or secret use", async () => {
  const f = await fixture("export default async ({args})=>args;");
  try {
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
  } finally {
    await f.cleanup();
  }
});
test("script targets and cross-environment connects follow core rules with sanitized failures", async () => {
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
    const f = await fixture(body);
    try {
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
    } finally {
      await f.cleanup();
    }
  }
});
test("module loading failures, invalid exports and entry edits require reset and never execute a changed module", async () => {
  const f = await fixture("export default async ()=>({original:true});");
  try {
    assert.deepEqual(value(await f.operations.execute(f.request)), { original: true });
    await writeFile(f.path, "export default async ()=>({changed:true});");
    assert.equal(code(await f.operations.execute(f.request)), "ScriptChanged");
    assert.equal(code(await f.operations.execute(f.request)), "ScriptChanged");
    for (const [name, body] of [
      ["invalid.mjs", "export default 12;"],
      ["broken.mjs", "export default async () => { syntax!!! }"],
      ["imports.mjs", "import './missing.mjs'; export default async()=>1;"],
    ]) {
      const path = join(f.directory, name!);
      await writeFile(path, body!);
      assert.equal(code(await f.operations.execute({ ...f.request, path })), "ScriptInvalid");
    }
    assert.equal(
      code(await f.operations.execute({ ...f.request, path: join(f.directory, "missing.mjs") })),
      "ScriptUnavailable"
    );
  } finally {
    await f.cleanup();
  }
});
test("entry reads are regular and bounded, including nonblocking POSIX FIFOs", async () => {
  const f = await fixture("export default async()=>1;");
  try {
    await writeFile(f.path, "x".repeat(1024 * 1024 + 1));
    assert.equal(code(await f.operations.execute(f.request)), "ScriptUnavailable");
    if (process.platform !== "win32") {
      const path = join(f.directory, "pipe.mjs");
      execFileSync("mkfifo", [path]);
      assert.equal(code(await f.operations.execute({ ...f.request, path })), "ScriptUnavailable");
    }
  } finally {
    await f.cleanup();
  }
});
test("script results reject native handles, cycles, functions and oversized data while retaining BSON precision", async () => {
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
    const f = await fixture(body);
    try {
      assert.equal(code(await f.operations.execute({ ...f.request, format: "json" })), expected);
    } finally {
      await f.cleanup();
    }
  }
  const f = await fixture("export default async ()=>undefined;");
  try {
    const result = await f.operations.execute(f.request);
    assert.equal(value(result), null);
    assert.deepEqual(decodeResponse({ type: "result", id: "id", result }), {
      type: "result",
      id: "id",
      result,
    });
  } finally {
    await f.cleanup();
  }
});
test("cooperative deadlines abort the signal and classify awaited rejections without returning before the script settles", async () => {
  const f = await fixture(`export default async ({signal}) => new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>setTimeout(()=>reject(new Error('private abort body')),20),{once:true});
  });`);
  try {
    const start = performance.now();
    const result = await f.operations.execute({ ...f.request, timeoutMs: 30 });
    assert.equal(code(result), "ScriptTimedOut");
    assert(performance.now() - start >= 45);
    assert(!JSON.stringify(result).includes("private abort"));
  } finally {
    await f.cleanup();
  }
});
test("deadline zero allows completion and runner shutdown signals in-progress scripts", async () => {
  const f = await fixture(
    "export default async ()=>{await new Promise(r=>setTimeout(r,80));return true;};"
  );
  try {
    assert.equal(value(await f.operations.execute({ ...f.request, timeoutMs: 0 })), true);
  } finally {
    await f.cleanup();
  }
  const runner = createScriptRunner();
  const g = await fixture(
    "export default async ({signal})=>{await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return true;};"
  );
  try {
    const client = new MongoClient("mongodb://127.0.0.1:1");
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
      (e: unknown) =>
        typeof e === "object" && e !== null && "code" in e && e.code === "ScriptStopped"
    );
    await client.close();
  } finally {
    runner.close();
    await g.cleanup();
  }
});
test("supervisor script deadlines start on dispatch, allow zero, and discard uncooperative work without replay", async () => {
  const worker = createWorkerSupervisor(tmpdir(), {
    entrypoint: new URL("./fixtures/worker.mjs", import.meta.url),
    shutdownTimeoutMs: 20,
  });
  try {
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
  } finally {
    await worker.stop();
  }
});
test("history records one script operation and excludes paths, args, script bodies, secondary targets and returned data", async () => {
  const f = await fixture(
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
    await f.cleanup();
  }
});

test("real worker reset clears ESM entry and imported modules without replaying changed or queued scripts", async () => {
  const f = await fixture(
    "import {name} from './dependency.mjs'; let calls=0; export default async()=>({name,calls:++calls,pid:process.pid});"
  );
  const dependency = join(f.directory, "dependency.mjs");
  await writeFile(dependency, "export const name='original';");
  const worker = createWorkerSupervisor(f.directory, {
    entrypoint: new URL("./fixtures/script-worker.mjs", import.meta.url),
  });
  const request = { ...f.request, format: "json" as const };
  try {
    const first = Schema.decodeUnknownSync(Schema.JsonObject)(value(await worker.execute(request)));
    assert.equal(first["name"], "original");
    assert.equal(first["calls"], 1);
    await writeFile(dependency, "export const name='new-dependency';");
    const second = Schema.decodeUnknownSync(Schema.JsonObject)(
      value(await worker.execute(request))
    );
    assert.equal(second["name"], "original");
    assert.equal(second["calls"], 2);
    await writeFile(
      f.path,
      "import {name} from './dependency.mjs';let calls=0;export default async()=>({name,calls:++calls,pid:process.pid,changed:true});"
    );
    assert.equal(code(await worker.execute(request)), "ScriptChanged");
    assert.equal(worker.status().pid, first["pid"]);
    await worker.reset();
    const third = Schema.decodeUnknownSync(Schema.JsonObject)(value(await worker.execute(request)));
    assert.equal(third["name"], "new-dependency");
    assert.equal(third["calls"], 1);
    assert.equal(third["changed"], true);
    assert.notEqual(third["pid"], first["pid"]);
  } finally {
    await worker.stop();
    await f.cleanup();
  }
});
test("an uncooperative real script and its queue are terminated once; startup imports also obey the active deadline", async () => {
  const f = await fixture(
    "import {appendFile} from 'node:fs/promises';export default async({args})=>{await appendFile(args.path,'once\\n');while(true){}};"
  );
  const marker = join(f.directory, "marker.txt");
  const worker = createWorkerSupervisor(f.directory, {
    entrypoint: new URL("./fixtures/script-worker.mjs", import.meta.url),
    shutdownTimeoutMs: 50,
  });
  try {
    const active = worker.execute({
      ...f.request,
      args: JSON.stringify({ path: marker }),
      timeoutMs: 300,
    });
    const queued = worker.execute({
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
      code(await worker.execute({ ...f.request, path, timeoutMs: 50 })),
      "OperationTimedOut"
    );
    await delay(60);
    assert.equal(await readFile(marker, "utf8"), "once\n");
  } finally {
    await worker.stop();
    await f.cleanup();
  }
});

test("finite CPU work and slow result preparation cannot succeed after the deadline before timers run", async () => {
  const f = await fixture(
    "export default async()=>{const end=performance.now()+150;while(performance.now()<end){}return true;};"
  );
  const worker = createWorkerSupervisor(f.directory, {
    entrypoint: new URL("./fixtures/script-worker.mjs", import.meta.url),
  });
  try {
    assert.equal(
      code(await f.operations.execute({ ...f.request, timeoutMs: 100 })),
      "ScriptTimedOut"
    );
    assert.equal(code(await worker.execute({ ...f.request, timeoutMs: 100 })), "ScriptTimedOut");
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
  } finally {
    await worker.stop();
    await f.cleanup();
  }
});

test("throwing error accessors become sanitized results and keep queued scripts in the same worker", async () => {
  const f = await fixture(`let calls=0;export default async({args})=>{
    calls++;
    if(args.kind==='code')throw {get code(){throw Error('private code diagnostic');}};
    if(args.kind==='name'){const error=new Error('private message');Object.defineProperty(error,'name',{get(){throw Error('private name diagnostic');}});throw error;}
    return {calls,pid:process.pid};
  };`);
  const worker = createWorkerSupervisor(f.directory, {
    entrypoint: new URL("./fixtures/script-worker.mjs", import.meta.url),
  });
  try {
    for (const kind of ["code", "name"]) {
      const result = await f.operations.execute({ ...f.request, args: JSON.stringify({ kind }) });
      assert.equal(code(result), "ScriptFailed");
      assert(!JSON.stringify(result).includes("private"));
    }
    const queued = ["code", "name", "success"].map((kind) =>
      worker.execute({ ...f.request, args: JSON.stringify({ kind }) })
    );
    const results = await Promise.all(queued);
    assert.equal(code(results[0]!), "ScriptFailed");
    assert.equal(code(results[1]!), "ScriptFailed");
    const last = Schema.decodeUnknownSync(Schema.JsonObject)(value(results[2]!));
    assert.deepEqual(last["calls"], { $numberInt: "3" });
    assert.deepEqual(last["pid"], { $numberInt: String(worker.status().pid) });
    assert.equal(worker.status().queued, 0);
    assert(!JSON.stringify(results).includes("private"));
  } finally {
    await worker.stop();
    await f.cleanup();
  }
});

test("script-modified application errors cannot expose arguments or documents through messages or codes", async () => {
  const f = await fixture(
    `export default async({connect,args})=>{try{await connect({env:'unknown'});}catch(error){error.message='private-input '+args.private;if(args.modifyCode)error.code='private-code '+args.private;throw error;}};`
  );
  const worker = createWorkerSupervisor(f.directory, {
    entrypoint: new URL("./fixtures/script-worker.mjs", import.meta.url),
  });
  try {
    for (const modifyCode of [false, true])
      for (const execute of [
        (request: ScriptOperation) => f.operations.execute(request),
        (request: ScriptOperation) => worker.execute(request),
      ]) {
        const result = await execute({
          ...f.request,
          args: JSON.stringify({ private: "secret-value", modifyCode }),
        });
        assert.equal(code(result), modifyCode ? "ScriptFailed" : "EnvironmentNotFound");
        assert(!JSON.stringify(result).includes("private"));
        assert(!JSON.stringify(result).includes("secret-value"));
      }
  } finally {
    await worker.stop();
    await f.cleanup();
  }
});
test("result accessors cannot change validation or BSON precision; data proxies are snapshotted before encoding", async () => {
  const f = await fixture("export default async()=>true;");
  const worker = createWorkerSupervisor(f.directory, {
    entrypoint: new URL("./fixtures/script-worker.mjs", import.meta.url),
  });
  try {
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
    ]) {
      const path = join(f.directory, name! + ".mjs");
      await writeFile(path, body!);
      for (const execute of [
        (request: ScriptOperation) => f.operations.execute(request),
        (request: ScriptOperation) => worker.execute(request),
      ])
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
    for (const execute of [
      (request: ScriptOperation) => f.operations.execute(request),
      (request: ScriptOperation) => worker.execute(request),
    ])
      assert.deepEqual(value(await execute({ ...f.request, path: proxy, format: "json" })), {
        item: null,
      });
    const bson = join(f.directory, "bson.mjs");
    await writeFile(
      bson,
      "export default async({bson})=>({code:new bson.Code('code',{n:bson.Long.fromString('9007199254740993')}),ref:new bson.DBRef('users',new bson.ObjectId('000000000000000000000001'),'db',{n:bson.Long.fromString('9007199254740993')}),timestamp:new bson.Timestamp({t:1,i:2})});"
    );
    const result = Schema.decodeUnknownSync(Schema.JsonObject)(
      value(await worker.execute({ ...f.request, path: bson }))
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
      code(await worker.execute({ ...f.request, path: bson, format: "json" })),
      "ResultPrecisionLoss"
    );
  } finally {
    await worker.stop();
    await f.cleanup();
  }
});

test("BSON snapshots preserve signed Int64 edges and reject payloads that EJSON round trips would coerce", async () => {
  const f = await fixture(
    "export default async({bson})=>({min:bson.Long.MIN_VALUE,max:bson.Long.MAX_VALUE});"
  );
  try {
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
    ]) {
      const path = join(f.directory, name! + ".mjs");
      await writeFile(path, body!);
      for (const format of ["json", "ejson"] as const)
        assert.equal(
          code(await f.operations.execute({ ...f.request, path, format })),
          "ResultEncodingFailed"
        );
    }
  } finally {
    await f.cleanup();
  }
});

test("native BSON wrappers validate payload types and invalid dates cannot produce unusable EJSON", async () => {
  const f = await fixture("export default async()=>true;");
  const worker = createWorkerSupervisor(f.directory, {
    entrypoint: new URL("./fixtures/script-worker.mjs", import.meta.url),
  });
  try {
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
    ]) {
      const path = join(f.directory, name! + ".mjs");
      await writeFile(path, body!);
      for (const format of ["json", "ejson"] as const)
        for (const execute of [
          (request: ScriptOperation) => f.operations.execute(request),
          (request: ScriptOperation) => worker.execute(request),
        ]) {
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
        value(await worker.execute({ ...f.request, path: valid, format }))
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
  } finally {
    await worker.stop();
    await f.cleanup();
  }
});
