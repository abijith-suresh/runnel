// Copied into an isolated tarball consumer. All credentials and providers are synthetic.
import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const base = new URL("./node_modules/@abijith-suresh/runnel/dist/", import.meta.url);
const module = (name) => import(new URL(`${name}.js`, base));
const fixturePath = fileURLToPath(import.meta.url);
const consumerDirectory = fileURLToPath(new URL(".", import.meta.url));
const home = resolve(
  process.env.RUNNEL_HOME ?? fileURLToPath(new URL("./fake-ui-catalog", import.meta.url))
);

assert(
  home.startsWith(`${resolve(consumerDirectory)}${sep}`),
  "Fixtures require an owned consumer catalog"
);

async function fakeWorker() {
  const { credentialStore } = await module("secrets");
  const { workerOperations } = await module("worker-operations");
  const { decodeRequest } = await module("worker-protocol");
  const pool = () => ({
    database: async () => ({
      command: async () => ({ ok: 1 }),
      admin: () => ({
        listDatabases: async () => ({ databases: [{ name: "accounts" }, { name: "reports" }] }),
      }),
    }),
    close: async () => {},
  });
  const operations = workerOperations(
    home,
    pool(),
    credentialStore(async () => ({
      getPassword: async () => "mongodb://synthetic:owned-fixture@fixture.invalid/accounts",
      setPassword: async () => {},
      deleteCredential: async () => true,
    })),
    pool
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await operations.close();
    if (process.connected) process.disconnect();
  };
  process.on("disconnect", () => void stop());
  process.on("SIGTERM", () => void stop());
  process.on("message", async (input) => {
    const message = decodeRequest(input);
    if (message.type === "shutdown") {
      stopping = true;
      await operations.close();
      process.send({ type: "shutdownComplete", id: message.id, closed: true }, () => {
        if (process.connected) process.disconnect();
      });
      return;
    }
    if (stopping) return;
    process.send({
      type: "result",
      id: message.id,
      result: await operations.execute(message.request),
    });
  });
  process.send({ type: "ready" });
}

async function fakeDaemon() {
  const { startDaemon } = await module("daemon-server");
  process.env.RUNNEL_UI_FIXTURE_WORKER = "1";
  const daemon = await startDaemon(home, { workerEntrypoint: new URL(import.meta.url) });
  process.send({ type: "ready", descriptor: daemon.descriptor });
  process.on("message", (message) => {
    if (message.type === "stop") void daemon.stop();
  });
  process.on("disconnect", () => void daemon.stop());
  process.on("SIGTERM", () => void daemon.stop());
  await daemon.closed;
  process.disconnect();
}

export async function startInstalledFixture(options = {}) {
  const { startManager } = await module("ui-server");
  const { credentialStore } = await module("secrets");
  const { daemonExchange, daemonCommand } = await module("daemon-client");
  const stored = new Map();
  const stats = { writes: 0, reads: 0, removals: 0, inspections: 0 };
  const children = new Set();
  let daemon, descriptor;
  const secrets = credentialStore(async (id) => ({
    setPassword: async (value) => {
      stats.writes++;
      stored.set(id, value);
    },
    getPassword: async () => {
      stats.reads++;
      return stored.get(id);
    },
    deleteCredential: async () => {
      stats.removals++;
      return stored.delete(id);
    },
  }));
  const manager = await startManager(home, {
    idleTimeoutMs: 60000,
    ...options,
    secrets,
    execute: async (directory, operation, signal) => {
      stats.inspections++;
      const currentStatus = await daemonCommand(directory, "status");
      if (!currentStatus.ok || !currentStatus.data.running) {
        if (daemon && daemon.exitCode === null && daemon.signalCode === null)
          await new Promise((resolveExit) => daemon.once("exit", resolveExit));
        daemon = fork(fixturePath, ["--daemon"], {
          cwd: fileURLToPath(new URL(".", import.meta.url)),
          env: { ...process.env, RUNNEL_HOME: home },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
          execArgv: [],
          windowsHide: true,
        });
        children.add(daemon);
        daemon.once("exit", () => children.delete(daemon));
        await new Promise((resolveReady, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Synthetic daemon did not start")),
            10000
          );
          daemon.once("message", (message) => {
            clearTimeout(timer);
            assert.equal(message.type, "ready");
            descriptor = message.descriptor;
            resolveReady();
          });
          daemon.once("error", reject);
          daemon.once("exit", (code) => {
            clearTimeout(timer);
            if (code) reject(new Error("Synthetic daemon exited"));
          });
        });
      }
      return daemonExchange(descriptor, { action: "execute", request: operation }, signal);
    },
  });
  return {
    ...manager,
    stats: () => ({
      ...stats,
      process: { pid: process.pid, rss: process.memoryUsage().rss, cpu: process.cpuUsage() },
      daemonPids: [...children].map((child) => child.pid),
    }),
    cleanup: async () => {
      await manager.stop();
      await daemonCommand(home, "stop");
      await Promise.all(
        [...children].map(
          (child) =>
            new Promise((resolveExit) => {
              if (child.exitCode !== null || child.signalCode !== null) return resolveExit();
              child.once("exit", resolveExit);
              child.send({ type: "stop" });
            })
        )
      );
    },
  };
}

