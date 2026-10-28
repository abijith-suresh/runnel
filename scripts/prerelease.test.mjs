import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gitEnvironment } from "./git-environment.mjs";
import {
  preparePrerelease,
  snapshotCommit,
  validateDispatch,
  validateManifest,
  validatePreparationIdentity,
  verifyInstalledContents,
  verifyPrepared,
} from "./prerelease.mjs";
import { packages } from "./release-policy.mjs";

const identity = validatePreparationIdentity({
  sourceSha: "a".repeat(40),
  sourceVersion: "0.0.7",
  channel: "dev",
  date: "20261028",
  runId: "123",
  attempt: "1",
});
const digest = (bytes, algorithm = "sha256", encoding = "hex") =>
  createHash(algorithm).update(bytes).digest(encoding);
const temporary = (fn) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-prerelease-test-"));
  try {
    return fn(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};
function fixture(directory, installed = false) {
  const manifest = {
    schemaVersion: 1,
    build: identity,
    tag: "dev",
    publication: "disabled",
    requirements: { node: ">=24.19.0 <25", npm: "11.16.0" },
    packages: [],
  };
  for (const [index, pkg] of packages.entries()) {
    const metadata = {
      name: pkg.name,
      version: identity.version,
      publishConfig: { access: "public", tag: "dev" },
      runnelBuild: identity,
      dependencies: index ? { [packages[0].name]: identity.version } : {},
    };
    const content = Buffer.from(JSON.stringify(metadata));
    const home = join(directory, "node_modules", pkg.name);
    if (installed) {
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, "package.json"), content);
    }
    const bytes = Buffer.from(`synthetic package ${index}`);
    const filename = `package-${index}.tgz`;
    writeFileSync(join(directory, filename), bytes);
    manifest.packages.push({
      name: pkg.name,
      version: identity.version,
      filename,
      sha256: digest(bytes),
      integrity: `sha512-${digest(bytes, "sha512", "base64")}`,
      files: [{ path: "package.json", size: content.length, sha256: digest(content) }],
    });
  }
  save(directory, manifest);
  return manifest;
}
function save(directory, manifest) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, "manifest.json"), bytes);
  writeFileSync(
    join(directory, "SHA256SUMS"),
    `${[
      ...manifest.packages.map((pkg) => `${pkg.sha256}  ${pkg.filename}`),
      `${digest(bytes)}  manifest.json`,
    ].join("\n")}\n`
  );
}

test("dispatch allows only explicit trusted manual main preparation and disables publication", () => {
  const context = {
    eventName: "workflow_dispatch",
    repository: "abijith-suresh/runnel",
    ref: "refs/heads/main",
    sourceSha: identity.sourceSha,
    checkedOutSha: identity.sourceSha,
    identity,
    publishRequested: false,
  };
  assert.deepEqual(validateDispatch(context), identity);
  for (const patch of [
    { eventName: "push" },
    { repository: "other/runnel" },
    { ref: "refs/pull/1/merge" },
    { sourceSha: "b".repeat(40) },
    { checkedOutSha: "b".repeat(40) },
    { publishRequested: true },
    { publishRequested: "true" },
    { identity: { ...identity, channel: "stable" } },
  ])
    assert.throws(() => validateDispatch({ ...context, ...patch }));
  assert.throws(
    () => validateDispatch({ ...context, publishRequested: true, publicationGate: "approved" }),
    /disabled/
  );
});

test("artifact identity rejects stable/latest, mismatched channel, malformed SHA and ambiguous build numbering", () => {
  for (const patch of [
    { channel: "latest" },
    { channel: "stable" },
    { channel: "beta" },
    { version: "0.0.7" },
    { version: identity.version.replace("dev", "alpha") },
    { sourceSha: "a".repeat(39) },
    { sourceSha: "0".repeat(40) },
    { date: "20260230" },
    { runId: "01" },
    { attempt: "0" },
    { runId: "9007199254740992" },
  ])
    assert.throws(() => validatePreparationIdentity({ ...identity, ...patch }));
});

test("strict bundle verification detects changed tarball and checksum receipt", () =>
  temporary((directory) => {
    const manifest = fixture(directory);
    assert.deepEqual(verifyPrepared(directory), manifest);
    writeFileSync(join(directory, manifest.packages[0].filename), "tampered");
    assert.throws(() => verifyPrepared(directory), /checksum/);
    fixture(directory);
    writeFileSync(join(directory, "SHA256SUMS"), "tampered");
    assert.throws(() => verifyPrepared(directory), /checksum/);
  }));

