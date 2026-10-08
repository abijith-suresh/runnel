import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { lock } from "proper-lockfile";
import { decodeCatalog, emptyCatalog } from "../dist/catalog.js";
import { daemonCommand, daemonExchange } from "../dist/daemon-client.js";
import { decodeDaemonResponse } from "../dist/daemon-protocol.js";
import { startDaemon } from "../dist/daemon-server.js";
import {
  appendHistory,
  createOperationHistory,
  type HistoryEntry,
  HistoryError,
  historyMaximumBytes,
  historyMaximumEntries,
  readHistory,
} from "../dist/history.js";
import { failure, type WorkerResult } from "../dist/worker-protocol.js";

const executable = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const workerEntrypoint = new URL("./fixtures/worker.mjs", import.meta.url);
const entry = (durationMs = 5): HistoryEntry => ({
  timestamp: "2026-10-08T00:00:00.000Z",
  durationMs,
  operation: "find",
  targets: { env: "local", db: "accounts", connection: "primary" },
  outcome: { status: "success" },
});
const catalog = () => ({
  ...emptyCatalog(),
  environments: {
    local: {
      connections: {
        primary: { provider: "mongodb", secretRef: "keyring:runnel/synthetic-secret-reference" },
      },
      databases: { accounts: { connection: "primary", database: "synthetic_physical_database" } },
    },
    hang: {
      connections: {
        primary: { provider: "mongodb", secretRef: "keyring:runnel/synthetic-secret-reference" },
      },
      databases: { accounts: { connection: "primary", database: "synthetic_physical_database" } },
    },
  },
});
async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), "runnel-history-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return { home, path: join(home, "history", "entries.json") };
}
const success: WorkerResult = {
  ok: true,
  data: {
    env: "local",
    db: "accounts",
    count: 1,
    collection: "private-collection-argument",
    format: "json",
  },
};

