import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runNpm } from "./npm-command.mjs";

test("npm runs the pinned CLI through Node", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.equal(
    runNpm(["--version"], { encoding: "utf8" }).trim(),
    manifest.packageManager.split("@")[1]
  );
});

test("npm paths and arguments preserve spaces and shell punctuation without a shell", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel npm check "));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entry = join(directory, "npm entry.mjs");
  writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  const original = process.env.npm_execpath;
  try {
    process.env.npm_execpath = entry;
    const args = [
      "space here",
      "$(echo unexpected)",
      "`echo unexpected`",
      "a&b",
      "a|b",
      '"quoted"',
    ];
    assert.deepEqual(JSON.parse(runNpm(args, { cwd: directory, encoding: "utf8" })), args);
    for (const value of [undefined, "npm.cmd", join(directory, "npm.cmd")]) {
      if (value === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = value;
      assert.throws(() => runNpm([]), /Run this check through npm/);
    }
  } finally {
    if (original === undefined) delete process.env.npm_execpath;
    else process.env.npm_execpath = original;
  }
});
