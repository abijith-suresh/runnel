import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { gitEnvironment } from "./git-environment.mjs";
import { runNpm } from "./npm-command.mjs";
import {
  checkPullRequest,
  nextPatch,
  packages,
  validateChangeset,
  validateRepository,
  validateVersions,
} from "./release-policy.mjs";

const note = (type = "patch", name = packages[2].name) =>
  `---\n"${name}": ${type}\n---\nPrepare the development tooling.\n`;
const manifests = (version) => packages.map((pkg) => ({ name: pkg.name, version }));

test("patch increments accept only stable aligned versions and exactly one patch", () => {
  assert.equal(nextPatch("0.0.1"), "0.0.2");
  assert.equal(nextPatch("1.2.99"), "1.2.100");
  assert.equal(validateVersions(manifests("0.0.1"), manifests("0.0.1")), false);
  assert.equal(validateVersions(manifests("0.0.1"), manifests("0.0.2")), true);
  for (const version of [
    "0.1.0",
    "1.0.0",
    "0.0.3",
    "0.0.0",
    "0.0.2-beta.1",
    "0.0.2+build",
    "00.0.2",
  ]) {
    assert.throws(() => validateVersions(manifests("0.0.1"), manifests(version)));
  }
  const unaligned = manifests("0.0.2");
  unaligned[1].version = "0.0.1";
  assert.throws(() => validateVersions(manifests("0.0.1"), unaligned), /aligned/);
});

test("Changesets reject minor, major, empty, malformed, and unknown releases", () => {
  assert.equal(validateChangeset(note()).releases[0].type, "patch");
  for (const text of [
    note("minor"),
    note("major"),
    note("patch", "private-root"),
    "---\n---\nEmpty release.\n",
    "not frontmatter",
    '---\n"@abijith-suresh/runnel": patch\n---\n',
  ]) {
    assert.throws(() => validateChangeset(text));
  }
});

function fixture(t, pending = false) {
  const root = mkdtempSync(join(tmpdir(), "runnel-policy-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`
    );
  };
  const json = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
  for (const path of [
    "package.json",
    "package-lock.json",
    ".changeset/config.json",
    ...packages.map((pkg) => `${pkg.directory}/package.json`),
  ]) {
    write(path, readFileSync(resolve(path), "utf8"));
  }
  if (pending) write(".changeset/pending.md", note());
  const git = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnvironment(),
    }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Policy test");
  git("config", "user.email", "policy@example.invalid");
  const commit = () => {
    git("add", ".");
    git("commit", "-m", "chore: policy fixture");
    return git("rev-parse", "HEAD");
  };
  const base = commit();
  return { root, write, json, git, commit, base };
}

test("ordinary PRs require a newly added patch note and cannot edit merged notes", (t) => {
  const f = fixture(t, true);
  f.git("checkout", "-b", "changeset-release/main");
  f.write("docs/example.md", "Documentation change.\n");
  let head = f.commit();
  assert.throws(() => checkPullRequest(f.root, f.base, head), /must add/);
  f.write(".changeset/new.md", note());
  head = f.commit();
  assert.match(checkPullRequest(f.root, f.base, head), /Ordinary PR/);
  f.write(".changeset/pending.md", note("minor"));
  head = f.commit();
  assert.throws(() => checkPullRequest(f.root, f.base, head), /immutable/);
});

test("minor Changesets fail both PR checks and repository checks", (t) => {
  const f = fixture(t);
  f.write(".changeset/new.md", note("minor"));
  const head = f.commit();
  assert.throws(() => checkPullRequest(f.root, f.base, head), /only patch/);
  assert.throws(() => validateRepository(f.root), /only patch/);
});