test("missing history inspection creates no directories, daemon, or catalog", async (t) => {
  const { home } = await fixture(t);
  const absent = join(home, "absent");
  assert.deepEqual(await readHistory(absent), []);
  const result = spawnSync(process.execPath, [executable, "history"], {
    env: { ...process.env, RUNNEL_HOME: absent },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    data: { entries: [], limits: { entries: historyMaximumEntries, bytes: historyMaximumBytes } },
  });
  await assert.rejects(stat(absent), { code: "ENOENT" });
});
test("atomic history appends serialize concurrent writers and return newest entries first with private permissions", async (t) => {
  const { home, path } = await fixture(t);
  await Promise.all(Array.from({ length: 8 }, (_, index) => appendHistory(home, entry(index))));
  const records = await readHistory(home);
  assert.equal(records.length, 8);
  assert.deepEqual(
    records.map((item) => item.durationMs).sort((a, b) => a - b),
    [0, 1, 2, 3, 4, 5, 6, 7]
  );
  await appendHistory(home, entry(99));
  assert.equal((await readHistory(home))[0]?.durationMs, 99);
  const raw = JSON.parse(await readFile(path, "utf8"));
  assert.equal(raw.entries.at(-1).durationMs, 99);
  assert.deepEqual(await readdir(join(home, "history")), ["entries.json"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, "history"))).mode & 0o777, 0o700);
  }
});
test("retention evicts oldest entries and never exceeds entry or byte limits", async (t) => {
  const { home, path } = await fixture(t);
  await appendHistory(home, entry());
  await writeFile(
    path,
    JSON.stringify({
      schemaVersion: 1,
      entries: Array.from({ length: historyMaximumEntries }, (_, index) => entry(index)),
    })
  );
  await appendHistory(home, entry(2000));
  const records = await readHistory(home);
  assert.equal(records.length, historyMaximumEntries);
  assert.equal(records[0]?.durationMs, 2000);
  assert.equal(records.at(-1)?.durationMs, 1);
  assert((await stat(path)).size < historyMaximumBytes);
});
test("history refuses malformed records and retains corrupt files without exposing their contents", async (t) => {
  const { home, path } = await fixture(t);
  await appendHistory(home, entry());
  for (const value of [
    { ...entry(), arguments: "private-filter" },
    { ...entry(), durationMs: -1 },
    { ...entry(), timestamp: "not-a-date" },
    { ...entry(), timestamp: "2026-02-30T00:00:00.000Z" },
    { ...entry(), targets: { env: "mongodb://synthetic-uri" } },
    { ...entry(), targets: { env: "constructor" } },
    { ...entry(), outcome: { status: "error", code: "PrivateDocument" } },
    { ...entry(), outcome: { status: "error", code: "QueryInvalid", message: "private-document" } },
  ])
    await assert.rejects(appendHistory(home, value as unknown as HistoryEntry), HistoryError);
  assert.equal((await readHistory(home)).length, 1);
  const secret = "synthetic-private-document";
  for (const raw of [
    secret,
    JSON.stringify({ schemaVersion: 2, entries: [] }),
    JSON.stringify({ schemaVersion: 1, entries: [entry()], secret }),
    "x".repeat(historyMaximumBytes + 1),
  ]) {
    await writeFile(path, raw);
    await assert.rejects(
      readHistory(home),
      (error: unknown) => error instanceof HistoryError && !error.message.includes(secret)
    );
    await assert.rejects(appendHistory(home, entry()), HistoryError);
    assert.equal(await readFile(path, "utf8"), raw);
  }
});
test("history refuses nonregular files, symlinks, hardlinks, and insecure files", async (t) => {
  const { home, path } = await fixture(t);
  await appendHistory(home, entry());
  const original = await readFile(path, "utf8");
  await rm(path);
  await mkdir(path);
  await assert.rejects(readHistory(home), HistoryError);
  await assert.rejects(appendHistory(home, entry()), HistoryError);
  await rm(path, { recursive: true });
  const other = join(home, "other.json");
  await writeFile(other, original, { mode: 0o600 });
  await link(other, path);
  await assert.rejects(readHistory(home), HistoryError);
  await assert.rejects(appendHistory(home, entry()), HistoryError);
  await rm(path);
  if (process.platform !== "win32") {
    await symlink(other, path);
    await assert.rejects(readHistory(home), HistoryError);
    await assert.rejects(appendHistory(home, entry()), HistoryError);
    await rm(path);
    execFileSync("mkfifo", [path]);
    await assert.rejects(readHistory(home), HistoryError);
    await assert.rejects(appendHistory(home, entry()), HistoryError);
    await rm(path);
    await writeFile(path, original, { mode: 0o644 });
    await assert.rejects(readHistory(home), HistoryError);
    await assert.rejects(appendHistory(home, entry()), HistoryError);
    await chmod(path, 0o600);
    await chmod(join(home, "history"), 0o755);
    await assert.rejects(readHistory(home), HistoryError);
  }
});
test("busy history locks fail safely without changing prior entries", async (t) => {
  const { home, path } = await fixture(t);
  await appendHistory(home, entry());
  const release = await lock(path, { realpath: false });
  try {
    await assert.rejects(appendHistory(home, entry(99)), HistoryError);
  } finally {
    await release();
  }
  assert.equal((await readHistory(home)).length, 1);
});
test("recording uses configured names and allowlisted outcome codes without argument, collection, document, or secret data", async (t) => {
  const { home, path } = await fixture(t);
  await writeFile(join(home, "catalog.json"), JSON.stringify(catalog()));
  const results: WorkerResult[] = [
    success,
    failure("QueryInvalid", "private-filter/result-documents"),
    failure("PrivateDocument", "private-result"),
    success,
  ];
  const history = createOperationHistory(home, { execute: async () => results.shift() ?? success });
  const args = {
    operation: "find",
    env: "local",
    collection: "private-collection-argument",
    filter: '{"secret":"private-filter"}',
    projection: '{"private-projection":1}',
  };
  await history.execute(args);
  await history.execute(args);
  await history.execute(args);
  await history.execute({ ...args, env: "private-unknown-env", db: "private-unknown-db" });
  await history.flush();
  const entries = await readHistory(home);
  assert.equal(entries.length, 4);
  assert.deepEqual(entries[0]?.targets, {});
  assert.deepEqual(entries[1]?.outcome, { status: "error", code: "OperationFailed" });
  assert.deepEqual(entries[2]?.outcome, { status: "error", code: "QueryInvalid" });
  assert.deepEqual(entries[3]?.targets, { env: "local", db: "accounts", connection: "primary" });
  for (const item of entries) {
    assert(item.durationMs >= 0);
    assert.equal(new Date(item.timestamp).toISOString(), item.timestamp);
  }
  const raw = await readFile(path, "utf8");
  assert(!raw.includes("private"));
  assert(!raw.includes("synthetic-secret"));
  assert(!raw.includes("physical"));
});
test("explicit opt-out is honored on newly submitted operations and inspect/invalid requests are never recorded", async (t) => {
  const { home } = await fixture(t);
  const file = join(home, "catalog.json");
  await writeFile(
    file,
    JSON.stringify({ ...catalog(), settings: { ...catalog().settings, historyEnabled: false } })
  );
  const history = createOperationHistory(home, { execute: async () => success });
  assert.deepEqual(
    await history.execute({ operation: "count", env: "local", collection: "users" }),
    { result: success, historyFailed: false }
  );
  assert.deepEqual(await readHistory(home), []);
  await writeFile(file, JSON.stringify(catalog()));
  await history.execute({ operation: "inspect", uri: "mongodb://synthetic-sensitive-uri" });
  await history.execute({ operation: "invalid", secret: "synthetic-sensitive-value" });
  assert.deepEqual(await readHistory(home), []);
  await history.execute({ operation: "list", env: "local" });
  assert.equal((await readHistory(home)).length, 1);
  const invalid = await Effect.runPromise(
    decodeCatalog({
      ...catalog(),
      settings: { ...catalog().settings, historyEnabled: "false" },
    }).pipe(Effect.result)
  );
  assert(Result.isFailure(invalid));
});
test("history persistence failures preserve both successful and failed operation results", async (t) => {
  const { home, path } = await fixture(t);
  await writeFile(join(home, "catalog.json"), JSON.stringify(catalog()));
  await appendHistory(home, entry());
  await writeFile(path, "synthetic-corrupt-secret");
  for (const result of [success, failure("PermissionDenied", "synthetic-private-error")]) {
    const history = createOperationHistory(home, { execute: async () => result });
    assert.deepEqual(await history.execute({ operation: "list", env: "local" }), {
      result,
      historyFailed: true,
    });
    await history.flush();
  }
  assert.equal(await readFile(path, "utf8"), "synthetic-corrupt-secret");
  assert.doesNotThrow(() => decodeDaemonResponse({ ...success, warning: "HistoryUnavailable" }));
  assert.throws(() => decodeDaemonResponse({ ...success, warning: "synthetic-secret" }));
});
test("daemon records one entry per operation through reset and stop, without logging setup or lifecycle work", async (t) => {
  const { home } = await fixture(t);
  await writeFile(join(home, "catalog.json"), JSON.stringify(catalog()));
  const daemon = await startDaemon(home, { workerEntrypoint });
  try {
    const first = daemonExchange(daemon.descriptor, {
      action: "execute",
      request: { operation: "list", env: "hang" },
    });
    const second = daemonExchange(daemon.descriptor, {
      action: "execute",
      request: { operation: "list", env: "local" },
    });
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = await daemonCommand(home, "status");
      if (
        status.ok &&
        "worker" in status.data &&
        status.data.worker.active &&
        status.data.worker.queued === 1
      )
        break;
      await delay(5);
    }
    await daemonCommand(home, "reset");
    assert(!(await first).ok);
    assert(!(await second).ok);
    const records = await readHistory(home);
    assert.equal(records.length, 2);
    assert(
      records.every(
        (item) => item.outcome.status === "error" && item.outcome.code === "WorkerRestarted"
      )
    );
    await daemonCommand(home, "status");
    await daemonExchange(daemon.descriptor, {
      action: "execute",
      request: { operation: "inspect", uri: "synthetic-secret-uri" },
    });
    assert.equal((await readHistory(home)).length, 2);
    await daemonCommand(home, "stop");
    await daemon.closed;
    assert.equal((await readHistory(home)).length, 2);
  } finally {
    await daemon.stop();
  }
});
test("CLI reads existing history offline and reports unavailable history with sanitized diagnostics", async (t) => {
  const { home, path } = await fixture(t);
  await appendHistory(home, entry());
  const run = () =>
    spawnSync(process.execPath, [executable, "history"], {
      env: { ...process.env, RUNNEL_HOME: home },
      encoding: "utf8",
    });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).data.entries, [entry()]);
  await assert.rejects(stat(join(home, "daemon")), { code: "ENOENT" });
  await writeFile(path, "synthetic-sensitive-file-content");
  result = run();
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).error.code, "HistoryUnavailable");
  assert(!result.stdout.includes("sensitive"));
});