export function http(origin, path, { method = "GET", body, headers = {} } = {}) {
  return new Promise((resolveResponse, reject) => {
    const req = request(`${origin}${path}`, { method, headers }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (value) => {
        text += value;
      });
      response.on("end", () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolveResponse({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    req.on("error", reject);
    req.setTimeout(10000, () => req.destroy(new Error("HTTP fixture deadline")));
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

export async function pair(manager) {
  const link = new URL(manager.pairingUrl());
  const code = new URLSearchParams(link.hash.slice(1)).get("pair");
  const response = await http(manager.origin, "/api/session", {
    method: "POST",
    body: { code },
    headers: { Origin: manager.origin, "Content-Type": "application/json" },
  });
  assert.equal(response.status, 200, response.text);
  return { token: response.json.token, code };
}

async function installedCliSmoke() {
  const executable = fileURLToPath(new URL("cli.js", base));
  const launcher = fileURLToPath(new URL("./node_modules/.bin/runnel.cmd", import.meta.url));
  const env = {
    ...process.env,
    RUNNEL_HOME: join(home, "cli"),
    RUNNEL_INSTALLED_LAUNCHER: launcher,
  };
  const startupStart = performance.now();
  const child =
    process.platform === "win32"
      ? spawn(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "& $env:RUNNEL_INSTALLED_LAUNCHER ui; exit $LASTEXITCODE",
          ],
          { cwd: tmpdir(), env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] }
        )
      : spawn(process.execPath, [executable, "ui"], {
          cwd: tmpdir(),
          env,
          stdio: ["pipe", "pipe", "pipe"],
        });
  let output = "",
    errors = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (value) => {
    errors += value;
  });
  try {
    const url = await new Promise((resolveUrl, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Installed UI startup deadline: ${errors}`)),
        15000
      );
      child.stdout.on("data", (value) => {
        output += value;
        const found = output.match(/http:\/\/127\.0\.0\.1:\d+\/#pair=[A-Za-z0-9_-]+/);
        if (found) {
          clearTimeout(timer);
          resolveUrl(found[0]);
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Installed UI exited ${code}: ${output} ${errors}`));
      });
    });
    const origin = new URL(url).origin;
    const page = await http(origin, "/");
    assert.equal(page.status, 200);
    const code = new URLSearchParams(new URL(url).hash.slice(1)).get("pair");
    const session = await http(origin, "/api/session", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: { code },
    });
    assert.equal(session.status, 200, session.text);
    const authorization = `Bearer ${session.json.token}`;
    const config = await http(origin, "/api/configuration", {
      headers: { Authorization: authorization },
    });
    assert.equal(config.status, 200, config.text);
    assert.deepEqual(config.json.environments, []);
    const startupMs = performance.now() - startupStart;
    let launcherProcesses = [{ pid: child.pid, command: "node" }];
    if (process.platform === "win32") {
      const measurement = spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name; $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add([int]$env:RUNNEL_MEASURE_ROOT); do { $changed = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $changed = $true } } } while ($changed); @($all | Where-Object { $ids.Contains([int]$_.ProcessId) } | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if ($p) { @{pid=$p.Id; command=$_.Name; rssBytes=$p.WorkingSet64; cpuSeconds=$p.TotalProcessorTime.TotalSeconds} } }) | ConvertTo-Json -Compress",
        ],
        {
          env: { ...process.env, RUNNEL_MEASURE_ROOT: String(child.pid) },
          encoding: "utf8",
          timeout: 10000,
          windowsHide: true,
        }
      );
      assert.equal(measurement.status, 0, measurement.stderr);
      const values = JSON.parse(measurement.stdout || "[]");
      launcherProcesses = Array.isArray(values) ? values : values === null ? [] : [values];
      assert(launcherProcesses.some((item) => item.command === "node.exe"));
    }
    assert(!existsSync(join(env.RUNNEL_HOME, "daemon")));
    const shutdownStart = performance.now();
    const exited = new Promise((resolveExit) => child.once("exit", (code) => resolveExit(code)));
    const stopped = await http(origin, "/api/operation", {
      method: "POST",
      headers: { Authorization: authorization, Origin: origin, "Content-Type": "application/json" },
      body: { action: "stopManager" },
    });
    assert.equal(stopped.status, 200, stopped.text);
    let exitTimer;
    const exitCode = await Promise.race([
      exited,
      new Promise((_resolve, reject) => {
        exitTimer = setTimeout(
          () => reject(new Error("Installed UI did not exit after stop")),
          10000
        );
      }),
    ]).finally(() => clearTimeout(exitTimer));
    assert.equal(exitCode, 0, errors);
    process.stdout.write(
      `${JSON.stringify({ fixture: "installed-cli-ui", platform: process.platform, launcherProcesses, startupToPairedHttpMs: startupMs, stopHttpToProcessExitMs: performance.now() - shutdownStart, methodology: "Wall-clock performance.now around the installed foreground CLI process. Native Windows starts the actual npm .cmd shim via PowerShell; Linux invokes its installed cli.js through Node. Startup includes static document, pairing and offline configuration HTTP requests. Shutdown includes authenticated stopManager HTTP response and actual process exit. No browser, native vault or database is used." })}\n`
    );
    assert.equal(errors, "");
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
  }
}

