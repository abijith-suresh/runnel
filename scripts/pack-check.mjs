import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installLocal } from "./local-install.mjs";
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
    if (manifest.bin) {
      assert(files.has("skills/runnel/SKILL.md"), "CLI agent skill must be packed");
      assert(files.has("dist/agent-help.js"), "CLI offline guide accessor must be packed");
      assert(
        readFileSync(resolve(pkg.directory, manifest.bin.runnel), "utf8").startsWith(
          "#!/usr/bin/env node\n"
        ),
        "CLI executable needs its shebang"
      );
    }
  }
  // Exercise the same persistent installer users run, including shell punctuation in its path.
  const consumer = join(
    temporary,
    process.platform === "win32" ? "consumer install #local" : "consumer install # % &"
  );
  installLocal(root, consumer);
  // Retained tarballs and lockfile must support rebuilding the local install without a registry release.
  runNpm(["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], consumer);
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
  // Read only the installed artifact from an unrelated cwd and with no usable catalog.
  const installedHelp = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import assert from 'node:assert/strict';
       import { readFileSync } from 'node:fs';
       import { isAbsolute, relative } from 'node:path';
       import { agentGuideTopics, getAgentGuide, getAgentSkillPath, readAgentSkill }
         from './node_modules/@abijith-suresh/runnel/dist/agent-help.js';
       const path = getAgentSkillPath();
       assert(isAbsolute(path));
       assert.equal(relative(process.cwd(), path).replaceAll('\\\\', '/'),
         'node_modules/@abijith-suresh/runnel/skills/runnel/SKILL.md');
       const skill = readFileSync(path, 'utf8');
       assert.equal(readAgentSkill(), skill);
       assert.equal(getAgentGuide('skill'), skill);
       for (const topic of agentGuideTopics) {
         const guide = getAgentGuide(topic);
         assert(guide.trim().length > 0);
         assert(skill.includes(guide.trimEnd()));
         assert(!guide.includes(process.env.RUNNEL_PACK_SOURCE_ROOT));
       }
       process.stdout.write('Installed skill and offline guide passed\\n');`,
    ],
    {
      cwd: consumer,
      env: {
        ...process.env,
        RUNNEL_HOME: "invalid-relative-catalog",
        RUNNEL_PACK_SOURCE_ROOT: root,
      },
      encoding: "utf8",
      timeout: 10000,
    }
  );
  assert.equal(installedHelp.status, 0, installedHelp.stderr);
  assert.equal(installedHelp.stderr, "");
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
  const skillPath = spawnSync(process.execPath, [executable, "skill", "path"], {
    cwd: temporary,
    encoding: "utf8",
    env: { ...process.env, RUNNEL_HOME: "invalid-relative-catalog" },
  });
  assert.equal(skillPath.status, 0, skillPath.stderr);
  const skillText = readFileSync(skillPath.stdout.trim(), "utf8");
  for (const args of [["skill"], ["skill", "print"], ["guide", "skill"]]) {
    const result = spawnSync(process.execPath, [executable, ...args], {
      cwd: temporary,
      encoding: "utf8",
      env: { ...process.env, RUNNEL_HOME: "invalid-relative-catalog" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, skillText);
  }
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