test("CLI reports history failure on stderr without changing successful database output or exit status", async (t) => {
  const { home, path } = await fixture(t);
  await writeFile(join(home, "catalog.json"), JSON.stringify(catalog()));
  await appendHistory(home, entry());
  await writeFile(path, "synthetic-sensitive-invalid-history");
  const daemon = await startDaemon(home, { workerEntrypoint });
  try {
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn(process.execPath, [executable, "list", "-e", "local"], {
          env: { ...process.env, RUNNEL_HOME: home },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (bytes: Buffer) => {
          stdout += bytes.toString();
        });
        child.stderr.on("data", (bytes: Buffer) => {
          stderr += bytes.toString();
        });
        child.once("error", reject);
        child.once("close", (code) => resolve({ code, stdout, stderr }));
      }
    );
    assert.equal(result.code, 0);
    const response = JSON.parse(result.stdout);
    assert.equal(response.ok, true);
    assert.equal(response.data.collections.length, 1);
    assert.equal(response.warning, "HistoryUnavailable");
    assert.equal(result.stderr, "Cannot save local operation history.\n");
    assert(!result.stdout.includes("sensitive"));
    assert.equal(await readFile(path, "utf8"), "synthetic-sensitive-invalid-history");
  } finally {
    await daemon.stop();
  }
});

