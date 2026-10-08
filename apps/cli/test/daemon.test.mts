import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { emptyCatalog } from "../dist/catalog.js";
import { daemonCommand, daemonExchange, executeWithDaemon } from "../dist/daemon-client.js";
import type { DaemonResponse } from "../dist/daemon-protocol.js";
import { startDaemon } from "../dist/daemon-server.js";
import {
  packageVersion,
  readDaemonState,
  runtimeDirectory,
  socketPath,
  writeDaemonState,
} from "../dist/daemon-state.js";
import { readFrame } from "../dist/daemon-frame.js";

const workerEntrypoint = new URL("./fixtures/worker.mjs", import.meta.url);
const executable = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
async function fixture(idleTimeoutMs = 300000) {
  const directory = await mkdtemp(join(tmpdir(), "runnel-daemon-"));
  await writeFile(
    join(directory, "catalog.json"),
    JSON.stringify({ ...emptyCatalog(), settings: { idleTimeoutMs, scriptTimeoutMs: 300000 } })
  );
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}
function status(result: DaemonResponse) {
  assert(result.ok && "running" in result.data && result.data.running);
  return result.data;
}
function errorCode(result: DaemonResponse) {
  assert(!result.ok);
  return result.error.code;
}
async function run(directory: string, args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [executable, ...args], {
        env: { ...process.env, RUNNEL_HOME: directory },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (value: Buffer) => {
        stdout += value.toString();
      });
      child.stderr.on("data", (value: Buffer) => {
        stderr += value.toString();
      });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
    }
  );
}

test("offline lifecycle commands and missing environment do not start or create a daemon", async () => {
  const directory = join(tmpdir(), `runnel-absent-${process.pid}-${Date.now()}`);
  try {
    for (const action of ["status", "reset", "stop"] as const) {
      const result = await run(directory, ["daemon", action]);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { ok: true, data: { running: false } });
    }
    const missing = await run(directory, ["list"]);
    assert.equal(missing.status, 1);
    assert.equal(JSON.parse(missing.stdout).error.code, "EnvironmentRequired");
    await assert.rejects(stat(directory), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("daemon authenticates private requests, retains a worker, resets and shuts down cleanly", async () => {
  const { directory, cleanup } = await fixture();
  const daemon = await startDaemon(directory, { workerEntrypoint });
  try {
    assert.equal(status(await daemonCommand(directory, "status")).worker.state, "idle");
    const denied = await daemonExchange(
      { ...daemon.descriptor, token: "0".repeat(64) },
      { action: "reset" }
    );
    assert.equal(errorCode(denied), "DaemonAuthenticationFailed");
    const first = await executeWithDaemon(directory, { operation: "list", env: "first" });
    assert(first.ok && "collections" in first.data);
    const pid = status(await daemonCommand(directory, "status")).worker.pid;
    await executeWithDaemon(directory, { operation: "list", env: "second" });
    assert.equal(status(await daemonCommand(directory, "status")).worker.pid, pid);
    assert.deepEqual(await daemonCommand(directory, "reset"), { ok: true, data: { reset: true } });
    await executeWithDaemon(directory, { operation: "list", env: "fresh" });
    assert.notEqual(status(await daemonCommand(directory, "status")).worker.pid, pid);
    const metadata = await readFile(join(directory, "daemon", "daemon.json"), "utf8");
    assert(!metadata.includes("synthetic-uri"));
    if (process.platform !== "win32") {
      assert.equal((await stat(join(directory, "daemon"))).mode & 0o777, 0o700);
      assert.equal((await stat(join(directory, "daemon", "daemon.json"))).mode & 0o777, 0o600);
      assert.equal((await stat(daemon.descriptor.endpoint)).mode & 0o777, 0o600);
    }
    assert.deepEqual(await daemonCommand(directory, "stop"), { ok: true, data: { stopped: true } });
    await daemon.closed;
    assert.equal(await readDaemonState(directory), undefined);
  } finally {
    await daemon.stop();
    await cleanup();
  }
});
test("idle shutdown waits for active and queued work and status does not keep it alive", async () => {
  const { directory, cleanup } = await fixture(100);
  const daemon = await startDaemon(directory, { workerEntrypoint });
  try {
    const first = daemonExchange(daemon.descriptor, {
      action: "execute",
      request: { operation: "list", env: "slow" },
    });
    const second = daemonExchange(daemon.descriptor, {
      action: "execute",
      request: { operation: "list", env: "slow" },
    });
    await delay(180);
    assert(status(await daemonCommand(directory, "status")).worker.active);
    assert((await first).ok);
    assert((await second).ok);
    for (let attempt = 0; attempt < 20 && (await readDaemonState(directory)); attempt++) {
      await daemonCommand(directory, "status");
      await delay(20);
    }
    await daemon.closed;
    assert.equal(await readDaemonState(directory), undefined);
  } finally {
    await daemon.stop();
    await cleanup();
  }
});
test("reset fails attached active and queued clients without replay", async () => {
  const { directory, cleanup } = await fixture();
  const daemon = await startDaemon(directory, { workerEntrypoint });
  try {
    const first = daemonExchange(daemon.descriptor, {
      action: "execute",
      request: { operation: "list", env: "hang" },
    });
    const second = daemonExchange(daemon.descriptor, {
      action: "execute",
      request: { operation: "list", env: "queued" },
    });
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = status(await daemonCommand(directory, "status"));
      if (current.worker.active && current.worker.queued === 1) break;
      await delay(5);
    }
    assert.deepEqual(await daemonCommand(directory, "reset"), { ok: true, data: { reset: true } });
    assert.equal(errorCode(await first), "WorkerRestarted");
    assert.equal(errorCode(await second), "WorkerRestarted");
    const result = await executeWithDaemon(directory, { operation: "list", env: "fresh" });
    assert(result.ok && "collections" in result.data);
    assert.equal(result.data.collections[0]?.name, "1");
  } finally {
    await daemon.stop();
    await cleanup();
  }
});
test("concurrent CLI startup converges on one detached daemon and worker", async () => {
  const { directory, cleanup } = await fixture();
  try {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => run(directory, ["list", "-e", "unknown"]))
    );
    for (const result of results) {
      assert.equal(result.status, 1, result.stderr);
      assert.equal(JSON.parse(result.stdout).error.code, "EnvironmentNotFound");
      assert.equal(result.stderr, "");
    }
    const current = status(await daemonCommand(directory, "status"));
    assert(current.pid !== process.pid);
    assert(current.worker.pid);
    const later = await run(directory, ["list", "-e", "unknown"]);
    assert.equal(later.status, 1);
    const repeated = status(await daemonCommand(directory, "status"));
    assert.equal(repeated.pid, current.pid);
    assert.equal(repeated.worker.pid, current.worker.pid);
  } finally {
    await daemonCommand(directory, "stop");
    await delay(100);
    await cleanup();
  }
});
test("corrupt or insecure metadata is rejected without replacement or startup", async () => {
  const { directory, cleanup } = await fixture();
  const daemon = await startDaemon(directory, { workerEntrypoint });
  try {
    const metadata = join(directory, "daemon", "daemon.json");
    const original = await readFile(metadata, "utf8");
    await writeFile(metadata, "synthetic-secret-invalid");
    const result = await executeWithDaemon(directory, { operation: "list", env: "x" });
    assert.equal(errorCode(result), "DaemonUnavailable");
    assert(!JSON.stringify(result).includes("synthetic-secret"));
    assert.equal(await readFile(metadata, "utf8"), "synthetic-secret-invalid");
    await writeFile(metadata, original);
    if (process.platform !== "win32") {
      await chmod(metadata, 0o644);
      await assert.rejects(readDaemonState(directory));
      await chmod(metadata, 0o600);
    }
  } finally {
    await daemon.stop();
    await cleanup();
  }
});
test("long catalog paths use a bounded socket path", () => {
  const socket = socketPath(join(tmpdir(), "x".repeat(200), "daemon"), "a".repeat(36));
  if (process.platform !== "win32") assert(Buffer.byteLength(socket) < 100);
  else assert(socket.startsWith("\\\\.\\pipe\\runnel-"));
});

