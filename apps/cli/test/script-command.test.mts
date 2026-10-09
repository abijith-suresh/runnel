import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { emptyCatalog } from "../dist/catalog.js";
import { daemonCommand, executeWithDaemon } from "../dist/daemon-client.js";
import type { DaemonResponse } from "../dist/daemon-protocol.js";
import { startDaemon } from "../dist/daemon-server.js";
import { readHistory } from "../dist/history.js";
import { QueryError, readQueryInput } from "../dist/query-input.js";
import { buildScriptRequest, runScriptCommand, scriptTimeout } from "../dist/script-command.js";
import { scriptMaximumTimeoutMs } from "../dist/worker-protocol.js";
import { createWorkerSupervisor } from "../dist/worker-supervisor.js";

const executable = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const encodedEntryName = process.platform === "win32" ? "entry #%.mjs" : "entry #?.mjs";
const workerEntrypoint = new URL("./fixtures/script-worker.mjs", import.meta.url);
async function fixture(scriptTimeoutMs = 300000) {
  const directory = await mkdtemp(join(tmpdir(), "runnel-script-cli-"));
  await writeFile(
    join(directory, "catalog.json"),
    JSON.stringify({
      ...emptyCatalog(),
      settings: { idleTimeoutMs: 300000, scriptTimeoutMs },
      environments: {
        local: {
          connections: { primary: { provider: "mongodb", secretRef: "keyring:runnel/synthetic" } },
          databases: { accounts: { connection: "primary", database: "physical_accounts" } },
        },
      },
    })
  );
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
function launch(directory: string, args: string[], input?: string) {
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: directory,
    env: { ...process.env, RUNNEL_HOME: directory },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const completed = new Promise<{
    status: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  if (input !== undefined) child.stdin.end(input);
  return { child, completed };
}
function code(result: DaemonResponse) {
  assert(!result.ok);
  return result.error.code;
}
function value(result: DaemonResponse) {
  assert(result.ok && "value" in result.data);
  return result.data.value;
}
async function state(directory: string) {
  const result = await daemonCommand(directory, "status");
  assert(result.ok && "running" in result.data && result.data.running);
  return result.data.worker;
}
async function waitFor(condition: () => Promise<boolean>) {
  for (let i = 0; i < 400; i++) {
    if (await condition()) return;
    await delay(5);
  }
  assert.fail("Expected local operation state was not reached");
}
async function finish(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  child.kill("SIGKILL");
  await closed;
}

test("script CLI prepares absolute entries, plain JSON/file args and bounded duration defaults", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.directory, "args.json"), '{"$numberLong":"literal"}');
    const request = await buildScriptRequest(
      "example.mjs",
      { env: "local", "args-file": join(f.directory, "args.json") },
      500
    );
    assert.equal(request.path, resolve("example.mjs"));
    assert.equal(request.args, '{"$numberLong":"literal"}');
    assert.equal(request.timeoutMs, 500);
    assert.equal(
      (
        await buildScriptRequest("example.mjs", {
          env: "local",
          timeout: "0",
          args: "null",
          format: "json",
        })
      ).timeoutMs,
      0
    );
    for (const [text, expected] of [
      ["0", 0],
      ["1ms", 1],
      ["2s", 2000],
      ["5m", 300000],
      ["1h", 3600000],
      [scriptMaximumTimeoutMs + "ms", scriptMaximumTimeoutMs],
    ] as const)
      assert.equal(scriptTimeout(text), expected);
    for (const text of [
      "1",
      "1500",
      "2m30s",
      "-1s",
      "1.5s",
      " 5m",
      "Infinity",
      "1d",
      "2147483548ms",
      "999999999999999h",
    ])
      assert.throws(
        () => scriptTimeout(text),
        (error: unknown) =>
          error instanceof QueryError &&
          error.code === "InputInvalid" &&
          error.message.includes("1500ms") &&
          error.message.includes("For 2m30s use 150s")
      );
    await assert.rejects(
      buildScriptRequest("example.mjs", {
        env: "local",
        "args-file": join(f.directory, "private-args.json"),
      }),
      (error: unknown) =>
        error instanceof QueryError &&
        error.code === "InputUnavailable" &&
        error.message.includes("--args-file") &&
        !error.message.includes("private-args")
    );
    for (const values of [
      { "args-file": join(f.directory, "missing") },
      { env: "local", args: "{}", "args-file": "-" },
      { env: "local", args: "{" },
      { env: "local", args: "9007199254740993" },
      { env: "local", args: " ".repeat(256 * 1024 + 1) },
      { env: "local", format: "invalid", "args-file": "-" },
    ])
      await assert.rejects(buildScriptRequest("example.mjs", values), QueryError);
    await assert.rejects(
      buildScriptRequest("example.mjs", { env: "local" }, scriptMaximumTimeoutMs + 1),
      QueryError
    );
    const cancelled = new AbortController();
    cancelled.abort();
    assert.equal(
      code(
        await runScriptCommand(
          f.directory,
          "example.mjs",
          { env: "local", "args-file": "-" },
          cancelled.signal
        )
      ),
      "OperationCancelled"
    );
    await assert.rejects(stat(join(f.directory, "daemon")), { code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});

test("script CLI executes relative ES modules with inline/file/stdin args, default and zero deadlines and clean stdout", async () => {
  const f = await fixture(200);
  const daemon = await startDaemon(f.directory, { workerEntrypoint });
  try {
    await writeFile(
      join(f.directory, encodedEntryName),
      "let calls=0;export default async({db,args,bson})=>{console.log('worker-output');return {calls:++calls,name:db.databaseName,args,oid:new bson.ObjectId('000000000000000000000001')};};"
    );
    await writeFile(join(f.directory, "args.json"), '{"$numberLong":"literal"}');
    for (const [options, input, expected] of [
      [["--args", "null"], "", null],
      [["--args-file", "args.json"], "", { $numberLong: "literal" }],
      [["--args-file", "-"], "[1,false]", [1, false]],
    ] as const) {
      const result = await launch(
        f.directory,
        ["run", encodedEntryName, "-e", "local", "--format", "json", ...options],
        input
      ).completed;
      assert.equal(result.status, 0, result.stderr + result.stdout);
      assert.equal(result.stderr, "");
      assert.equal(result.stdout.trim().split("\n").length, 1);
      const data = value(JSON.parse(result.stdout) as DaemonResponse) as Record<string, unknown>;
      assert.deepEqual(data["args"], expected);
      assert.equal(data["name"], "physical_accounts");
      assert.deepEqual(data["oid"], { $oid: "000000000000000000000001" });
    }
    await writeFile(
      join(f.directory, "slow.mjs"),
      "export default async({signal})=>{await new Promise((r,j)=>{const timer=setTimeout(r,400);signal.addEventListener('abort',()=>{clearTimeout(timer);j(new Error('deadline'));},{once:true});});return 'done';};"
    );
    const timeout = await launch(f.directory, ["run", "slow.mjs", "-e", "local"], "").completed;
    assert.equal(timeout.status, 1);
    assert.equal(code(JSON.parse(timeout.stdout) as DaemonResponse), "ScriptTimedOut");
    const zero = await launch(f.directory, ["run", "slow.mjs", "-e", "local", "--timeout", "0"], "")
      .completed;
    assert.equal(zero.status, 0, zero.stderr);
    assert.equal(value(JSON.parse(zero.stdout) as DaemonResponse), "done");
    const extended = await launch(
      f.directory,
      ["run", "slow.mjs", "-e", "local", "--timeout", "1s"],
      ""
    ).completed;
    assert.equal(extended.status, 0);
  } finally {
    await daemon.stop();
    await f.cleanup();
  }
});

test("script CLI input failures and missing environment do not start a daemon; script options stay scoped", async () => {
  const f = await fixture();
  try {
    const missing = await launch(
      f.directory,
      ["run", "entry.mjs", "--args-file", "missing.json"],
      ""
    ).completed;
    assert.equal(code(JSON.parse(missing.stdout) as DaemonResponse), "EnvironmentRequired");
    for (const options of [
      ["--args", "{"],
      ["--args", "{}", "--args-file", "-"],
      ["--format", "invalid"],
      ["--timeout=-1s"],
      ["--args-file", "missing.json"],
    ]) {
      const result = await launch(f.directory, ["run", "entry.mjs", "-e", "local", ...options], "")
        .completed;
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stdout).ok, false);
    }
    const unsupported = await launch(
      f.directory,
      ["find", "users", "-e", "local", "--args", "{}"],
      ""
    ).completed;
    assert.equal(unsupported.status, 1);
    assert.equal(unsupported.stdout, "");
    assert.match(unsupported.stderr, /Unsupported arguments/);
    await assert.rejects(stat(join(f.directory, "daemon")), { code: "ENOENT" });
  } finally {
    await f.cleanup();
  }
});

