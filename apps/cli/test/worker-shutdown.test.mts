import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { lock } from "proper-lockfile";
import { emptyCatalog } from "../dist/catalog.js";
import { daemonCommand, daemonExchange } from "../dist/daemon-client.js";
import { startDaemon } from "../dist/daemon-server.js";
import { createWorkerSupervisor } from "../dist/worker-supervisor.js";

const entrypoint = new URL("./fixtures/shutdown-worker.mjs", import.meta.url);
async function fixture(t: TestContext, mode: string, grace = 350) {
  const home = await mkdtemp(join(tmpdir(), "runnel-shutdown-"));
  await writeFile(join(home, "mode"), mode);
  const worker = createWorkerSupervisor(home, {
    entrypoint,
    startupTimeoutMs: 3000,
    shutdownTimeoutMs: grace,
  });
  t.after(async () => {
    await worker.stop();
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    worker,
    events: async () => {
      try {
        return (await readFile(join(home, "events"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { pid: number; event: string });
      } catch {
        return [];
      }
    },
  };
}
async function active(worker: ReturnType<typeof createWorkerSupervisor>) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (worker.status().active) return;
    await delay(5);
  }
  assert.fail("Worker never became active");
}
const exited = (pid: number | undefined) => {
  assert(pid);
  assert.throws(() => process.kill(pid, 0));
};

test("normal teardown waits close acknowledgement and actual exit; repeated stop shares the result", async (t) => {
  const f = await fixture(t, "slow-close");
  assert((await f.worker.execute({ operation: "inspect", uri: "synthetic" })).ok);
  const pid = f.worker.status().pid;
  const first = f.worker.stop(),
    again = f.worker.stop();
  assert.equal(first, again);
  assert.equal(f.worker.status().state, "stopping");
  let finished = false;
  void first.then(() => {
    finished = true;
  });
  await delay(50);
  assert.equal(finished, false);
  assert.deepEqual(await first, { mode: "graceful", acknowledged: true });
  exited(pid);
  assert.equal(f.worker.status().state, "stopped");
  assert.equal(f.worker.status().pid, undefined);
});

test("an acknowledgement alone, failed close or nonzero exit never proves graceful teardown", async (t) => {
  for (const [mode, expected, ack] of [
    ["ack-hang", "forced", true],
    ["duplicate-ack", "forced", true],
    ["no-ack", "forced", false],
    ["wrong-ack", "forced", false],
    ["malformed-ack", "forced", false],
    ["disconnect", "forced", false],
    ["close-failed", "unconfirmed", true],
    ["ack-exit-error", "unconfirmed", true],
  ] as const) {
    const f = await fixture(t, mode, 80);
    await f.worker.execute({ operation: "inspect", uri: "synthetic" });
    const pid = f.worker.status().pid,
      start = performance.now();
    assert.deepEqual(await f.worker.stop(), { mode: expected, acknowledged: ack }, mode);
    assert(performance.now() - start < 1500, mode);
    exited(pid);
  }
});

test("reset fences late results, fails active and queued once, then admits only new work", async (t) => {
  const f = await fixture(t, "late-result");
  const first = f.worker.execute({ operation: "list", env: "hang" }, 0);
  const queued = f.worker.execute({ operation: "list", env: "queued" });
  await active(f.worker);
  const pid = f.worker.status().pid;
  let deliveries = 0;
  void first.then(() => {
    deliveries++;
  });
  void queued.then(() => {
    deliveries++;
  });
  const reset = f.worker.reset();
  const refused = await f.worker.execute({ operation: "list", env: "during-reset" });
  assert(!refused.ok && refused.error.code === "WorkerRestarting");
  assert.deepEqual(await reset, { mode: "graceful", acknowledged: true });
  for (const result of await Promise.all([first, queued])) {
    assert(!result.ok);
    assert.equal(result.error.code, "WorkerRestarted");
    assert.match(result.error.message, /writes may already/);
  }
  assert.equal(deliveries, 2);
  exited(pid);
  await f.worker.execute({ operation: "inspect", uri: "synthetic" });
  assert.notEqual(f.worker.status().pid, pid);
  assert.equal((await f.events()).filter((e) => e.event === "execute").length, 2);
});

test("startup/stop/reset races settle every queued request without dispatch or later revival", async (t) => {
  const f = await fixture(t, "slow-ready", 1000);
  const queued = f.worker.execute({ operation: "list", env: "never-dispatched" });
  const reset = f.worker.reset();
  const stop = f.worker.stop();
  assert.equal(reset, stop);
  const request = await queued;
  assert(!request.ok && request.error.code === "WorkerRestarted");
  assert.deepEqual(await stop, { mode: "graceful", acknowledged: true });
  assert.equal(f.worker.status().state, "stopped");
  const rejected = await f.worker.execute({ operation: "list" });
  assert(!rejected.ok && rejected.error.code === "WorkerStopped");
  assert.equal((await f.events()).filter((e) => e.event === "execute").length, 0);
});

test("deadline and abort force the owned worker, fail queues once and never request graceful cleanup", async (t) => {
  for (const kind of ["deadline", "abort"] as const) {
    const f = await fixture(t, "slow-close");
    const controller = new AbortController();
    const first = f.worker.execute(
      { operation: "list", env: "hang" },
      kind === "deadline" ? 30 : 0,
      controller.signal
    );
    const queued = f.worker.execute({ operation: "list", env: "queued" });
    await active(f.worker);
    const pid = f.worker.status().pid;
    if (kind === "abort") controller.abort();
    const result = await first;
    assert(!result.ok);
    assert.equal(
      result.error.code,
      kind === "deadline" ? "OperationTimedOut" : "OperationCancelled"
    );
    assert.match(result.error.message, /writes may already/);
    const second = await queued;
    assert(!second.ok && second.error.code === "WorkerRestarted");
    assert.equal((await f.worker.stop()).mode, "forced");
    exited(pid);
    assert.equal((await f.events()).filter((e) => e.event === "shutdown").length, 0);
  }
});

test("slow worker close and a held history lock preserve responses before daemon stop acknowledgement", {
  timeout: 7000,
}, async (t) => {
  const f = await fixture(t, "daemon-close");
  await writeFile(join(f.home, "catalog.json"), JSON.stringify(emptyCatalog()));
  const daemon = await startDaemon(f.home, { workerEntrypoint: entrypoint });
  t.after(() => daemon.stop());
  assert(
    (
      await daemonExchange(daemon.descriptor, {
        action: "execute",
        request: { operation: "list", env: "initial" },
      })
    ).ok
  );
  const release = await lock(join(f.home, "history", "entries.json"), { realpath: false });
  try {
    const first = daemonExchange(daemon.descriptor, {
      action: "execute",
      request: { operation: "list", env: "hang" },
    });
    const queued = daemonExchange(daemon.descriptor, {
      action: "execute",
      request: { operation: "list", env: "queued" },
    });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const status = await daemonCommand(f.home, "status");
      if (
        status.ok &&
        "worker" in status.data &&
        status.data.worker.active &&
        status.data.worker.queued === 1
      )
        break;
      await delay(5);
    }
    const start = performance.now();
    assert.deepEqual(await daemonCommand(f.home, "stop"), { ok: true, data: { stopped: true } });
    assert(performance.now() - start >= 1500);
    for (const result of await Promise.all([first, queued])) {
      assert(!result.ok && result.error.code === "WorkerStopped");
      assert("warning" in result && result.warning === "HistoryUnavailable");
    }
    await daemon.closed;
    assert.equal((await f.events()).filter((e) => e.event === "execute").length, 2);
  } finally {
    await release();
    await daemon.stop();
  }
});
