import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { packages, validateRepository } from "./release-policy.mjs";

const root = process.cwd();
const { manifests } = validateRepository(root);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const temporary = mkdtempSync(join(tmpdir(), "runnel-pack-"));
const runNpm = (args, cwd = root) =>
  execFileSync(npm, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
try {
  const tarballs = [];
  for (const [index, pkg] of packages.entries()) {
    const manifest = manifests[index];
    const destinations = [
      manifest.main,
      manifest.types,
      ...Object.values(manifest.exports["."]),
      ...Object.values(manifest.bin ?? {}),
    ];
    const dry = JSON.parse(
      runNpm(["pack", "--dry-run", "--json", "--ignore-scripts", "--workspace", pkg.name])
    )[0];
    const files = new Set(dry.files.map((file) => file.path));
    for (const destination of destinations) {
      assert(
        files.has(destination.replace(/^\.\//, "")),
        `${pkg.name}: packed destination missing: ${destination}`
      );
      assert(
        existsSync(resolve(pkg.directory, destination)),
        `Build output missing: ${destination}`
      );
    }
    assert(
      files.has("LICENSE") && files.has("README.md"),
      `${pkg.name}: license and README must be packed`
    );
    assert(
      !dry.files.some((file) => file.path.startsWith("src/") || file.path.endsWith(".tsbuildinfo")),
      "Source and build cache must not enter the package"
    );
    if (manifest.bin)
      assert(
        readFileSync(resolve(pkg.directory, manifest.bin.runnel), "utf8").startsWith(
          "#!/usr/bin/env node\n"
        ),
        "CLI executable needs its shebang"
      );
    const [packed] = JSON.parse(
      runNpm([
        "pack",
        "--json",
        "--ignore-scripts",
        "--workspace",
        pkg.name,
        "--pack-destination",
        temporary,
      ])
    );
    tarballs.push(join(temporary, packed.filename));
  }
  const consumer = join(temporary, "consumer");
  execFileSync(process.execPath, ["-e", "require('node:fs').mkdirSync(process.argv[1])", consumer]);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
  // Local install only. Supplying all three tarballs resolves internal packages without a registry release.
  runNpm(
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...tarballs],
    consumer
  );
  const imports = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "await import('@abijith-suresh/runnel-core'); await import('@abijith-suresh/runnel-mongodb'); await import('@abijith-suresh/runnel'); await import('effect'); await import('mongodb');",
    ],
    { cwd: consumer, encoding: "utf8" }
  );
  assert.equal(imports.status, 0, imports.stderr);
  const cli = spawnSync(
    process.execPath,
    [join(consumer, "node_modules/@abijith-suresh/runnel/dist/cli.js")],
    { cwd: consumer, encoding: "utf8" }
  );
  assert.equal(cli.status, 1);
  assert.equal(cli.stdout, "");
  assert.match(cli.stderr, /Planned commands are not implemented/);
  process.stdout.write(
    "All three npm pack dry runs, isolated tarball installs, imports, and CLI entry point passed\n"
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
