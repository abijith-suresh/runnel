// Runs only after this script and its driver bootstrap are copied into an isolated tarball consumer.
import assert from "node:assert/strict";
import { fork, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const consumer = fileURLToPath(new URL(".", import.meta.url));
const base = new URL("./node_modules/@abijith-suresh/runnel/dist/", import.meta.url);
const { emptyCatalog } = await import(new URL("catalog.js", base));
const { createWorkerSupervisor } = await import(new URL("worker-supervisor.js", base));
const { startDaemon } = await import(new URL("daemon-server.js", base));
const { daemonExchange, daemonCommand } = await import(new URL("daemon-client.js", base));
const driver = new URL("./worker-driver-fixture.mjs", import.meta.url);
const measurements = [];
const runId = Date.now();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
};
function fixture(name, scenario = {}, idleTimeoutMs = 300000) {
  const home = join(consumer, `worker-lifecycle-${runId}-${name}`);
  mkdirSync(home, { mode: 0o700 });
  writeFileSync(join(home, "fixture.json"), JSON.stringify(scenario));
  writeFileSync(
    join(home, "catalog.json"),
    JSON.stringify({
      ...emptyCatalog(),
      settings: { idleTimeoutMs, scriptTimeoutMs: 300000 },
      environments: {
        local: {
          defaultConnection: "primary",
          connections: {
            primary: {
              provider: "mongodb",
              secretRef: "keyring:runnel/synthetic",
              defaultDatabase: "accounts",
            },
          },
          databases: {},
        },
      },
    }),
    { mode: 0o600 }
  );
  const events = () =>
    existsSync(join(home, "driver-events.jsonl"))
      ? readFileSync(join(home, "driver-events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  return { home, events };
}
async function waitFor(probe, message, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (await probe()) return;
    await pause(5);
  }
  assert.fail(message);
}
const list = { operation: "list", env: "local" };
function completeClose(events, pid) {
  const own = events.filter((event) => event.pid === pid);
  const opened = own.filter((event) => event.event === "client-open");
  assert(opened.length > 0, "Production adapter did not create a client");
  for (const event of opened) {
    const start = own.findIndex(
      (item) => item.event === "close-start" && item.client === event.client
    );
    const end = own.findIndex(
      (item) => item.event === "close-complete" && item.client === event.client
    );
    assert(start >= 0 && end > start, "Adapter did not await the synthetic driver's close");
  }
}
async function stopCase(name, scenario, expected) {
  const f = fixture(name, scenario),
    worker = createWorkerSupervisor(f.home, {
      entrypoint: driver,
      shutdownTimeoutMs: scenario.close === "hang" ? 250 : 1000,
      startupTimeoutMs: 5000,
    });
  let pid;
  try {
    assert((await worker.execute(list)).ok);
    pid = worker.status().pid;
    const started = performance.now();
    const outcome = await worker.stop();
    const durationMs = performance.now() - started;
    assert.equal(outcome.mode, expected, JSON.stringify(outcome));
    assert.equal(alive(pid), false, "Stop resolved before the owned worker exited");
    assert.equal(worker.status().pid, undefined);
    assert.equal((await worker.execute(list)).ok, false);
    if (expected === "graceful") {
      assert.equal(outcome.acknowledged, true);
      completeClose(f.events(), pid);
    }
    if (scenario.close === "hang") {
      assert(f.events().some((event) => event.event === "close-start"));
      assert(!f.events().some((event) => event.event === "close-complete"));
      assert(
        durationMs >= 200 && durationMs < 3000,
        "Forced close did not respect its bounded grace window"
      );
    }
    measurements.push({
      case: name,
      pid,
      outcome,
      durationMs,
      ownedWorkersAfter: 0,
      driverEvents: f.events(),
    });
  } finally {
    await worker.stop();
    if (pid) assert(!alive(pid));
  }
}

async function runInstalledLifecycle() {
  {
    const f = fixture("startup-stop"),
      worker = createWorkerSupervisor(f.home, {
        entrypoint: driver,
        shutdownTimeoutMs: 1500,
        startupTimeoutMs: 5000,
      });
    const submitted = worker.execute(list);
    const pid = worker.status().pid;
    const first = worker.stop(),
      second = worker.stop();
    const [outcome, again, result] = await Promise.all([first, second, submitted]);
    assert.deepEqual(again, outcome);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "WorkerStopped");
    assert.equal(outcome.mode, "graceful");
    assert(!alive(pid));
    assert.equal(
      f.events().filter((event) => event.event === "operation-start").length,
      0,
      "Stop during startup admitted queued database work"
    );
    measurements.push({ case: "startup-repeated-stop", outcome, ownedWorkersAfter: 0 });
  }
  await stopCase("normal", {}, "graceful");
  await stopCase("hung-close", { close: "hang" }, "forced");
  await stopCase("failed-close", { close: "reject" }, "unconfirmed");
  {
    const f = fixture("reset"),
      worker = createWorkerSupervisor(f.home, { entrypoint: driver, shutdownTimeoutMs: 500 });
    try {
      assert((await worker.execute(list)).ok);
      const old = worker.status().pid;
      const started = performance.now(),
        outcome = await worker.reset();
      assert.equal(outcome.mode, "graceful");
      assert(!alive(old));
      completeClose(f.events(), old);
      assert((await worker.execute(list)).ok);
      const replacement = worker.status().pid;
      assert.notEqual(replacement, old);
      assert.equal(
        f.events().filter((event) => event.pid === old && event.event === "operation-start").length,
        1
      );
      assert.equal((await worker.stop()).mode, "graceful");
      completeClose(f.events(), replacement);
      measurements.push({
        case: "reset",
        outcome,
        durationMs: performance.now() - started,
        oldPid: old,
        replacementPid: replacement,
        ownedWorkersAfter: 0,
      });
    } finally {
      await worker.stop();
    }
  }
  for (const cancellation of ["deadline", "abort", "stop"]) {
    const f = fixture(`active-${cancellation}`, { operation: "hang" });
    const worker = createWorkerSupervisor(f.home, { entrypoint: driver, shutdownTimeoutMs: 400 });
    const controller = new AbortController();
    try {
      const first = worker.execute(list, cancellation === "deadline" ? 300 : 0, controller.signal);
      const queued = worker.execute(list);
      await waitFor(
        () => f.events().some((event) => event.event === "operation-start"),
        "Real worker did not enter the synthetic active operation"
      );
      const pid = worker.status().pid,
        started = performance.now();
      let outcome;
      if (cancellation === "abort") controller.abort();
      if (cancellation === "stop") outcome = await worker.stop();
      const [result, next] = await Promise.all([first, queued]);
      assert.equal(result.ok, false);
      assert.equal(next.ok, false);
      assert.equal(
        result.error.code,
        cancellation === "deadline"
          ? "OperationTimedOut"
          : cancellation === "abort"
            ? "OperationCancelled"
            : "WorkerStopped"
      );
      assert.equal(
        f.events().filter((event) => event.event === "operation-start").length,
        1,
        "Queued operation was replayed or dispatched during cancellation"
      );
      await worker.stop();
      assert(!alive(pid));
      if (cancellation === "stop") {
        assert.equal(outcome.mode, "graceful");
        completeClose(f.events(), pid);
      }
      measurements.push({
        case: `active-${cancellation}`,
        outcome: outcome ?? { mode: "forced" },
        durationMs: performance.now() - started,
        ownedWorkersAfter: 0,
        driverEvents: f.events(),
      });
    } finally {
      await worker.stop();
    }
  }
  {
    const f = fixture("active-completion", { operation: "slow" });
    const worker = createWorkerSupervisor(f.home, { entrypoint: driver, shutdownTimeoutMs: 500 });
    try {
      assert((await worker.execute(list)).ok);
      const pid = worker.status().pid;
      assert(f.events().some((event) => event.event === "operation-complete"));
      assert.equal((await worker.stop()).mode, "graceful");
      completeClose(f.events(), pid);
      assert(!alive(pid));
    } finally {
      await worker.stop();
    }
  }

  {
    const f = fixture("active-inspection", { operation: "hang" }),
      worker = createWorkerSupervisor(f.home, { entrypoint: driver, shutdownTimeoutMs: 1000 });
    try {
      const pending = worker.execute(
        {
          operation: "inspect",
          uri: "mongodb://synthetic:owned-inspection@fixture.invalid",
          testOnly: true,
        },
        0
      );
      await waitFor(
        () => f.events().some((event) => event.event === "operation-start"),
        "Inspection did not acquire its temporary client"
      );
      const pid = worker.status().pid,
        start = performance.now();
      const outcome = await worker.stop();
      assert.equal(outcome.mode, "graceful");
      assert(!alive(pid));
      completeClose(f.events(), pid);
      assert.equal((await pending).ok, false);
      measurements.push({
        case: "active-temporary-inspection",
        outcome,
        durationMs: performance.now() - start,
        ownedWorkersAfter: 0,
        driverEvents: f.events(),
      });
    } finally {
      await worker.stop();
    }
  }
  async function ownedDaemon(f) {
    const child = fork(fileURLToPath(import.meta.url), ["--daemon"], {
      cwd: consumer,
      env: { ...process.env, RUNNEL_HOME: f.home },
      execArgv: [],
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.stdout.resume();
    const exited = new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal }))
    );
    const descriptor = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Owned installed daemon did not start")),
        10000
      );
      child.once("message", (message) => {
        clearTimeout(timer);
        resolve(message.descriptor);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Owned installed daemon startup failed: " + stderr));
      });
    });
    return {
      child,
      descriptor,
      exited,
      async cleanup() {
        if (child.exitCode === null && child.signalCode === null) {
          if (child.connected) child.send({ type: "stop" });
          const force = setTimeout(() => child.kill("SIGKILL"), 5000);
          try {
            await exited;
          } finally {
            clearTimeout(force);
          }
        }
        assert.equal(stderr, "");
      },
    };
  }
  async function installedCommand(home, action) {
    const launcher = join(consumer, "node_modules/.bin/runnel.cmd");
    const executable = fileURLToPath(new URL("cli.js", base));
    return new Promise((resolve, reject) => {
      const child =
        process.platform === "win32"
          ? spawn(
              "powershell.exe",
              [
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "& $env:RUNNEL_INSTALLED_LAUNCHER daemon $env:RUNNEL_INSTALLED_ACTION; exit $LASTEXITCODE",
              ],
              {
                cwd: consumer,
                env: {
                  ...process.env,
                  RUNNEL_HOME: home,
                  RUNNEL_INSTALLED_LAUNCHER: launcher,
                  RUNNEL_INSTALLED_ACTION: action,
                },
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
              }
            )
          : spawn(process.execPath, [executable, "daemon", action], {
              cwd: consumer,
              env: { ...process.env, RUNNEL_HOME: home },
              windowsHide: true,
              stdio: ["ignore", "pipe", "pipe"],
            });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.stderr.on("data", (data) => {
        stderr += data;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Installed lifecycle command deadline"));
      }, 10000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        try {
          assert.equal(code, 0, stderr || stdout);
          assert.equal(stderr, "");
          resolve(JSON.parse(stdout));
        } catch (error) {
          reject(error);
        }
      });
    });
  }
  {
    const { lock } = await import("proper-lockfile");
    let release;
    const f = fixture("daemon-command"),
      daemon = await ownedDaemon(f);
    try {
      assert((await daemonExchange(daemon.descriptor, { action: "execute", request: list })).ok);
      const initial = await installedCommand(f.home, "status");
      assert(initial.ok && initial.data.worker.pid);
      const old = initial.data.worker.pid,
        resetStart = performance.now();
      assert.deepEqual(await installedCommand(f.home, "reset"), {
        ok: true,
        data: { reset: true },
      });
      assert(!alive(old));
      completeClose(f.events(), old);
      const resetMs = performance.now() - resetStart;
      release = await lock(join(f.home, "history", "entries.json"), { realpath: false });
      const completed = await daemonExchange(daemon.descriptor, {
        action: "execute",
        request: list,
      });
      assert(completed.ok && completed.warning === "HistoryUnavailable");
      const current = await installedCommand(f.home, "status");
      const fresh = current.data.worker.pid;
      assert.notEqual(fresh, old);
      const stopStart = performance.now();
      assert.deepEqual(await installedCommand(f.home, "stop"), {
        ok: true,
        data: { stopped: true },
      });
      const exit = await daemon.exited;
      assert.equal(exit.code, 0);
      assert(!alive(fresh));
      assert(!alive(daemon.child.pid));
      completeClose(f.events(), fresh);
      measurements.push({
        case: "installed-daemon-stop-reset",
        platform: process.platform,
        launcher: process.platform === "win32" ? "PowerShell .cmd" : "installed cli.js",
        resetMs,
        stopToDaemonExitMs: performance.now() - stopStart,
        historyLockHeld: true,
        ownedDaemonAndWorkerBefore: 2,
        ownedDaemonAndWorkerAfter: 0,
      });
    } finally {
      await daemon.cleanup();
      if (release) await release();
    }
  }
  {
    const f = fixture("daemon-idle", {}, 400),
      daemon = await ownedDaemon(f);
    try {
      assert((await daemonExchange(daemon.descriptor, { action: "execute", request: list })).ok);
      const status = await daemonCommand(f.home, "status");
      assert(status.ok && status.data.worker.pid);
      const pid = status.data.worker.pid,
        start = performance.now();
      const polling = setInterval(() => {
        void daemonCommand(f.home, "status");
      }, 20);
      let exit;
      try {
        exit = await daemon.exited;
      } finally {
        clearInterval(polling);
      }
      assert.equal(exit.code, 0);
      assert(!alive(pid));
      assert(!alive(daemon.child.pid));
      completeClose(f.events(), pid);
      measurements.push({
        case: "idle-with-status-polling",
        fixtureIdleTimeoutMs: 400,
        idleToDaemonExitMs: performance.now() - start,
        ownedDaemonAndWorkerBefore: 2,
        ownedDaemonAndWorkerAfter: 0,
      });
    } finally {
      await daemon.cleanup();
    }
  }
  process.stdout.write(
    JSON.stringify({
      fixture: "installed-production-worker-lifecycle",
      platform: process.platform,
      node: process.version,
      methodology:
        "Public installed tarballs, actual production worker.js/workerOperations and MongoDB adapter pool. Bootstrap redirects keyring to synthetic module and replaces MongoClient db/close I/O before importing worker; no native vault or DB connection. JSONL driver markers prove close starts/completes per client and real child IPC plus process liveness checks prove actual exit separately. Durations use performance.now; daemon cases own separate daemon/worker children. Windows CLI commands use actual installed .cmd via PowerShell. Grace-window test override250ms applies only synthetic supervisor; production default remains2000ms. No production performance or live-driver claims.",
      measurements,
    }) + "\nInstalled production worker/adapter graceful and forced lifecycle checks passed\n"
  );
}

if (process.argv[2] === "--daemon") {
  const daemon = await startDaemon(process.env.RUNNEL_HOME, { workerEntrypoint: driver });
  process.send({ type: "ready", descriptor: daemon.descriptor });
  process.on("message", (message) => {
    if (message.type === "stop") void daemon.stop();
  });
  process.on("disconnect", () => void daemon.stop());
  await daemon.closed;
  if (process.connected) process.disconnect();
} else await runInstalledLifecycle();
