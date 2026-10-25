import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { gitEnvironment } from "./git-environment.mjs";
import { packages } from "./release-policy.mjs";

test("PR policy reads its selected repository even under a worktree hook", (t) => {
  const root = mkdtempSync(join(tmpdir(), "runnel-hook-caller-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const caller = join(root, "caller");
  mkdirSync(caller);
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
  const target = join(root, "fixture");
  mkdirSync(target);
  const targetGit = (...args) =>
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: target,
      env: gitEnvironment(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  targetGit("init", "-b", "fixture");
  targetGit("config", "user.name", "Policy fixture");
  targetGit("config", "user.email", "policy@example.invalid");
  for (const pkg of packages) {
    const path = join(target, pkg.directory, "package.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ name: pkg.name, version: "0.0.1" }));
  }
  targetGit("add", ".");
  targetGit("commit", "-m", "chore: fixture");
  const base = targetGit("rev-parse", "HEAD");
  mkdirSync(join(target, ".changeset"));
  writeFileSync(
    join(target, ".changeset/note.md"),
    '---\n"@abijith-suresh/runnel": patch\n---\nPolicy fixture.\n'
  );
  targetGit("add", ".");
  targetGit("commit", "-m", "chore: patch note");
  const head = targetGit("rev-parse", "HEAD");
  const before = snapshot();
  const directory = join(caller, ".git");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {checkPullRequest} from ${JSON.stringify(new URL("./release-policy.mjs", import.meta.url).href)};
       process.stdout.write(checkPullRequest(${JSON.stringify(target)}, '${base}', '${head}'));`,
    ],
    {
      env: {
        ...process.env,
        GIT_DIR: directory,
        GIT_COMMON_DIR: directory,
        GIT_WORK_TREE: caller,
        GIT_INDEX_FILE: join(directory, "index"),
      },
      encoding: "utf8",
      timeout: 5000,
    }
  );
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`);
  assert.match(result.stdout, /Ordinary PR includes patch Changesets/);
  assert.deepEqual(snapshot(), before);
});
