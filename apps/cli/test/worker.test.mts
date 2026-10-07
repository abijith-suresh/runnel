import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { databaseFailure } from "../dist/worker-operations.js";
import { decodeOperation, type WorkerResult } from "../dist/worker-protocol.js";
import { createWorkerSupervisor } from "../dist/worker-supervisor.js";

const fixture = new URL("./fixtures/worker.mjs", import.meta.url);
function supervisor(directory = tmpdir()) {
  return createWorkerSupervisor(directory, {
    entrypoint: fixture,
    shutdownTimeoutMs: 20,
    startupTimeoutMs: 3000,
  });
}
async function active(worker: ReturnType<typeof supervisor>) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (worker.status().active) return;
    await delay(5);
  }
  assert.fail("worker did not become active");
}
function data(result: WorkerResult) {
  assert(result.ok);
  assert("collections" in result.data);
  return result.data;
}
function code(result: WorkerResult) {
  assert(!result.ok);
  return result.error.code;
}

test("one persistent worker executes queued operations in order without overlap", async () => {
  const worker = supervisor();
  try {
    const requests = ["slow", "second", "third"].map((env) =>
      worker.execute({ operation: "list", env })
    );
    const results = (await Promise.all(requests)).map(data);
    assert.deepEqual(
      results.map((item) => item.db),
      ["slow", "second", "third"]
    );
    assert.deepEqual(
      results.map((item) => item.collections[0]?.name),
      ["1", "2", "3"]
    );
    assert.equal(new Set(results.map((item) => item.env)).size, 1);
    assert.equal(worker.status().active, false);
    assert.equal(worker.status().queued, 0);
  } finally {
    await worker.stop();
  }
});
test("reset fails active and queued work, then starts a new worker without replay", async () => {
  const worker = supervisor();
  try {
    const first = worker.execute({ operation: "list", env: "hang" }, 0);
    const second = worker.execute({ operation: "list", env: "queued" });
    await active(worker);
    const oldPid = worker.status().pid;
    const reset = worker.reset();
    assert.equal(code(await worker.execute({ operation: "list" })), "WorkerRestarting");
    await reset;
    assert.equal(code(await first), "WorkerRestarted");
    assert.equal(code(await second), "WorkerRestarted");
    const result = data(await worker.execute({ operation: "list", env: "fresh" }));
    assert.notEqual(Number(result.env), oldPid);
    assert.equal(result.collections[0]?.name, "1");
  } finally {
    await worker.stop();
  }
});
test("worker crash fails its queue and a later request can start a new worker", async () => {
  const worker = supervisor();
  try {
    const first = worker.execute({ operation: "list", env: "crash" });
    const queued = worker.execute({ operation: "list", env: "queued" });
    assert.equal(code(await first), "WorkerCrashed");
    assert.equal(code(await queued), "WorkerCrashed");
    assert.equal(
      data(await worker.execute({ operation: "list", env: "fresh" })).collections[0]?.name,
      "1"
    );
  } finally {
    await worker.stop();
  }
});
test("active deadlines terminate the worker and discard queued work without retry", async () => {
  const worker = supervisor();
  try {
    const first = worker.execute({ operation: "list", env: "hang" }, 30);
    const queued = worker.execute({ operation: "list", env: "queued" });
    assert.equal(code(await first), "OperationTimedOut");
    assert.equal(code(await queued), "WorkerRestarted");
    assert.equal(
      data(await worker.execute({ operation: "list", env: "fresh" })).collections[0]?.name,
      "1"
    );
  } finally {
    await worker.stop();
  }
});
test("invalid and oversized responses cannot enter application results", async () => {
  const worker = supervisor();
  try {
    for (const env of ["invalid", "oversized"]) {
      assert.equal(code(await worker.execute({ operation: "list", env })), "WorkerProtocolError");
    }
  } finally {
    await worker.stop();
  }
});
test("bounded queue, invalid requests and stopped supervisors fail before dispatch", async () => {
  const worker = supervisor();
  try {
    assert.equal(code(await worker.execute({ operation: "invented" })), "RequestInvalid");
    assert.equal(
      code(await worker.execute({ operation: "inspect", uri: "x".repeat(1024 * 1024) })),
      "RequestInvalid"
    );
    assert.equal(code(await worker.execute({ operation: "list" }, -1)), "RequestInvalid");
    const first = worker.execute({ operation: "list", env: "hang" }, 0);
    await active(worker);
    const queued = Array.from({ length: 32 }, () => worker.execute({ operation: "list" }));
    assert.equal(code(await worker.execute({ operation: "list" })), "QueueFull");
    await worker.stop();
    assert.equal(code(await first), "WorkerStopped");
    assert((await Promise.all(queued)).every((result) => code(result) === "WorkerStopped"));
    assert.equal(code(await worker.execute({ operation: "list" })), "WorkerStopped");
    assert.equal(worker.status().pid, undefined);
    await worker.reset();
    assert.equal(worker.status().state, "stopped");
  } finally {
    await worker.stop();
  }
});
test("startup has a deadline and missing worker entrypoints fail safely", async () => {
  const waiting = createWorkerSupervisor(join(tmpdir(), "no-ready"), {
    entrypoint: fixture,
    startupTimeoutMs: 50,
    shutdownTimeoutMs: 20,
  });
  const missing = createWorkerSupervisor(tmpdir(), {
    entrypoint: new URL("./fixtures/missing.mjs", import.meta.url),
  });
  try {
    assert.equal(code(await waiting.execute({ operation: "list" })), "WorkerUnavailable");
    assert.equal(code(await missing.execute({ operation: "list" })), "WorkerCrashed");
  } finally {
    await waiting.stop();
    await missing.stop();
  }
});
test("real worker resolves configured names before any credential or DB access", async () => {
  const directory = await mkdtemp(join(tmpdir(), "runnel-worker-"));
  const worker = createWorkerSupervisor(directory);
  try {
    assert.equal(code(await worker.execute({ operation: "list" })), "EnvironmentRequired");
    const pid = worker.status().pid;
    assert.equal(
      code(await worker.execute({ operation: "list", env: "unknown" })),
      "EnvironmentNotFound"
    );
    assert.equal(worker.status().pid, pid);
    assert.equal(
      code(await worker.execute({ operation: "inspect", uri: "synthetic-invalid-secret" })),
      "ConnectionInvalid"
    );
    assert.equal(worker.status().pid, pid);
  } finally {
    await worker.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
test("driver failures expose useful categories without driver messages or document dumps", () => {
  for (const [input, expected] of [
    [{ code: 13, message: "synthetic-secret" }, "PermissionDenied"],
    [{ code: 18, message: "synthetic-secret" }, "AuthenticationFailed"],
    [
      Object.assign(new Error("synthetic-secret"), { name: "MongoServerSelectionError" }),
      "DatabaseUnavailable",
    ],
    [new Error("synthetic-secret document dump"), "DatabaseOperationFailed"],
  ] as const) {
    const result = databaseFailure(input);
    assert.equal(code(result), expected);
    assert(!JSON.stringify(result).includes("synthetic-secret"));
  }
  assert.throws(() => decodeOperation({ operation: "list", env: "name", unexpected: true }));
});