test("supervisor cancellation removes only a queued caller, stops an active worker without replay, and detaches completed signals", async () => {
  const worker = createWorkerSupervisor(tmpdir(), {
    entrypoint: new URL("./fixtures/worker.mjs", import.meta.url),
    shutdownTimeoutMs: 20,
  });
  try {
    const first = worker.execute({ operation: "list", env: "slow" });
    const queuedSignal = new AbortController();
    const queued = worker.execute(
      { operation: "list", env: "removed" },
      undefined,
      queuedSignal.signal
    );
    const survivor = worker.execute({ operation: "list", env: "survivor" });
    await waitFor(async () => worker.status().active);
    const pid = worker.status().pid;
    queuedSignal.abort();
    assert.equal(code(await queued), "OperationCancelled");
    assert((await first).ok && (await survivor).ok);
    assert.equal(worker.status().pid, pid);
    const completedSignal = new AbortController();
    assert(
      (
        await worker.execute(
          { operation: "list", env: "completed" },
          undefined,
          completedSignal.signal
        )
      ).ok
    );
    const activeSignal = new AbortController();
    const running = worker.execute({ operation: "list", env: "hang" }, 0, activeSignal.signal);
    const discarded = worker.execute({ operation: "list", env: "discarded" });
    await waitFor(async () => worker.status().active);
    completedSignal.abort();
    assert.equal(worker.status().active, true);
    assert.equal(worker.status().pid, pid);
    activeSignal.abort();
    assert.equal(code(await running), "OperationCancelled");
    assert.equal(code(await discarded), "WorkerRestarted");
    const fresh = await worker.execute({ operation: "list", env: "fresh" });
    assert(fresh.ok && "collections" in fresh.data);
    assert.equal(fresh.data.collections[0]?.name, "1");
    assert.notEqual(worker.status().pid, pid);
  } finally {
    await worker.stop();
  }
});

