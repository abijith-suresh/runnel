import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installLocal } from "./local-install.mjs";

test("local installation refuses existing destinations without adopting or deleting them", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "runnel-install-policy-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, "existing");
  mkdirSync(directory);
  const empty = join(parent, "empty");
  mkdirSync(empty);
  const sentinel = join(directory, "keep.txt");
  writeFileSync(sentinel, "existing user data");
  const file = join(parent, "file");
  writeFileSync(file, "existing file");
  const link = join(parent, "link");
  symlinkSync(directory, link, process.platform === "win32" ? "junction" : "dir");
  for (const destination of [parent, directory, empty, file, link])
    assert.throws(() => installLocal(process.cwd(), destination), /already exists/);
  assert.equal(readFileSync(sentinel, "utf8"), "existing user data");
  assert.equal(readFileSync(file, "utf8"), "existing file");
  assert(existsSync(link));
});

test("local installation rejects relative paths and missing parents", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "runnel-install-policy-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  for (const destination of [undefined, "", ".", "relative-install"])
    assert.throws(() => installLocal(process.cwd(), destination), /absolute path/);
  const missing = join(parent, "missing", "install");
  assert.throws(() => installLocal(process.cwd(), missing), /parent must exist/);
  assert.equal(existsSync(join(parent, "missing")), false);
});

test("a failed npm invocation removes only the newly created installation", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "runnel install rollback # % & "));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const sentinel = join(parent, "keep.txt");
  writeFileSync(sentinel, "existing sibling");
  const destination = join(parent, "new install");
  const original = process.env.npm_execpath;
  try {
    // Fail before packing. No network, fake packages or workspace mutations are needed.
    delete process.env.npm_execpath;
    assert.throws(() => installLocal(process.cwd(), destination), /partial directory was removed/);
  } finally {
    if (original !== undefined) process.env.npm_execpath = original;
  }
  assert.equal(existsSync(destination), false);
  assert.equal(readFileSync(sentinel, "utf8"), "existing sibling");
});