test("history snapshots requests and queued reset outcomes while flushing all pending entries", async (t) => {
  const { home } = await fixture(t);
  await writeFile(join(home, "catalog.json"), JSON.stringify(catalog()));
  let finish!: (value: WorkerResult) => void;
  const history = createOperationHistory(home, {
    execute: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const request = { operation: "list", env: "local" };
  const submitted = history.execute(request);
  request.env = "hang";
  finish(failure("WorkerStopped", "synthetic-private-error"));
  await history.flush();
  await submitted;
  assert.deepEqual((await readHistory(home))[0]?.targets, {
    env: "local",
    db: "accounts",
    connection: "primary",
  });
  assert.deepEqual((await readHistory(home))[0]?.outcome, {
    status: "error",
    code: "WorkerStopped",
  });
});

test("a busy history lock preserves all operation results and stop acknowledgement during graceful shutdown", async (t) => {
  for (const mode of ["queued", "completed"]) {
    const { home, path } = await fixture(t);
    await writeFile(join(home, "catalog.json"), JSON.stringify(catalog()));
    await appendHistory(home, entry());
    const original = await readFile(path, "utf8");
    const release = await lock(path, { realpath: false });
    const daemon = await startDaemon(home, { workerEntrypoint });
    try {
      const requests = Array.from({ length: 6 }, (_, index) =>
        daemonExchange(daemon.descriptor, {
          action: "execute",
          request: { operation: "list", env: mode === "queued" && index === 0 ? "hang" : "local" },
        })
      );
      const responses = Promise.allSettled(requests);
      let ready = false;
      let observedWork = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const status = await daemonCommand(home, "status");
        if (status.ok && "worker" in status.data) {
          observedWork ||= status.data.worker.active || status.data.worker.queued > 0;
          ready =
            mode === "queued"
              ? status.data.worker.active && status.data.worker.queued === 5
              : observedWork && !status.data.worker.active && status.data.worker.queued === 0;
          if (ready) break;
        }
        await delay(5);
      }
      assert(ready, `worker did not reach ${mode} state`);
      assert.deepEqual(await daemonCommand(home, "stop"), { ok: true, data: { stopped: true } });
      for (const response of await responses) {
        assert(response.status === "fulfilled", "a completed operation response was lost");
        assert("warning" in response.value && response.value.warning === "HistoryUnavailable");
        if (mode === "completed") assert(response.value.ok);
        else {
          assert(!response.value.ok);
          assert.equal(response.value.error.code, "WorkerStopped");
        }
      }
      await daemon.closed;
      assert.equal(await readFile(path, "utf8"), original);
    } finally {
      await daemon.stop();
      await release();
    }
  }
});
