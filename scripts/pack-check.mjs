import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
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
      assert(files.has("dist/ui/index.html"), "CLI static manager document must be packed");
      assert(
        [...files].some((file) => /^dist\/ui\/assets\/.+\.js$/.test(file)),
        "CLI compiled browser bundle must be packed"
      );
      assert(
        [...files].some((file) => /^dist\/ui\/assets\/.+\.woff2$/.test(file)),
        "CLI manager fonts must be bundled offline"
      );
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
  const executable = join(consumer, "node_modules/@abijith-suresh/runnel/dist/cli.js");
  const setupFixture = join(consumer, "installed-setup-fixture.mjs");
  writeFileSync(
    setupFixture,
    readFileSync(new URL("./installed-setup-fixture.mjs", import.meta.url))
  );
  execFileSync(process.execPath, [setupFixture], {
    cwd: consumer,
    stdio: "inherit",
    timeout: 30000,
  });
  const uiFixture = join(consumer, "installed-ui-fixture.mjs");
  writeFileSync(uiFixture, readFileSync(new URL("./installed-ui-fixture.mjs", import.meta.url)));
  execFileSync(process.execPath, [uiFixture], {
    cwd: consumer,
    stdio: "inherit",
    timeout: 45000,
    windowsHide: true,
    env: { ...process.env, RUNNEL_HOME: join(consumer, "fake-ui-catalog") },
  });
  for (const name of ["installed-worker-lifecycle.mjs", "worker-driver-fixture.mjs"])
    writeFileSync(join(consumer, name), readFileSync(new URL(`./${name}`, import.meta.url)));
  execFileSync(process.execPath, [join(consumer, "installed-worker-lifecycle.mjs")], {
    cwd: consumer,
    stdio: "inherit",
    timeout: 120000,
    windowsHide: true,
  });
  const offline = (args) =>
    spawnSync(process.execPath, [executable, ...args], {
      cwd: temporary,
      encoding: "utf8",
      env: { ...process.env, RUNNEL_HOME: "invalid-relative-catalog" },
      timeout: 10000,
    });
  const skillPath = offline(["skill", "path"]);
  assert.equal(skillPath.status, 0, skillPath.stderr);
  assert.equal(skillPath.stderr, "");
  const path = skillPath.stdout.trim();
  assert(isAbsolute(path));
  assert.equal(
    relative(realpathSync(consumer), path).replaceAll("\\", "/"),
    "node_modules/@abijith-suresh/runnel/skills/runnel/SKILL.md"
  );
  const skillText = readFileSync(path, "utf8");
  const printedSkill = offline(["skill", "print"]);
  assert.equal(printedSkill.status, 0, printedSkill.stderr);
  assert.equal(printedSkill.stderr, "");
  assert.equal(printedSkill.stdout, skillText);
  const guide = offline(["guide", "scripts"]);
  assert.equal(guide.status, 0, guide.stderr);
  assert.equal(guide.stderr, "");
  assert.match(guide.stdout, /^## Scripts\r?\n/);
  assert(skillText.includes(guide.stdout.trimEnd()));
  const cli = offline(["--help"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, "");
  assert.match(cli.stdout, /^Runnel\r?\n/);
  const discovery = spawnSync(process.execPath, [executable, "envs"], {
    cwd: consumer,
    env: { ...process.env, RUNNEL_HOME: join(temporary, "empty-catalog") },
    encoding: "utf8",
  });
  assert.equal(discovery.status, 0, discovery.stderr);
  assert.equal(discovery.stderr, "");
  assert.deepEqual(JSON.parse(discovery.stdout), { ok: true, data: { environments: [] } });
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
      ["find", "users", "-e", "unknown", "--filter", "{}"],
      ["export", "users", "-e", "unknown", "--output", "packed-users.ejson"],
      ["run", "packed-script.mjs", "-e", "unknown", "--args", "{}", "--timeout", "0"],
    ]) {
      const query = daemonCli(args);
      assert.equal(query.status, 1, query.stderr);
      assert.equal(JSON.parse(query.stdout).error.code, "EnvironmentNotFound");
    }
    const history = daemonCli(["history"]);
    assert.equal(history.status, 0, history.stderr);
    const records = JSON.parse(history.stdout).data.entries;
    assert.equal(records.length, 4);
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
    "All three npm pack dry runs, isolated tarball installs, imports, and installed CLI/daemon checks passed\n"
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
