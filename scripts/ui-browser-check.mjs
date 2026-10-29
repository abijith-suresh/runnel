// Browser acceptance against the public tarballs, never a frontend development server.
import assert from "node:assert/strict";
import { fork, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { chromium } from "@playwright/test";
import { installLocal } from "./local-install.mjs";

const temporary = mkdtempSync(join(tmpdir(), "runnel-browser-"));
const consumer = join(temporary, "consumer installed #browser");
let fixture, browser, hostile, page;
let output = "",
  errors = "";
const samples = [];
const databaseIdleMs = process.platform === "win32" ? 6000 : 1800;
const clockTicks =
  process.platform === "linux"
    ? Number(spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).stdout.trim())
    : undefined;
function descendantPids(rootPid) {
  if (process.platform === "linux") {
    const parents = new Map();
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const status = readFileSync(`/proc/${entry}/status`, "utf8");
        parents.set(Number(entry), Number(status.match(/^PPid:\s+(\d+)/m)?.[1]));
      } catch {}
    }
    const selected = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of parents)
        if (selected.has(parent) && !selected.has(pid)) {
          selected.add(pid);
          changed = true;
        }
    }
    return [...selected];
  }
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId; $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add([int]$env:RUNNEL_MEASURE_ROOT); do { $changed = $false; foreach ($p in $all) { if ($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)) { $changed = $true } } } while ($changed); @($ids) | ConvertTo-Json -Compress",
      ],
      {
        env: { ...process.env, RUNNEL_MEASURE_ROOT: String(rootPid) },
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const values = JSON.parse(result.stdout);
    return Array.isArray(values) ? values : values === null ? [] : [values];
  }
  return [rootPid];
}
const pause = (duration) => new Promise((resolve) => setTimeout(resolve, duration));
function requestFixture(type) {
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      fixture.off("message", listener);
      reject(new Error(`Fixture ${type} deadline`));
    }, 10000);
    const listener = (message) => {
      if (message.id === id) {
        clearTimeout(timer);
        fixture.off("message", listener);
        resolve(message);
      }
    };
    fixture.on("message", listener);
    fixture.send({ type, id });
  });
}
function resources(pids) {
  if (process.platform === "linux")
    return pids.map((pid) => {
      try {
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
        const stat = raw
          .slice(raw.lastIndexOf(")") + 1)
          .trim()
          .split(/\s+/);
        return {
          pid,
          rssBytes: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024,
          cpuSeconds: (Number(stat[11]) + Number(stat[12])) / clockTicks,
        };
      } catch {
        return { pid, exited: true };
      }
    });
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ids = $env:RUNNEL_MEASURE_PIDS | ConvertFrom-Json; @($ids | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p) { @{pid=$p.Id; rssBytes=$p.WorkingSet64; cpuSeconds=$p.TotalProcessorTime.TotalSeconds} } }) | ConvertTo-Json -Compress",
      ],
      {
        env: { ...process.env, RUNNEL_MEASURE_PIDS: JSON.stringify(pids) },
        encoding: "utf8",
        windowsHide: true,
        timeout: 10000,
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const values = JSON.parse(result.stdout || "[]");
    return Array.isArray(values) ? values : values === null ? [] : [values];
  }
  return pids.map((pid) => ({ pid, rssUnavailable: true }));
}
async function sample(stage, status) {
  const stats = (await requestFixture("stats")).stats;
  const session = await browser.newBrowserCDPSession();
  const { processInfo } = await session.send("SystemInfo.getProcessInfo");
  await session.detach();
  const backendPids = [
    stats.process.pid,
    ...stats.daemonPids,
    ...(status?.worker?.pid ? [status.worker.pid] : []),
  ];
  const browserPids = descendantPids(processInfo.find((item) => item.type === "browser").id);
  samples.push({
    stage,
    elapsedMs: performance.now(),
    backendProcessCount: backendPids.length,
    backend: resources(backendPids),
    managerCpuMicroseconds: stats.process.cpu,
    browserProcessCount: browserPids.length,
    browser: resources(browserPids),
    browserCpuSeconds: processInfo.reduce((total, item) => total + item.cpuTime, 0),
  });
  return stats;
}
try {
  installLocal(process.cwd(), consumer);
  const fixturePath = join(consumer, "installed-ui-fixture.mjs");
  writeFileSync(fixturePath, readFileSync(new URL("./installed-ui-fixture.mjs", import.meta.url)));
  const beforeStartup = performance.now();
  fixture = fork(fixturePath, ["--serve"], {
    cwd: consumer,
    env: { ...process.env, RUNNEL_HOME: join(consumer, "browser-catalog") },
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  fixture.stdout.setEncoding("utf8");
  fixture.stderr.setEncoding("utf8");
  fixture.stdout.on("data", (value) => {
    output += value;
  });
  fixture.stderr.on("data", (value) => {
    errors += value;
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Installed manager startup deadline: ${errors}`)),
      15000
    );
    fixture.once("message", (message) => {
      clearTimeout(timer);
      assert.equal(message.type, "ready");
      resolve(message);
    });
    fixture.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Installed fixture exited ${code}: ${errors}`));
    });
  });
  const startupMs = performance.now() - beforeStartup;
  const origin = ready.origin;
  const launchOptions = { headless: true };
  if (process.env.RUNNEL_BROWSER_EXECUTABLE_PATH)
    launchOptions.executablePath = process.env.RUNNEL_BROWSER_EXECUTABLE_PATH;
  browser = await chromium.launch(launchOptions);
  const context = await browser.newContext();
  page = await context.newPage();
  let expectedAbortedResponse = false;
  const failures = [],
    consoleErrors = [],
    responses = [];
  const requestedOrigins = new Set();
  page.on("request", (request) => requestedOrigins.add(new URL(request.url()).origin));
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      if (expectedAbortedResponse && message.text().includes("net::ERR_FAILED"))
        expectedAbortedResponse = false;
      else consoleErrors.push(message.text());
    }
  });
  page.on("response", async (response) => {
    if (response.url().startsWith(origin)) responses.push(await response.text().catch(() => ""));
  });
  const loadStart = performance.now();
  await page.goto(ready.url);
  await page
    .getByRole("heading", { name: /connections|environments/i })
    .first()
    .waitFor();
  const firstPageMs = performance.now() - loadStart;
  assert.equal(new URL(page.url()).hash, "");
  assert.equal((await context.cookies()).length, 0);
  assert.deepEqual(
    await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]),
    [[], []]
  );
  process.stdout.write("Browser paired with installed manager\n");
  const initial = await sample("open-manager-no-database");
  assert.equal(initial.reads, 0);
  assert.equal(initial.writes, 0);
  assert.equal(initial.inspections, 0);
  assert.equal(initial.daemonPids.length, 0);
  const uri =
    "mongodb://synthetic:private-browser-value@fixture.invalid/accounts?authSource=authentication";
  if (process.env.RUNNEL_UI_SCREENSHOT) {
    await page.screenshot({
      path: process.env.RUNNEL_UI_SCREENSHOT.replace(/\.png$/, "-empty.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "Add your first environment" }).focus();
    await page.screenshot({
      path: process.env.RUNNEL_UI_SCREENSHOT.replace(/\.png$/, "-focus.png"),
    });
  }
  await page.getByRole("button", { name: "Add your first environment" }).click();
  if (process.env.RUNNEL_UI_SCREENSHOT)
    await page.screenshot({
      path: process.env.RUNNEL_UI_SCREENSHOT.replace(/\.png$/, "-register-dialog.png"),
    });
  await page.getByLabel("Environment name", { exact: true }).fill("local");
  await page.getByLabel("MongoDB URI", { exact: true }).fill(uri);
  let releaseSave, mutationSent;
  const sent = new Promise((resolve) => {
    mutationSent = resolve;
  });
  await page.route("**/api/operation", async (route) => {
    if (route.request().postDataJSON().action === "registerEnvironment") {
      mutationSent();
      await new Promise((resolve) => {
        releaseSave = resolve;
      });
    }
    await route.continue();
  });
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await sent;
  if (process.env.RUNNEL_UI_SCREENSHOT)
    await page.screenshot({
      path: process.env.RUNNEL_UI_SCREENSHOT.replace(/\.png$/, "-saving.png"),
    });
  assert.equal(await page.getByLabel("MongoDB URI", { exact: true }).inputValue(), "");
  releaseSave();
  await page.getByText("local", { exact: true }).first().waitFor();
  await page.getByRole("button", { name: "Test connection", exact: true }).first().waitFor();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.unroute("**/api/operation");
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  const saved = await sample("offline-registration");
  assert.equal(saved.writes, 1);
  assert.equal(saved.reads, 0);
  assert.equal(saved.inspections, 0);
  assert.equal(saved.daemonPids.length, 0);
  assert(
    !readFileSync(join(consumer, "browser-catalog/catalog.json"), "utf8").includes(
      "private-browser-value"
    )
  );
  await page.reload();
  await page.getByRole("heading", { name: "A fresh link, please.", exact: true }).waitFor();
  const freshUrl = (await requestFixture("pair")).url;
  await page.goto(freshUrl);
  await page.getByRole("button", { name: "Test connection", exact: true }).first().waitFor();
  assert.equal(new URL(page.url()).hash, "");
  const unpaired = await context.newPage();
  await unpaired.goto(origin);
  await unpaired.getByRole("heading", { name: "A fresh link, please.", exact: true }).waitFor();
  await unpaired.close();
  process.stdout.write("Offline registration and refresh pairing passed\n");
  // Advanced management uses the same catalog operations; none implicitly tests MongoDB.
  await page.getByRole("button", { name: "Add advanced connection" }).click();
  await page.getByLabel("Connection name", { exact: true }).fill("reporting");
  await page
    .getByLabel("MongoDB URI", { exact: true })
    .fill("mongodb://synthetic:advanced-browser-value@fixture.invalid/reports");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Make default", exact: true }).click();
  await page.getByText("Default connection updated.", { exact: true }).waitFor();
  await page.getByRole("button", { name: "+ Add alias", exact: true }).click();
  await page.getByLabel("Alias name", { exact: true }).fill("summary");
  await page.getByRole("dialog").getByRole("combobox").selectOption("reporting");
  await page.getByLabel("Physical database name", { exact: true }).fill("reports");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Rename", exact: true }).click();
  await page.getByLabel("New alias name", { exact: true }).fill("weekly");
  await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page.getByText("weekly", { exact: true }).waitFor();
  assert.equal((await requestFixture("stats")).stats.inspections, 0);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel(/^Idle shutdown/).fill(String(databaseIdleMs));
  await page.getByLabel(/^Script timeout/).fill("12345");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await page.getByText("Settings saved.", { exact: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  if (process.env.RUNNEL_UI_SCREENSHOT)
    await page.screenshot({
      path: process.env.RUNNEL_UI_SCREENSHOT.replace(/\.png$/, "-settings.png"),
      fullPage: true,
    });
  // Capture every configuration dialog at desktop and phone widths without submitting it.
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await page.getByRole("button", { name: "Environments", exact: true }).click();
    for (const [label, trigger] of [
      ["register", "+ Add environment"],
      ["connection", "Add advanced connection"],
      ["rotate", "Replace credential"],
      ["alias", "+ Add alias"],
      ["rename", "Rename"],
      ["remove-connection", "Remove"],
    ]) {
      await page.getByRole("button", { name: trigger, exact: true }).first().click();
      if (process.env.RUNNEL_UI_SCREENSHOT)
        await page.screenshot({
          path: process.env.RUNNEL_UI_SCREENSHOT.replace(
            /\.png$/,
            `-${size.width}-dialog-${label}.png`
          ),
        });
      await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    }
    await page.locator(".alias-row").getByRole("button", { name: "Remove", exact: true }).click();
    if (process.env.RUNNEL_UI_SCREENSHOT)
      await page.screenshot({
        path: process.env.RUNNEL_UI_SCREENSHOT.replace(
          /\.png$/,
          `-${size.width}-dialog-remove-alias.png`
        ),
      });
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Runtime", exact: true }).click();
    await page.getByRole("button", { name: "Stop manager", exact: true }).click();
    if (process.env.RUNNEL_UI_SCREENSHOT)
      await page.screenshot({
        path: process.env.RUNNEL_UI_SCREENSHOT.replace(
          /\.png$/,
          `-${size.width}-dialog-stop-manager.png`
        ),
      });
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  }
  // The navigation must remain in the document flow through scrolling and at each width.
  for (const size of [
    { width: 1440, height: 900 },
    { width: 1280, height: 800 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    for (const name of ["Environments", "Settings", "Runtime"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await page.evaluate(() => window.scrollTo(0, 0));
      const layout = await page.locator(".sidebar").evaluate((el) => {
        const rect = el.getBoundingClientRect();
        return {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          position: getComputedStyle(el).position,
          scrollWidth: document.documentElement.scrollWidth,
          viewport: innerWidth,
        };
      });
      assert.equal(layout.top, 0);
      assert.equal(layout.left, 0);
      assert.equal(layout.position, "static");
      assert.equal(layout.scrollWidth <= layout.viewport, true);
      const brandTop = await page
        .locator(".brand")
        .evaluate((el) => el.getBoundingClientRect().top);
      assert.equal(Math.round(brandTop), size.width > 850 ? 24 : 12);
      process.stdout.write(
        `Layout ${size.width} ${name} top: ${JSON.stringify({ ...layout, brandTop, scrollY: await page.evaluate(() => scrollY) })}\n`
      );
      if (process.env.RUNNEL_UI_SCREENSHOT)
        await page.screenshot({
          path: process.env.RUNNEL_UI_SCREENSHOT.replace(
            /\.png$/,
            `-${size.width}-${name.toLowerCase()}.png`
          ),
          fullPage: true,
        });
      assert.equal(await page.evaluate(() => scrollY), 0);
      assert.equal(
        Math.round(await page.locator(".brand").evaluate((el) => el.getBoundingClientRect().top)),
        size.width > 850 ? 24 : 12
      );
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      const scrollMeasurement = await page
        .locator(".sidebar-inner")
        .evaluate((el) => ({ top: el.getBoundingClientRect().top, scrollY }));
      if (size.width > 850 && scrollMeasurement.scrollY > 24)
        assert.equal(Math.round(scrollMeasurement.top), 24);
      process.stdout.write(
        `Layout ${size.width} ${name} scroll: ${JSON.stringify(scrollMeasurement)}\n`
      );
      if (process.env.RUNNEL_UI_SCREENSHOT && size.width >= 1280)
        await page.screenshot({
          path: process.env.RUNNEL_UI_SCREENSHOT.replace(
            /\.png$/,
            `-${size.width}-${name.toLowerCase()}-scrolled.png`
          ),
        });
      assert.equal(
        await page
          .locator(".sidebar")
          .evaluate((el) => Math.abs(el.getBoundingClientRect().top + scrollY) < 1),
        true
      );
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  // Lose a response after the server has committed. The page must report uncertainty,
  // make no automatic replay, and recover the committed value through a read.
  let lostResponseCalls = 0;
  expectedAbortedResponse = true;
  await page.route("**/api/operation", async (route) => {
    lostResponseCalls++;
    await route.fetch({ maxRetries: 0 });
    await route.abort("failed");
  });
  await page.getByLabel(/^Script timeout/).fill("12346");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "If the response was lost" }).waitFor();
  if (process.env.RUNNEL_UI_SCREENSHOT)
    await page.screenshot({
      path: process.env.RUNNEL_UI_SCREENSHOT.replace(/\.png$/, "-error.png"),
      fullPage: true,
    });
  await pause(500);
  assert.equal(lostResponseCalls, 1);
  await page.unroute("**/api/operation");
  await page.getByRole("button", { name: /Refresh/ }).click();
  await page
    .getByText("Configuration and status refreshed. No database connection was opened.", {
      exact: true,
    })
    .waitFor();
  assert.equal(await page.getByLabel(/^Script timeout/).inputValue(), "12346");
  assert.equal((await requestFixture("stats")).stats.inspections, 0);
  await page.getByRole("button", { name: "Environments", exact: true }).click();
  if (process.env.RUNNEL_UI_SCREENSHOT) {
    await page.screenshot({
      path: process.env.RUNNEL_UI_SCREENSHOT.replace(/\.png$/, "-environments.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: process.env.RUNNEL_UI_SCREENSHOT.replace(/\.png$/, "-mobile.png"),
      fullPage: true,
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false
    );
    await page.setViewportSize({ width: 1280, height: 720 });
  }
  process.stdout.write("Advanced catalog, settings and lost response recovery passed\n");
  const pairUrl = (await requestFixture("pair")).url;
  const pairCode = new URLSearchParams(new URL(pairUrl).hash.slice(1)).get("pair");
  const paired = await fetch(`${origin}/api/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ code: pairCode }),
  });
  assert.equal(paired.status, 200);
  const { token } = await paired.json();
  const api = async (path, body) => {
    const result = await fetch(`${origin}${path}`, {
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { Origin: origin, "Content-Type": "application/json" }),
      },
    });
    return { status: result.status, body: await result.json() };
  };
  const configuration = (await api("/api/configuration")).body;
  assert.equal(configuration.settings.idleTimeoutMs, databaseIdleMs);
  assert.equal(configuration.environments[0].defaultConnection, "reporting");
  assert.equal(configuration.environments[0].databases[0].name, "weekly");
  await page.getByRole("button", { name: "Test connection", exact: true }).first().click();
  await page
    .getByText(/Connection test completed\./)
    .first()
    .waitFor();
  process.stdout.write("Explicit installed worker test passed\n");
  const running = (await api("/api/status")).body;
  assert.equal(running.running, true);
  assert(running.worker.pid);
  await sample("explicit-test-database-processes", running);
  // Metadata polling must not rearm the database daemon's fixture-specific idle timer.
  const idleStart = performance.now();
  let stopped = false;
  while (performance.now() - idleStart < databaseIdleMs + 8000) {
    await api("/api/configuration");
    const status = (await api("/api/status")).body;
    if (!status.running) {
      stopped = true;
      break;
    }
    await pause(100);
  }
  assert(stopped, "Configuration/status polling kept the database daemon alive");
  await pause(100);
  await sample("database-idle-manager-still-open");
  process.stdout.write("Metadata polling did not renew database idle\n");
  // A different loopback origin is hostile. It receives no CORS capability or session authority.
  hostile = createServer((_request, response) => {
    response.end("<!doctype html><title>Owned hostile origin fixture</title>");
  });
  await new Promise((resolve) => hostile.listen(0, "127.0.0.1", resolve));
  const hostileOrigin = `http://127.0.0.1:${hostile.address().port}`;
  const hostilePage = await context.newPage();
  await hostilePage.goto(hostileOrigin);
  const blocked = await hostilePage.evaluate(async (target) => {
    try {
      await fetch(`${target}/api/operation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stopManager" }),
      });
      return false;
    } catch {
      return true;
    }
  }, origin);
  assert.equal(blocked, true);
  const denied = await fetch(`${origin}/api/operation`, {
    method: "POST",
    headers: {
      Origin: hostileOrigin,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "stopManager" }),
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get("access-control-allow-origin"), null);
  await hostilePage.close();
  assert.equal((await api("/api/status")).status, 200);
  await page.getByRole("button", { name: "Discover databases", exact: true }).first().click();
  await page.getByText("Explicit database discovery completed.", { exact: true }).waitFor();
  await page.getByRole("heading", { name: /Database discovery/ }).waitFor();
  await page.getByRole("button", { name: "Replace credential", exact: true }).first().click();
  await page
    .getByLabel("Replacement MongoDB URI", { exact: true })
    .fill("mongodb://synthetic:replacement-browser-value@fixture.invalid/replaced");
  await page.getByRole("button", { name: "Validate & replace", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .getByText("Credential replaced after explicit live validation.", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Runtime", exact: true }).click();
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(size);
    await page.getByRole("button", { name: "Stop database daemon", exact: true }).click();
    if (process.env.RUNNEL_UI_SCREENSHOT)
      await page.screenshot({
        path: process.env.RUNNEL_UI_SCREENSHOT.replace(
          /\.png$/,
          `-${size.width}-dialog-stop-daemon.png`
        ),
      });
    await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole("button", { name: "Stop database daemon", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Stop database daemon", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .getByText("Database daemon stopped. The manager is still open.", { exact: true })
    .waitFor();
  assert.equal((await api("/api/status")).body.running, false);
  assert.equal(
    await page.evaluate(() => document.documentElement.outerHTML.includes("private-browser-value")),
    false
  );
  assert(
    !/private-browser-value|advanced-browser-value|replacement-browser-value/.test(
      responses.join("")
    )
  );
  assert(
    !/private-browser-value|advanced-browser-value|replacement-browser-value/.test(output + errors)
  );
  assert.deepEqual(
    await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]),
    [[], []]
  );
  assert.deepEqual([...requestedOrigins], [origin]);
  assert.deepEqual(failures, []);
  assert.deepEqual(consoleErrors, []);
  if (process.env.RUNNEL_UI_SCREENSHOT)
    await page.screenshot({ path: process.env.RUNNEL_UI_SCREENSHOT, fullPage: true });
  if (process.env.RUNNEL_UI_SCREENSHOT) {
    await page.getByRole("button", { name: "Environments", exact: true }).click();
    const longName = "long_environment_name_for_layout_testing_12345678901234567890123";
    for (const name of [longName, "development", "integration", "production", "staging"]) {
      await page.getByRole("button", { name: "+ Add environment", exact: true }).click();
      await page.getByLabel("Environment name", { exact: true }).fill(name);
      await page
        .getByLabel("MongoDB URI", { exact: true })
        .fill("mongodb://synthetic:fixture@fixture.invalid/accounts");
      await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
    }
    await page.getByRole("button", { name: new RegExp(longName) }).click();
    await page.getByRole("button", { name: "Add advanced connection" }).click();
    await page
      .getByLabel("Connection name", { exact: true })
      .fill("long_connection_name_for_layout_testing_123456789012345678901234");
    await page
      .getByLabel("MongoDB URI", { exact: true })
      .fill("mongodb://synthetic:fixture@fixture.invalid/accounts");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "+ Add alias" }).click();
    await page
      .getByLabel("Alias name", { exact: true })
      .fill("long_alias_name_for_layout_testing_12345678901234567890123456789");
    await page
      .getByLabel("Physical database name", { exact: true })
      .fill("long_database_name_for_layout_testing_1234567890123456789012345");
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    for (const size of [
      { width: 1440, height: 900 },
      { width: 1280, height: 800 },
      { width: 768, height: 1024 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      await page.evaluate(() => window.scrollTo(0, 0));
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true
      );
      await page.screenshot({
        path: process.env.RUNNEL_UI_SCREENSHOT.replace(/\.png$/, `-${size.width}-dense.png`),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.getByRole("button", { name: "Runtime", exact: true }).click();
  }
  if (process.env.RUNNEL_TASTE_INSPECTOR) {
    const inspectUrl = (await requestFixture("pair")).url;
    const inspector = spawn(
      process.execPath,
      [
        process.env.RUNNEL_TASTE_INSPECTOR,
        inspectUrl,
        "--app",
        "--widths",
        "1440",
        "--out",
        process.env.RUNNEL_TASTE_OUTPUT,
      ],
      { env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let report = "";
    inspector.stdout.on("data", (data) => {
      report += data;
    });
    inspector.stderr.on("data", (data) => {
      report += data;
    });
    const code = await new Promise((resolve) => inspector.once("exit", resolve));
    writeFileSync(join(process.env.RUNNEL_TASTE_OUTPUT, "run.log"), `exit ${code}\n${report}`);
    process.stdout.write(`Taste inspector exit ${code}\n`);
  }
  await sample("quiet-manager-before-idle-measurement");
  await pause(1000);
  await sample("quiet-manager-after-one-second");
  const shutdownStart = performance.now();
  await page.getByRole("button", { name: "Stop manager", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Stop manager", exact: true }).click();
  await page.getByRole("heading", { name: "Manager stopped.", exact: true }).waitFor();
  await assert.rejects(() => fetch(`${origin}/api/status`));
  const shutdownMs = performance.now() - shutdownStart;
  await requestFixture("stats"); // Fixture harness remains to clean its owned daemon.
  const evidence = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    browser: browser.version(),
    startupMs,
    firstPageMs,
    managerShutdownMs: shutdownMs,
    methodology:
      "Headless Chromium opens assets from a temporary installed tarball consumer. Manager, daemon and fake native-driver worker are separate owned Node processes; only explicit test starts the latter two. RSS is the OS working set per PID. Browser process count includes the OS descendant tree rooted at the Chromium browser PID, including Linux zygotes. CPU seconds are cumulative OS process time and Chromium SystemInfo time; manager CPU is also recorded from process.cpuUsage. Quiet samples are one second apart. The test harness and npm installer are excluded. Short platform-specific database idle setting is fixture-only; production default remains five minutes. Synthetic fake vault/provider only. Native Windows measurements are produced only by the Windows job.",
    samples,
  };
  if (process.env.RUNNEL_UI_EVIDENCE)
    writeFileSync(process.env.RUNNEL_UI_EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify(evidence, null, 2)}\nInstalled browser pairing, offline registration, explicit worker access, hostile-origin isolation, URI redaction, idle and manager shutdown passed\n`
  );
} catch (error) {
  if (page && process.env.RUNNEL_UI_SCREENSHOT)
    await page
      .screenshot({ path: process.env.RUNNEL_UI_SCREENSHOT, fullPage: true })
      .catch(() => undefined);
  throw error;
} finally {
  if (browser) await browser.close();
  if (hostile) await new Promise((resolve) => hostile.close(resolve));
  if (fixture && fixture.exitCode === null) {
    fixture.send({ type: "stop" });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fixture.kill();
        reject(new Error("Owned UI fixture cleanup deadline"));
      }, 10000);
      fixture.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  rmSync(temporary, { recursive: true, force: true });
}