test("daemon disconnect cancels active scripts, discards their queue, recovers without replay, and records sanitized outcomes", async () => {
  const f = await fixture();
  const daemon = await startDaemon(f.directory, { workerEntrypoint });
  try {
    const entry = join(f.directory, "active.mjs");
    const marker = join(f.directory, "marker.txt");
    await writeFile(
      entry,
      `import {appendFile} from 'node:fs/promises';export default async()=>{await appendFile(${JSON.stringify(marker)},'once');await new Promise(r=>setTimeout(r,20000));return true;};`
    );
    const controller = new AbortController();
    const active = executeWithDaemon(
      f.directory,
      {
        operation: "run",
        env: "local",
        path: entry,
        timeoutMs: 0,
        args: '{"private":"not-history"}',
      },
      controller.signal
    );
    await waitFor(async () => {
      try {
        return (await readFile(marker, "utf8")) === "once";
      } catch {
        return false;
      }
    });
    const queued = executeWithDaemon(f.directory, {
      operation: "run",
      env: "local",
      path: entry,
      timeoutMs: 0,
    });
    await waitFor(async () => (await state(f.directory)).queued === 1);
    const oldPid = (await state(f.directory)).pid;
    controller.abort();
    assert.equal(code(await active), "OperationCancelled");
    assert.equal(code(await queued), "WorkerRestarted");
    await writeFile(join(f.directory, "fresh.mjs"), "export default async()=>true;");
    assert.equal(
      value(
        await executeWithDaemon(f.directory, {
          operation: "run",
          env: "local",
          path: join(f.directory, "fresh.mjs"),
          timeoutMs: 0,
        })
      ),
      true
    );
    assert.notEqual((await state(f.directory)).pid, oldPid);
    assert.equal(await readFile(marker, "utf8"), "once");
    const entries = await readHistory(f.directory);
    assert.equal(entries.length, 3);
    assert(
      entries.some((e) => e.outcome.status === "error" && e.outcome.code === "OperationCancelled")
    );
    assert(!JSON.stringify(entries).includes("not-history"));
    assert(!JSON.stringify(entries).includes("active.mjs"));
  } finally {
    await daemon.stop();
    await f.cleanup();
  }
});

