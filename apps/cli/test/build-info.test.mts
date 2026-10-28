import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeBuildIdentity, validateBuildIdentity } from "../dist/build-identity.js";
import { readBuildInfo } from "../dist/build-info.js";

const input = {
  sourceSha: "a".repeat(40),
  sourceVersion: "0.0.7",
  channel: "dev",
  date: "20261028",
  runId: "12345",
  attempt: "1",
};

test("build identity validates exact dev/alpha semver, SHA, date and unique run attempt", () => {
  for (const channel of ["dev", "alpha"]) {
    const build = makeBuildIdentity({ ...input, channel });
    assert.equal(build.version, `0.0.0-${channel}.20261028.12345.1`);
    assert.deepEqual(validateBuildIdentity(build, build.version), build);
    assert.notEqual(makeBuildIdentity({ ...input, channel, attempt: "2" }).version, build.version);
  }
  for (const patch of [
    { channel: "latest" },
    { channel: "stable" },
    { channel: "beta" },
    { date: "20260229" },
    { date: "20261301" },
    { runId: "01" },
    { attempt: "0" },
    { attempt: 1 },
    { runId: "9007199254740992" },
    { sourceSha: "0".repeat(40) },
    { sourceSha: "x".repeat(40) },
    { sourceSha: "a".repeat(39) },
    { sourceVersion: "0.0.7-beta.1" },
    { version: "0.0.7" },
    { version: "0.0.0-alpha.20261028.12345.1" },
    { schemaVersion: 2 },
    { tag: "dev" },
  ])
    assert.throws(() => makeBuildIdentity({ ...input, ...patch }));
  assert.throws(() => validateBuildIdentity(input));
});

test("build-info reads bounded installed receipts and refuses inconsistent or malformed metadata", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-build-info-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "package.json"),
    url = pathToFileURL(path),
    build = makeBuildIdentity(input);
  const manifest = { name: "@abijith-suresh/runnel", version: build.version, runnelBuild: build };
  writeFileSync(path, JSON.stringify(manifest));
  assert.deepEqual(readBuildInfo(url), { name: manifest.name, version: build.version, build });
  for (const value of [
    { ...manifest, version: "0.0.7" },
    { ...manifest, runnelBuild: { ...build, uri: "synthetic-private" } },
    { ...manifest, runnelBuild: null },
    { ...manifest, name: "other" },
  ]) {
    writeFileSync(path, JSON.stringify(value));
    assert.throws(() => readBuildInfo(url));
  }
  writeFileSync(path, "x".repeat(65537));
  assert.throws(() => readBuildInfo(url));
  writeFileSync(path, Buffer.from([123, 34, 110, 97, 109, 101, 34, 58, 34, 255, 34, 125]));
  assert.throws(() => readBuildInfo(url));
});

test("build-info is offline with invalid catalog location and --version stays backward compatible", () => {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "build-info"], {
    encoding: "utf8",
    env: { ...process.env, RUNNEL_HOME: "invalid-relative-directory" },
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.version, "0.0.7");
  assert.equal(parsed.data.build, null);
  const version = spawnSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(version.status, 0);
  assert.equal(version.stdout, "0.0.7\n");
});