export async function installedHttpSmoke() {
  const manager = await startInstalledFixture();
  try {
    const page = await http(manager.origin, "/");
    assert.equal(page.status, 200, page.text);
    assert.match(page.headers["content-security-policy"], /default-src 'none'/);
    assert.equal(page.headers["access-control-allow-origin"], undefined);
    const assets = [...page.text.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(
      (match) => match[1]
    );
    assert(
      assets.some((asset) => asset.endsWith(".js")),
      "Installed HTML needs its compiled bundle"
    );
    for (const asset of assets)
      assert.equal((await http(manager.origin, asset)).status, 200, asset);
    assert.equal((await http(manager.origin, "/api/configuration")).status, 401);
    const { token, code } = await pair(manager);
    const headers = { Authorization: `Bearer ${token}` };
    const config = await http(manager.origin, "/api/configuration", { headers });
    assert.equal(config.status, 200, config.text);
    assert.equal(config.json.settings.idleTimeoutMs, 300000);
    const revision = config.json.revision;
    assert.match(revision, /^[a-f0-9]{64}$/);
    const operation = (body, extra = {}) =>
      http(manager.origin, "/api/operation", {
        method: "POST",
        body,
        headers: {
          ...headers,
          Origin: manager.origin,
          "Content-Type": "application/json",
          ...extra,
        },
      });
    const uri = "mongodb://synthetic:never-echo-this@owned.invalid/accounts?authSource=auth";
    const saved = await operation({ action: "registerEnvironment", env: "local", uri, revision });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.ok, true, saved.text);
    assert.doesNotMatch(saved.text, /never-echo|secretRef|keyring:/);
    assert(!readFileSync(join(home, "catalog.json"), "utf8").includes(uri));
    const after = await http(manager.origin, "/api/configuration", { headers });
    assert.equal(after.json.environments[0].connections[0].name, "primary");
    assert.doesNotMatch(after.text, /never-echo|secretRef|keyring:/);
    assert(!existsSync(join(home, "daemon")));
    assert.deepEqual(manager.stats().writes, 1);
    assert.deepEqual(manager.stats().reads, 0);
    assert.deepEqual(manager.stats().inspections, 0);
    assert.equal(
      (await operation({ action: "settings", patch: { historyEnabled: false }, revision })).status,
      409
    );
    assert.equal(
      (
        await operation(
          { action: "settings", patch: { historyEnabled: false }, revision: after.json.revision },
          { Origin: "http://127.0.0.1:1" }
        )
      ).status,
      403
    );
    assert.equal(
      (
        await http(manager.origin, "/api/configuration", {
          headers: { ...headers, Host: "attacker.invalid" },
        })
      ).status,
      403
    );
    const replay = await http(manager.origin, "/api/session", {
      method: "POST",
      body: { code },
      headers: { Origin: manager.origin, "Content-Type": "application/json" },
    });
    assert.equal(replay.status, 401);
    for (const target of ["/api/configuration?token=x", "/../catalog.json", "/%2e%2e/catalog.json"])
      assert.notEqual((await http(manager.origin, target, { headers })).status, 200);
    assert.equal((await http(manager.origin, "/api/status", { headers })).status, 200);
    assert(!existsSync(join(home, "daemon")));
  } finally {
    await manager.cleanup();
  }
  await installedCliSmoke();
  process.stdout.write(
    "Installed manager assets, offline HTTP management, session/Host/Origin protection and native launcher lifecycle passed\n"
  );
}

if (process.env.RUNNEL_UI_FIXTURE_WORKER === "1") await fakeWorker();
else if (process.argv[2] === "--daemon") await fakeDaemon();
else if (process.argv[2] === "--serve") {
  const manager = await startInstalledFixture();
  process.send({
    type: "ready",
    origin: manager.origin,
    url: manager.pairingUrl(),
    stats: manager.stats(),
  });
  process.on("message", (message) => {
    if (message.type === "stats")
      process.send({ type: "stats", id: message.id, stats: manager.stats() });
    if (message.type === "pair")
      process.send({ type: "pair", id: message.id, url: manager.pairingUrl() });
    if (message.type === "stop") void manager.cleanup().then(() => process.disconnect());
  });
  process.on("disconnect", () => void manager.cleanup());
  process.on("SIGTERM", () => void manager.cleanup());
} else if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await installedHttpSmoke();