test("manifest rejects unknown keys, traversal, duplicate names/files, stable tags and inconsistent versions", () =>
  temporary((directory) => {
    const base = fixture(directory);
    const mutations = [
      (m) => {
        m.authorization = true;
      },
      (m) => {
        m.publication = "authorized";
      },
      (m) => {
        m.tag = "latest";
      },
      (m) => {
        m.tag = "alpha";
      },
      (m) => {
        m.packages[0].version = "0.0.7";
      },
      (m) => {
        m.packages[1].name = m.packages[0].name;
      },
      (m) => {
        m.packages[0].filename = "../evil.tgz";
      },
      (m) => {
        m.packages[0].files[0].path = "dist/../../evil";
      },
      (m) => {
        m.packages[0].files[0].path = "dist\\evil";
      },
      (m) => {
        m.packages[0].files.push(m.packages[0].files[0]);
      },
      (m) => {
        m.packages[0].files[0].size = -1;
      },
    ];
    for (const mutate of mutations) {
      const m = structuredClone(base);
      mutate(m);
      assert.throws(() => validateManifest(m));
    }
  }));

test("installed hashes, exact file set and metadata are verified before execution", () =>
  temporary((directory) => {
    const manifest = fixture(directory, true);
    verifyInstalledContents(directory, manifest);
    const home = join(directory, "node_modules", packages[2].name);
    writeFileSync(join(home, "unexpected.js"), "throw Error('must never execute')");
    assert.throws(() => verifyInstalledContents(directory, manifest), /file list/);
    rmSync(join(home, "unexpected.js"));
    writeFileSync(join(home, "package.json"), "tampered");
    assert.throws(() => verifyInstalledContents(directory, manifest), /content/);
  }));

test("installed internally misaligned packages fail even with matching receipt hashes", () =>
  temporary((directory) => {
    const manifest = fixture(directory, true);
    const pkg = manifest.packages[2];
    const file = join(directory, "node_modules", pkg.name, "package.json");
    const metadata = JSON.parse(readFileSync(file, "utf8"));
    metadata.dependencies[packages[0].name] = "0.0.7";
    const bytes = Buffer.from(JSON.stringify(metadata));
    writeFileSync(file, bytes);
    pkg.files[0] = { path: "package.json", size: bytes.length, sha256: digest(bytes) };
    assert.throws(() => verifyInstalledContents(directory, manifest), /exact build/);
  }));

test("preparation refuses existing output before staging and preserves its contents", () =>
  temporary((directory) => {
    const output = join(directory, "existing");
    mkdirSync(output);
    writeFileSync(join(output, "keep"), "owner data");
    assert.throws(() => preparePrerelease(process.cwd(), output, identity), /already exists/);
    assert.equal(readFileSync(join(output, "keep"), "utf8"), "owner data");
  }));

test("invalid commit staging removes only its new output and leaves source unchanged", () =>
  temporary((directory) => {
    const source = readFileSync("package.json");
    const output = join(directory, "failed");
    assert.throws(
      () => preparePrerelease(process.cwd(), output, identity),
      /partial artifact directory was removed/
    );
    assert.equal(existsSync(output), false);
    assert.deepEqual(readFileSync("package.json"), source);
  }));

test("bounded Git snapshot uses committed bytes and rejects symlinks", () =>
  temporary((directory) => {
    const root = join(directory, "repo");
    mkdirSync(root);
    const git = (...args) =>
      execFileSync(
        "git",
        ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...gitEnvironment(),
            GIT_AUTHOR_NAME: "Fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "Fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
          },
          windowsHide: true,
        }
      );
    git("init", "--quiet");
    writeFileSync(join(root, "fixture"), "committed");
    git("add", "fixture");
    git("commit", "--quiet", "-m", "fixture");
    const sha = git("rev-parse", "HEAD").trim();
    writeFileSync(join(root, "fixture"), "uncommitted");
    const snapshot = join(directory, "snapshot");
    mkdirSync(snapshot);
    snapshotCommit(root, snapshot, sha);
    assert.equal(readFileSync(join(snapshot, "fixture"), "utf8"), "committed");
    assert.equal(readFileSync(join(root, "fixture"), "utf8"), "uncommitted");
    // Index-only symlink fixture works without Windows symlink privileges.
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      env: gitEnvironment(),
      input: "fixture",
      encoding: "utf8",
      windowsHide: true,
    }).trim();
    git("update-index", "--add", "--cacheinfo", `120000,${blob},link`);
    git("commit", "--quiet", "-m", "symlink fixture");
    assert.throws(
      () => snapshotCommit(root, snapshot, git("rev-parse", "HEAD").trim()),
      /unsupported/
    );
  }));

test("bundle upload boundary refuses unexpected sidecars", () =>
  temporary((directory) => {
    fixture(directory);
    writeFileSync(join(directory, "unexpected-log.txt"), "must not upload");
    assert.throws(() => verifyPrepared(directory), /unexpected files/);
  }));
