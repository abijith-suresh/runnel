import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeBuildIdentity } from "../apps/cli/src/build-identity.ts";
import { gitEnvironment } from "./git-environment.mjs";
import { installPrepared, verifyInstalledContents, verifyPrepared } from "./prerelease.mjs";
import { packages } from "./release-policy.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const packagePath = (directory, name) => join(directory, "node_modules", ...name.split("/"));
const validSha = (value) => /^[a-f0-9]{40}$/.test(value) && !/^0+$/.test(value);

/** Run against one verified installation, including native Windows launcher paths. */
export function checkInstalledPrerelease(installation, manifest) {
  const consumer = realpathSync(installation.directory);
  assert(isAbsolute(consumer));
  assert.deepEqual(installation.build, manifest.build);
  assert.equal(installation.version, manifest.build.version);
  verifyInstalledContents(consumer, manifest);
  for (const { name } of packages) {
    const installed = readJson(join(packagePath(consumer, name), "package.json"));
    assert.equal(installed.name, name);
    assert.equal(installed.version, manifest.build.version);
    assert.deepEqual(installed.runnelBuild, manifest.build);
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies"])
      for (const [dependency, version] of Object.entries(installed[field] ?? {})) {
        assert(!version.startsWith("workspace:"), "Installed artifacts cannot use workspace deps");
        if (packages.some((pkg) => pkg.name === dependency))
          assert.equal(version, manifest.build.version);
      }
  }
  // Corrupted installed metadata must fail validation before any installed code runs.
  const coreManifest = join(packagePath(consumer, packages[0].name), "package.json");
  const original = readFileSync(coreManifest);
  try {
    const changed = JSON.parse(original);
    changed.runnelBuild.sourceSha = "f".repeat(40);
    if (changed.runnelBuild.sourceSha === manifest.build.sourceSha)
      changed.runnelBuild.sourceSha = "e".repeat(40);
    writeFileSync(coreManifest, JSON.stringify(changed));
    assert.throws(() => verifyInstalledContents(consumer, manifest));
  } finally {
    writeFileSync(coreManifest, original);
  }
  verifyInstalledContents(consumer, manifest);

  const outside = mkdtempSync(join(tmpdir(), "runnel-prerelease-execution-"));
  const executable = join(packagePath(consumer, "@abijith-suresh/runnel"), "dist", "cli.js");
  const env = { ...process.env, RUNNEL_HOME: "invalid-relative-catalog" };
  delete env.RUNNEL_UI_FIXTURE_WORKER;
  const invoke = (args, home = env.RUNNEL_HOME) => {
    const result = spawnSync(process.execPath, [executable, ...args], {
      cwd: outside,
      env: { ...env, RUNNEL_HOME: home },
      encoding: "utf8",
      timeout: 15000,
      windowsHide: true,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, "");
    return result.stdout;
  };
  try {
    assert.equal(invoke(["--version"]).trim(), manifest.build.version);
    const receipt = {
      ok: true,
      data: {
        name: "@abijith-suresh/runnel",
        version: manifest.build.version,
        build: manifest.build,
      },
    };
    assert.deepEqual(JSON.parse(invoke(["build-info"])), receipt);
    assert.match(invoke(["--help"]), /^Runnel\r?\n/);
    const skill = invoke(["skill", "path"]).trim();
    assert(isAbsolute(skill));
    assert.equal(
      relative(consumer, skill).replaceAll("\\", "/"),
      "node_modules/@abijith-suresh/runnel/skills/runnel/SKILL.md"
    );
    const text = readFileSync(skill, "utf8");
    assert.equal(invoke(["skill", "print"]), text);
    const guide = invoke(["guide", "scripts"]);
    assert.match(guide, /^## Scripts\r?\n/);
    assert(text.includes(guide.trimEnd()));

    const empty = join(outside, "absent-catalog");
    assert.deepEqual(JSON.parse(invoke(["envs"], empty)), {
      ok: true,
      data: { environments: [] },
    });
    assert.equal(JSON.parse(invoke(["config"], empty)).ok, true);
    assert.equal(JSON.parse(invoke(["settings"], empty)).ok, true);
    assert.deepEqual(JSON.parse(invoke(["daemon", "status"], empty)), {
      ok: true,
      data: { running: false },
    });
    assert(!existsSync(empty), "Offline discovery must not initialize a catalog or daemon");
    assert(!existsSync(join(outside, env.RUNNEL_HOME)));

    if (process.platform === "win32") {
      // Static PowerShell command, actual installed npm .cmd launcher, outside source/install cwd.
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "& $env:RUNNEL_INSTALLED_LAUNCHER build-info; exit $LASTEXITCODE",
        ],
        {
          cwd: outside,
          env: { ...env, RUNNEL_INSTALLED_LAUNCHER: installation.executable },
          encoding: "utf8",
          timeout: 15000,
          windowsHide: true,
        }
      );
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), receipt);
    }

    for (const [name, timeout, home] of [
      ["installed-setup-fixture.mjs", 30000, join(consumer, "fake-setup-catalog")],
      ["installed-ui-fixture.mjs", 45000, join(consumer, "fake-ui-catalog")],
      ["installed-worker-lifecycle.mjs", 120000, join(consumer, "fake-worker-catalog")],
    ]) {
      copyFileSync(new URL(`./${name}`, import.meta.url), join(consumer, name));
      if (name === "installed-worker-lifecycle.mjs")
        copyFileSync(
          new URL("./worker-driver-fixture.mjs", import.meta.url),
          join(consumer, "worker-driver-fixture.mjs")
        );
      execFileSync(process.execPath, [join(consumer, name)], {
        cwd: consumer,
        env: { ...env, RUNNEL_HOME: home },
        stdio: "inherit",
        timeout,
        windowsHide: true,
      });
    }
    process.stdout.write(
      `${JSON.stringify({ prereleaseInstalled: true, platform: process.platform, build: manifest.build, packages: packages.map(({ name }) => name), checks: ["contents-and-exact-dependencies", "build-identity-and-native-launcher", "offline-agent-discovery", "synthetic-registration", "installed-http-security", "production-worker-adapter-lifecycle"] })}\n`
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
}

