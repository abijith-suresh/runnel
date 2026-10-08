import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { gitEnvironment } from "./git-environment.mjs";

test("policy tests under a worktree hook leave the caller's repository untouched", (t) => {
  const caller = mkdtempSync(join(tmpdir(), "runnel-hook-caller-"));
  t.after(() => rmSync(caller, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: caller,
      env: gitEnvironment(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "caller");
  git("config", "user.name", "Hook caller");
  git("config", "user.email", "caller@example.invalid");
  writeFileSync(join(caller, "sentinel.txt"), "Caller repository must not change.\n");
  git("add", ".");
  git("-c", "core.hooksPath=/dev/null", "commit", "-m", "chore: caller fixture");
  const snapshot = () => [
    git("rev-parse", "HEAD"),
    git("symbolic-ref", "HEAD"),
    git("status", "--porcelain=v1"),
    git("config", "--local", "--list"),
    git("show-ref"),
  ];
  const before = snapshot();
  const directory = join(caller, ".git");
  const environment = gitEnvironment();
  // A nested runner must not inherit the parent's internal test-worker mode.
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--test", "--test-reporter=tap", resolve("scripts/release-policy.test.mjs")],
    {
      cwd: process.cwd(),
      env: {
        ...environment,
        GIT_DIR: directory,
        GIT_COMMON_DIR: directory,
        GIT_WORK_TREE: caller,
        GIT_INDEX_FILE: join(directory, "index"),
      },
      encoding: "utf8",
      // Allow bounded versioning and the remaining Git fixtures to finish.
      timeout: 120000,
    }
  );
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /# tests [1-9]\d*/);
  assert.match(result.stdout, /the guarded Changesets command produces a valid aligned version PR/);
  assert.deepEqual(snapshot(), before);
});