test("daemon queued cancellation preserves the active script and its warm module", async () => {
  const f = await fixture();
  const daemon = await startDaemon(f.directory, { workerEntrypoint });
  try {
    const path = join(f.directory, "warm.mjs");
    await writeFile(
      path,
      "let calls=0;export default async()=>{await new Promise(r=>setTimeout(r,150));return ++calls;};"
    );
    const request = { operation: "run", env: "local", path, timeoutMs: 0 };
    const active = executeWithDaemon(f.directory, request);
    await waitFor(async () => (await state(f.directory)).active);
    const pid = (await state(f.directory)).pid;
    const controller = new AbortController();
    const queued = executeWithDaemon(f.directory, request, controller.signal);
    await waitFor(async () => (await state(f.directory)).queued === 1);
    controller.abort();
    assert.equal(code(await queued), "OperationCancelled");
    await waitFor(async () => (await state(f.directory)).queued === 0);
    assert.deepEqual(value(await active), { $numberInt: "1" });
    assert.deepEqual(value(await executeWithDaemon(f.directory, request)), { $numberInt: "2" });
    assert.equal((await state(f.directory)).pid, pid);
  } finally {
    await daemon.stop();
    await f.cleanup();
  }
});

test("SIGINT/SIGTERM cancel attached CLI scripts; forced CLI death also stops active work", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX signal lifecycle; native Windows remains unvalidated");
    return;
  }
  const f = await fixture();
  const daemon = await startDaemon(f.directory, { workerEntrypoint });
  try {
    for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"] as const) {
      const marker = join(f.directory, `${signal}.txt`);
      const path = join(f.directory, `${signal}.mjs`);
      await writeFile(
        path,
        `import {writeFile} from 'node:fs/promises';export default async()=>{await writeFile(${JSON.stringify(marker)},'started');await new Promise(r=>setTimeout(r,20000));};`
      );
      const command = launch(f.directory, ["run", path, "-e", "local", "--timeout", "0"], "");
      try {
        await waitFor(async () => {
          try {
            await stat(marker);
            return true;
          } catch {
            return false;
          }
        });
        const oldPid = (await state(f.directory)).pid;
        command.child.kill(signal);
        const result = await command.completed;
        if (signal === "SIGKILL") assert.equal(result.signal, "SIGKILL");
        else {
          assert.equal(result.status, signal === "SIGINT" ? 130 : 143);
          assert.equal(code(JSON.parse(result.stdout) as DaemonResponse), "OperationCancelled");
        }
        await waitFor(async () => !(await state(f.directory)).active);
        await writeFile(join(f.directory, "signal-fresh.mjs"), "export default async()=>true;");
        const recovered = await launch(f.directory, ["run", "signal-fresh.mjs", "-e", "local"], "")
          .completed;
        assert.equal(recovered.status, 0);
        assert.notEqual((await state(f.directory)).pid, oldPid);
      } finally {
        await finish(command.child);
      }
    }
  } finally {
    await daemon.stop();
    await f.cleanup();
  }
});

test("blocked stdin reads can be interrupted without dispatching a script", async (t) => {
  const stdin = new Readable({ read() {} });
  const controller = new AbortController();
  const reading = readQueryInput("-", stdin, controller.signal);
  controller.abort();
  await assert.rejects(reading, (e) => e instanceof QueryError && e.code === "OperationCancelled");
  assert.equal(stdin.destroyed, true);
  if (process.platform === "win32") {
    t.skip("CLI signal check requires POSIX");
    return;
  }
  const f = await fixture();
  const command = launch(f.directory, ["run", "unused.mjs", "-e", "local", "--args-file", "-"]);
  try {
    await delay(250);
    command.child.kill("SIGINT");
    const result = await command.completed;
    assert.equal(result.status, 130);
    assert.equal(code(JSON.parse(result.stdout) as DaemonResponse), "OperationCancelled");
    await assert.rejects(stat(join(f.directory, "daemon")), { code: "ENOENT" });
  } finally {
    await finish(command.child);
    await f.cleanup();
  }
});
