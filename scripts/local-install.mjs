import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runNpm } from "./npm-command.mjs";
import { packages, validateRepository } from "./release-policy.mjs";

/** Install all public workspace artifacts together into a newly owned directory. */
export function installLocal(root, destination) {
  if (typeof destination !== "string" || !isAbsolute(destination))
    throw new Error("Supply an absolute path to a new installation directory.");
  const { manifests } = validateRepository(root);
  const directory = resolve(destination);
  try {
    // Outside the rollback scope: an existing file, directory or link is never ours to remove.
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    throw new Error(
      error.code === "EEXIST"
        ? "The installation destination already exists. Choose a new directory."
        : "Cannot create the installation directory. Its parent must exist and be writable."
    );
  }
  const invoke = (args, cwd) =>
    runNpm(args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    const artifacts = join(directory, "artifacts");
    mkdirSync(artifacts);
    const packed = JSON.parse(
      invoke(
        ["pack", "--workspaces", "--json", "--ignore-scripts", "--pack-destination", artifacts],
        root
      )
    );
    assert.deepEqual(
      packed.map(({ name }) => name).sort(),
      packages.map(({ name }) => name).sort()
    );
    const tarballs = packed.map(({ filename }) => {
      assert(
        typeof filename === "string" && basename(filename) === filename && filename.endsWith(".tgz")
      );
      return join(artifacts, filename);
    });
    writeFileSync(
      join(directory, "package.json"),
      `${JSON.stringify({ private: true, type: "module" })}\n`,
      { mode: 0o600 }
    );
    // Keep tarballs beside the install so its file dependencies remain available for npm ci.
    invoke(["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], directory);
    const version = manifests[0].version;
    assert.equal(
      invoke(["exec", "--offline", "--no", "--", "runnel", "--version"], directory).trim(),
      version
    );
    const binDirectory = join(directory, "node_modules", ".bin");
    const executable = join(binDirectory, process.platform === "win32" ? "runnel.cmd" : "runnel");
    assert(existsSync(executable), "The installed runnel executable is missing.");
    return { directory, binDirectory, executable, version };
  } catch (error) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      throw new Error("Local installation failed and its partial directory could not be removed.");
    }
    throw new Error(
      "Local installation failed. Check the build and npm connectivity. The partial directory was removed.",
      { cause: error }
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3)
      throw new Error("Usage: npm run install:local -- /absolute/new-directory");
    process.stdout.write(`${JSON.stringify(installLocal(process.cwd(), process.argv[2]))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
