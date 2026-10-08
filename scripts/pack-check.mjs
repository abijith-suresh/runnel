import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runNpm as invokeNpm } from "./npm-command.mjs";
import { packages, validateRepository } from "./release-policy.mjs";

const root = process.cwd();
const integration = process.argv[2] === "--mongodb";
assert(process.argv.length === (integration ? 3 : 2), "Unsupported packaging check arguments");
if (integration)
  assert(
    /^[1-9][0-9]{0,4}$/.test(process.env.RUNNEL_TEST_MONGODB_PORT ?? "") &&
      Number(process.env.RUNNEL_TEST_MONGODB_PORT) <= 65535,
    "Set RUNNEL_TEST_MONGODB_PORT to a local test MongoDB port. The check creates synthetic databases."
  );
const { manifests } = validateRepository(root);
const temporary = mkdtempSync(join(tmpdir(), "runnel-pack-"));
const runNpm = (args, cwd = root) =>
  invokeNpm(args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
try {
  const tarballs = [];
  for (const [index, pkg] of packages.entries()) {
    const manifest = manifests[index];
    const destinations = [
      manifest.main,
      manifest.types,
      ...Object.values(manifest.exports["."]),
      ...Object.values(manifest.bin ?? {}),
    ];
    const dry = JSON.parse(
      runNpm(["pack", "--dry-run", "--json", "--ignore-scripts", "--workspace", pkg.name])
    )[0];
    const files = new Set(dry.files.map((file) => file.path));
    for (const destination of destinations) {
      assert(
        files.has(destination.replace(/^\.\//, "")),
        `${pkg.name}: packed destination missing: ${destination}`
      );
      assert(
        existsSync(resolve(pkg.directory, destination)),
        `Build output missing: ${destination}`
      );
    }
    assert(
      files.has("LICENSE") && files.has("README.md"),
      `${pkg.name}: license and README must be packed`
    );
    assert(
      !dry.files.some((file) => file.path.startsWith("src/") || file.path.endsWith(".tsbuildinfo")),
      "Source and build cache must not enter the package"
    );
    if (manifest.bin)
      assert(
        readFileSync(resolve(pkg.directory, manifest.bin.runnel), "utf8").startsWith(
          "#!/usr/bin/env node\n"
        ),
        "CLI executable needs its shebang"
      );
    const [packed] = JSON.parse(
      runNpm([
        "pack",
        "--json",
        "--ignore-scripts",
        "--workspace",
        pkg.name,
        "--pack-destination",
        temporary,
      ])
    );
    tarballs.push(join(temporary, packed.filename));
  }
  const consumer = join(temporary, "consumer");
  execFileSync(process.execPath, ["-e", "require('node:fs').mkdirSync(process.argv[1])", consumer]);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // Local install only. Supplying all three tarballs resolves internal packages without a registry release.
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...tarballs],
    consumer
  );
  const imports = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "await import('@abijith-suresh/runnel-core'); await import('@abijith-suresh/runnel-mongodb'); await import('@abijith-suresh/runnel'); await import('effect'); await import('mongodb'); await import('@napi-rs/keyring'); await import('proper-lockfile');",
    ],
    { cwd: consumer, encoding: "utf8" }
  );
  assert.equal(imports.status, 0, imports.stderr);
  const worker = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from 'node:assert/strict';
       import { createWorkerSupervisor } from './node_modules/@abijith-suresh/runnel/dist/worker-supervisor.js';
       const worker = createWorkerSupervisor(process.env.RUNNEL_HOME);
       try {
         const first = await worker.execute({ operation: 'list' });
         assert.equal(first.ok, false);
         assert.equal(first.error.code, 'EnvironmentRequired');
         const pid = worker.status().pid;
         const second = await worker.execute({ operation: 'list', env: 'unknown' });
         assert.equal(second.ok, false);
         assert.equal(second.error.code, 'EnvironmentNotFound');
         assert.equal(worker.status().pid, pid);
         await worker.reset();
         const third = await worker.execute({ operation: 'list' });
         assert.equal(third.error.code, 'EnvironmentRequired');
         assert.notEqual(worker.status().pid, pid);
       } finally { await worker.stop(); }`,
    ],
    {
      cwd: consumer,
      env: { ...process.env, RUNNEL_HOME: join(temporary, "empty-worker-catalog") },
      encoding: "utf8",
      timeout: 30000,
    }
  );
  assert.equal(worker.status, 0, worker.stderr);
  const executable = join(consumer, "node_modules/@abijith-suresh/runnel/dist/cli.js");
  const cli = spawnSync(process.execPath, [executable, "--help"], {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, "");
  assert.match(cli.stdout, /Exports save bounded JSON\/EJSON arrays/);
  const discovery = spawnSync(process.execPath, [executable, "envs"], {
    cwd: consumer,
    env: { ...process.env, RUNNEL_HOME: join(temporary, "empty-catalog") },
    encoding: "utf8",
  });
  assert.equal(discovery.status, 0, discovery.stderr);
  assert.equal(discovery.stderr, "");
  assert.deepEqual(JSON.parse(discovery.stdout), { ok: true, data: { environments: [] } });
  const version = spawnSync(process.execPath, [executable, "--version"], {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stderr, "");
  assert.equal(
    version.stdout,
    `${manifests.find((pkg) => pkg.name === "@abijith-suresh/runnel").version}\n`
  );
  const noninteractiveSetup = spawnSync(process.execPath, [executable, "setup"], {
    cwd: consumer,
    encoding: "utf8",
  });
  assert.equal(noninteractiveSetup.status, 1);
  assert.equal(noninteractiveSetup.stderr, "");
  assert.equal(JSON.parse(noninteractiveSetup.stdout).error.code, "SetupTerminalRequired");
  const daemonHome = join(temporary, "pack-daemon");
  const daemonCli = (args) =>
    spawnSync(process.execPath, [executable, ...args], {
      cwd: consumer,
      env: { ...process.env, RUNNEL_HOME: daemonHome },
      encoding: "utf8",
      timeout: 30000,
    });
  try {
    const absent = daemonCli(["daemon", "status"]);
    assert.equal(absent.status, 0, absent.stderr);
    assert.deepEqual(JSON.parse(absent.stdout), { ok: true, data: { running: false } });
    const target = daemonCli(["list", "-e", "unknown"]);
    assert.equal(target.status, 1, target.stderr);
    assert.equal(JSON.parse(target.stdout).error.code, "EnvironmentNotFound");
    writeFileSync(join(consumer, "packed-script.mjs"), "export default async () => true;\n");
    for (const args of [
      ["describe", "users", "-e", "unknown"],
      ["find", "users", "-e", "unknown", "--filter", "{}"],
      ["count", "users", "-e", "unknown"],
      ["export", "users", "-e", "unknown", "--output", "packed-users.ejson"],
      ["aggregate", "users", "-e", "unknown", "--pipeline", "[]"],
      ["run", "packed-script.mjs", "-e", "unknown", "--args", "{}", "--timeout", "0"],
    ]) {
      const query = daemonCli(args);
      assert.equal(query.status, 1, query.stderr);
      assert.equal(JSON.parse(query.stdout).error.code, "EnvironmentNotFound");
    }
    const history = daemonCli(["history"]);
    assert.equal(history.status, 0, history.stderr);
    const records = JSON.parse(history.stdout).data.entries;
    assert.equal(records.length, 7);
    assert(records.every((entry) => entry.outcome.code === "EnvironmentNotFound"));
    assert(records.every((entry) => Object.keys(entry.targets).length === 0));
    const status = daemonCli(["daemon", "status"]);
    assert.equal(status.status, 0, status.stderr);
    const running = JSON.parse(status.stdout);
    assert.equal(running.data.running, true);
    assert.equal(
      running.data.version,
      manifests.find((pkg) => pkg.name === "@abijith-suresh/runnel").version
    );
    assert(running.data.worker.pid);
    const reset = daemonCli(["daemon", "reset"]);
    assert.equal(reset.status, 0, reset.stderr);
    assert.deepEqual(JSON.parse(reset.stdout), { ok: true, data: { reset: true } });
  } finally {
    const stop = daemonCli(["daemon", "stop"]);
    assert.equal(stop.status, 0, stop.stderr);
  }
  process.stdout.write(
    "All three npm pack dry runs, isolated tarball installs, imports, CLI entry point, worker lifecycle, and daemon lifecycle passed\n"
  );
  if (integration)
    execFileSync(
      process.execPath,
      [fileURLToPath(new URL("./check-local-mongodb.mjs", import.meta.url)), consumer],
      { stdio: "inherit", timeout: 180000 }
    );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