test("a lost result reports an unknown outcome and never replays the submitted request", async () => {
  const { directory, cleanup } = await fixture();
  const runtime = await runtimeDirectory(directory, true);
  const instance = "a".repeat(36);
  const descriptor = {
    protocol: 1 as const,
    instance,
    endpoint: socketPath(runtime, instance),
    token: "1".repeat(64),
    pid: process.pid,
    version: packageVersion(),
  };
  let executions = 0;
  let environment: unknown;
  const server = createServer((socket) => {
    socket.on("error", () => {});
    void readFrame(socket)
      .then(async (input) => {
        const command = input as { action: string; request?: { env?: string } };
        if (command.action === "status") {
          await delay(30);
          socket.end(
            `${JSON.stringify({ ok: true, data: { running: true, pid: process.pid, version: packageVersion(), worker: { state: "idle", active: false, queued: 0 } } })}\n`
          );
        } else {
          executions++;
          environment = command.request?.env;
          socket.destroy();
        }
      })
      .catch(() => socket.destroy());
  });
  try {
    await new Promise<void>((resolve) => server.listen(descriptor.endpoint, resolve));
    if (process.platform !== "win32") await chmod(descriptor.endpoint, 0o600);
    await writeDaemonState(runtime, descriptor);
    const request = { operation: "list", env: "original" };
    const pending = executeWithDaemon(directory, request);
    request.env = "mutated";
    const result = await pending;
    assert.equal(errorCode(result), "OperationOutcomeUnknown");
    assert.equal(executions, 1);
    assert.equal(environment, "original");
    assert(!JSON.stringify(result).includes(descriptor.token));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup();
  }
});

test("incompatible daemon versions refuse database work while lifecycle commands remain usable", async () => {
  const { directory, cleanup } = await fixture();
  const daemon = await startDaemon(directory, { workerEntrypoint });
  try {
    await writeDaemonState(await runtimeDirectory(directory), {
      ...daemon.descriptor,
      version: "0.0.42",
    });
    assert.equal(
      errorCode(await executeWithDaemon(directory, { operation: "list", env: "x" })),
      "DaemonVersionMismatch"
    );
    assert.equal(status(await daemonCommand(directory, "status")).worker.state, "idle");
    assert.deepEqual(await daemonCommand(directory, "reset"), { ok: true, data: { reset: true } });
    assert.equal(
      errorCode(await executeWithDaemon(directory, { operation: "invalid" })),
      "RequestInvalid"
    );
  } finally {
    await daemon.stop();
    await cleanup();
  }
});