/** Hash/receipt tampering must be rejected without executing package code. */
function checkBundleTampering(directory, manifest, temporary) {
  const otherSha = manifest.build.sourceSha === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40);
  assert.throws(
    () => main(["--bundle", directory, "--expected-sha", otherSha]),
    /Bundle does not match approved source SHA/
  );
  const probe = join(temporary, "tampered");
  // A new owned directory only; leave the supplied authoritative bytes untouched.
  mkdirSync(probe);
  for (const name of ["manifest.json", "SHA256SUMS", ...manifest.packages.map((p) => p.filename)])
    copyFileSync(join(directory, name), join(probe, name));
  const tarball = join(probe, manifest.packages[0].filename);
  const original = readFileSync(tarball);
  writeFileSync(tarball, Buffer.concat([original, Buffer.from("tamper")]));
  assert.throws(() => verifyPrepared(probe));
  writeFileSync(tarball, original);
  const receipt = join(probe, "manifest.json");
  const bytes = readFileSync(receipt);
  const stale = JSON.parse(bytes);
  stale.build.sourceSha = "0".repeat(40);
  writeFileSync(receipt, JSON.stringify(stale));
  assert.throws(() => verifyPrepared(probe));
  writeFileSync(receipt, bytes);
  verifyPrepared(probe);
}

export function main(args = process.argv.slice(2)) {
  let bundle, expectedSha;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    assert(value, "Supply --bundle DIRECTORY and optional --expected-sha FULL_SHA");
    if (args[index] === "--bundle" && bundle === undefined) bundle = value;
    else if (args[index] === "--expected-sha" && expectedSha === undefined) expectedSha = value;
    else throw new Error("Unsupported prerelease check arguments");
  }
  assert(bundle !== undefined || expectedSha === undefined, "--expected-sha requires --bundle");
  if (expectedSha !== undefined) assert(validSha(expectedSha), "Expected a full source SHA");
  const temporary = mkdtempSync(join(tmpdir(), "runnel-prerelease-check-"));
  try {
    let directory, manifest;
    if (bundle !== undefined) {
      directory = resolve(bundle);
      manifest = verifyPrepared(directory);
      if (expectedSha !== undefined)
        assert.equal(
          manifest.build.sourceSha,
          expectedSha,
          "Bundle does not match approved source SHA"
        );
      const consumer = join(temporary, "consumer install #prerelease");
      const installation = installPrepared(directory, consumer);
      checkInstalledPrerelease(installation, manifest);
    } else {
      const git = (args) =>
        execFileSync("git", args, {
          cwd: root,
          env: gitEnvironment(),
          encoding: "utf8",
          windowsHide: true,
        }).trim();
      const sourceSha = git(["rev-parse", "HEAD"]);
      assert(validSha(sourceSha));
      const sourceVersion = JSON.parse(
        git(["show", `${sourceSha}:packages/core/package.json`])
      ).version;
      const identity = makeBuildIdentity({
        sourceSha,
        sourceVersion,
        channel: "dev",
        date: new Date().toISOString().slice(0, 10).replaceAll("-", ""),
        runId: String(Date.now()),
        attempt: "1",
      });
      directory = join(temporary, "bundle");
      // Exercise the actual manual CLI entry too: its dynamic verifier import must not deadlock.
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL("./prerelease.mjs", import.meta.url)),
          "--output",
          directory,
          "--channel",
          identity.channel,
          "--source-sha",
          identity.sourceSha,
          "--date",
          identity.date,
          "--run-id",
          identity.runId,
          "--attempt",
          identity.attempt,
        ],
        {
          cwd: root,
          stdio: "inherit",
          windowsHide: true,
          timeout: 300000,
        }
      );
      manifest = verifyPrepared(directory);
      assert.equal(manifest.build.sourceSha, sourceSha);
    }
    checkBundleTampering(directory, manifest, temporary);
    process.stdout.write(
      "Prepared prerelease bytes, receipt tamper guards and installed acceptance checks passed\n"
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
}
