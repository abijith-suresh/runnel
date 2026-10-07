import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const executable = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const manifest: { version: string } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);
const run = (args: string[]) =>
  spawnSync(process.execPath, [executable, ...args], { encoding: "utf8" });

test("help and no arguments print available options on stdout", () => {
  for (const args of [[], ["--help"], ["-h"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /runnel \[--help \| --version\]/);
    assert.match(result.stdout, /-h, --help/);
    assert.match(result.stdout, /-v, --version/);
    assert.match(result.stdout, /Database commands are planned and are not implemented/);
  }
});

test("version flags print the owning package version", () => {
  for (const args of [["--version"], ["-v"]]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${manifest.version}\n`);
  }
});

test("help takes precedence when both information flags are supplied", () => {
  for (const args of [
    ["--help", "--version"],
    ["--version", "--help"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, run(["--help"]).stdout);
  }
});

test("unsupported commands, options, and malformed flags fail without stdout", () => {
  for (const args of [
    ["setup"],
    ["find", "users"],
    ["--env", "dint"],
    ["--help", "setup"],
    ["--help", "--unknown"],
    ["--version", "extra"],
    ["--help=true"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "Unsupported arguments. Run runnel --help for available options.\n"
    );
  }
});

test("version comes from the artifact's package metadata regardless of cwd", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-cli-version-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "dist"));
  const copied = join(directory, "dist/cli.js");
  copyFileSync(executable, copied);
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ type: "module", version: "0.0.42" })
  );
  const result = spawnSync(process.execPath, [copied, "--version"], {
    cwd: tmpdir(),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "0.0.42\n");
});

test("invalid package metadata produces a concise error and nonzero exit", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-cli-metadata-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "dist"));
  const copied = join(directory, "dist/cli.mjs");
  copyFileSync(executable, copied);
  for (const metadata of [undefined, "{", "{}", '{"version":42}', '{"version":""}']) {
    const file = join(directory, "package.json");
    if (metadata === undefined) rmSync(file, { force: true });
    else writeFileSync(file, metadata);
    const result = spawnSync(process.execPath, [copied, "--version"], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Cannot read Runnel package version.\n");
  }
});