test("version PRs consume notes, advance the fixed group, and reject hidden changes", (t) => {
  const f = fixture(t, true);
  const lock = f.json("package-lock.json");
  for (const pkg of packages) {
    const path = `${pkg.directory}/package.json`;
    const manifest = f.json(path);
    manifest.version = nextPatch(manifest.version);
    for (const dependency of packages) {
      if (manifest.dependencies[dependency.name])
        manifest.dependencies[dependency.name] = manifest.version;
    }
    f.write(path, manifest);
    lock.packages[pkg.directory].version = manifest.version;
    lock.packages[pkg.directory].dependencies = manifest.dependencies;
    f.write(
      `${pkg.directory}/CHANGELOG.md`,
      "# Changelog\n\n## Patch release\n\nDevelopment tooling.\n"
    );
  }
  f.write("package-lock.json", lock);
  rmSync(join(f.root, ".changeset/pending.md"));
  let head = f.commit();
  assert.match(checkPullRequest(f.root, f.base, head), /Version PR/);
  validateRepository(f.root);
  const manifest = f.json("apps/cli/package.json");
  manifest.scripts.build = "echo hidden release change";
  f.write("apps/cli/package.json", manifest);
  head = f.commit();
  assert.throws(() => checkPullRequest(f.root, f.base, head), /other package metadata/);
  f.write("apps/cli/src/cli.ts", "export {};\n");
  head = f.commit();
  assert.throws(() => checkPullRequest(f.root, f.base, head), /may change only/);
});

test("a manual patch bump without consumed Changesets is rejected", (t) => {
  const f = fixture(t);
  for (const pkg of packages) {
    const manifest = f.json(`${pkg.directory}/package.json`);
    manifest.version = nextPatch(manifest.version);
    f.write(`${pkg.directory}/package.json`, manifest);
  }
  f.write(".changeset/new.md", note());
  assert.throws(() => checkPullRequest(f.root, f.base, f.commit()), /consume existing/);
});

test("the guarded Changesets command produces a valid aligned version PR", (t) => {
  const f = fixture(t, true);
  for (const path of [
    "scripts/git-environment.mjs",
    "scripts/release-policy.mjs",
    "scripts/version-packages.mjs",
    "scripts/npm-command.mjs",
  ]) {
    f.write(path, readFileSync(resolve(path), "utf8"));
  }
  runNpm(["ci", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], {
    cwd: f.root,
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
  execFileSync(process.execPath, ["scripts/version-packages.mjs"], {
    cwd: f.root,
    env: gitEnvironment(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60000,
  });
  const after = validateRepository(f.root);
  assert.equal(after.pending.length, 0);
  for (const manifest of after.manifests) {
    assert.equal(
      manifest.version,
      nextPatch(
        JSON.parse(readFileSync(resolve(packages[0].directory, "package.json"), "utf8")).version
      )
    );
  }
  // Fixture helpers and dependency links are not release changes.
  f.git("add", ".changeset", "package-lock.json", ...packages.map((pkg) => pkg.directory));
  f.git("commit", "-m", "chore(release): version packages");
  assert.match(checkPullRequest(f.root, f.base, f.git("rev-parse", "HEAD")), /Version PR/);
});

test("repository checks reject Effect v3, private adapters, core provider dependencies, stale locks, and prerelease mode", (t) => {
  const f = fixture(t);
  validateRepository(f.root);
  const path = "packages/core/package.json";
  const original = f.json(path);
  for (const mutation of [
    (pkg) => {
      pkg.dependencies.effect = "3.21.0";
    },
    (pkg) => {
      pkg.private = true;
    },
    (pkg) => {
      pkg.dependencies.mongodb = "7.7.0";
    },
    (pkg) => {
      pkg.dependencies.effect = "4.0.0";
    },
  ]) {
    const manifest = structuredClone(original);
    mutation(manifest);
    f.write(path, manifest);
    assert.throws(() => validateRepository(f.root));
  }
  f.write(path, original);
  f.write(".changeset/pre.json", {});
  assert.throws(() => validateRepository(f.root), /Prerelease/);
});
