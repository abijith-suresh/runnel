import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import parse from "@changesets/parse";

export const packages = [
  { name: "@abijith-suresh/runnel-core", directory: "packages/core" },
  { name: "@abijith-suresh/runnel-mongodb", directory: "packages/mongodb" },
  { name: "@abijith-suresh/runnel", directory: "apps/cli" },
];
const names = packages.map((pkg) => pkg.name);
const changesetPath = (path) =>
  /^\.changeset\/[^/]+\.md$/.test(path) && path !== ".changeset/README.md";
const readJson = (root, file) => JSON.parse(readFileSync(resolve(root, file), "utf8"));
const fail = (message) => {
  throw new Error(message);
};

export function nextPatch(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) fail(`Expected a stable version, received ${version}`);
  const patch = Number(match[3]);
  if (!Number.isSafeInteger(patch + 1)) fail("Patch version exceeds the safe integer range");
  return `${match[1]}.${match[2]}.${patch + 1}`;
}

export function validateChangeset(text, filename = "Changeset") {
  const parsed = parse(text);
  if (!parsed.summary.trim() || !parsed.releases.length)
    fail(`${filename}: a summary and package are required`);
  const seen = new Set();
  for (const release of parsed.releases) {
    if (!names.includes(release.name))
      fail(`${filename}: unknown or private package ${release.name}`);
    if (release.type !== "patch")
      fail(`${filename}: only patch Changesets are allowed, including new features`);
    if (seen.has(release.name)) fail(`${filename}: duplicate package ${release.name}`);
    seen.add(release.name);
  }
  return parsed;
}

export function validateVersions(before, after) {
  for (const snapshot of [before, after]) {
    if (snapshot.length !== names.length) fail("All three public packages must be present");
    for (const [index, pkg] of snapshot.entries()) {
      if (pkg.name !== names[index]) fail("Package identities must not change during versioning");
      nextPatch(pkg.version);
      if (pkg.version !== snapshot[0].version) fail("Public package versions must stay aligned");
    }
  }
  if (before[0].version === after[0].version) return false;
  if (after[0].version !== nextPatch(before[0].version))
    fail(
      "Releases must advance by exactly one patch; minor, major, skips, and downgrades are forbidden"
    );
  return true;
}

export function validateRepository(root = process.cwd()) {
  const manifest = readJson(root, "package.json");
  if (manifest.private !== true) fail("The root must remain private");
  if (JSON.stringify(manifest.workspaces) !== JSON.stringify(packages.map((pkg) => pkg.directory)))
    fail("Review release policy before changing workspace boundaries");
  const manifests = packages.map((pkg) => readJson(root, `${pkg.directory}/package.json`));
  validateVersions(manifests, manifests);
  for (const pkg of manifests) {
    if (pkg.private || pkg.publishConfig?.access !== "public")
      fail(`${pkg.name} must be publishable with public access`);
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      if (name.startsWith("@abijith-suresh/runnel") && !names.includes(name))
        fail(`Unknown internal dependency ${name}`);
      if (names.includes(name) && version !== pkg.version)
        fail(`${pkg.name}: internal dependencies must use the aligned exact version`);
    }
    if (!/^4\.\d+\.\d+$/.test(pkg.dependencies?.effect ?? ""))
      fail(`${pkg.name}: pin stable Effect v4 explicitly`);
  }
  const core = manifests[0];
  if (
    [...Object.keys(core.dependencies ?? {}), ...Object.keys(core.devDependencies ?? {})].some(
      (name) => name === "mongodb" || name === names[1] || name === names[2]
    )
  )
    fail("Core must not depend on concrete providers or applications");
  if (
    manifests[1].dependencies?.[names[0]] !== core.version ||
    manifests[2].dependencies?.[names[1]] !== core.version ||
    manifests[2].dependencies?.[names[0]] !== core.version
  )
    fail("Declare the core -> adapter -> CLI dependency edges explicitly");
  const config = readJson(root, ".changeset/config.json");
  if (
    JSON.stringify(config.fixed) !== JSON.stringify([names]) ||
    config.ignore?.length ||
    config.updateInternalDependencies !== "patch" ||
    config.access !== "public" ||
    config.baseBranch !== "main" ||
    config.linked?.length
  )
    fail("Changesets must keep the public packages in one fixed patch group");
  const files = readdirSync(resolve(root, ".changeset"));
  if (files.includes("pre.json")) fail("Prerelease mode is outside the patch-only policy");
  const pending = files.filter((file) => changesetPath(`.changeset/${file}`));
  for (const file of pending)
    validateChangeset(readFileSync(resolve(root, ".changeset", file), "utf8"), file);
  const lock = readJson(root, "package-lock.json");
  for (const [index, pkg] of packages.entries()) {
    const locked = lock.packages?.[pkg.directory];
    if (
      locked?.version !== manifests[index].version ||
      JSON.stringify(locked?.dependencies) !== JSON.stringify(manifests[index].dependencies)
    )
      fail(`${pkg.directory}: package-lock.json is out of sync`);
  }
  return { manifests, pending };
}

export function checkPullRequest(root, base, head) {
  if (!/^[a-f\d]{40}$/.test(base ?? "") || !/^[a-f\d]{40}$/.test(head ?? ""))
    fail("BASE_SHA and HEAD_SHA must be full commit SHAs");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
  const at = (ref, file) => git("show", `${ref}:${file}`);
  const snapshots = [base, head].map((ref) =>
    packages.map((pkg) => JSON.parse(at(ref, `${pkg.directory}/package.json`)))
  );
  const versioned = validateVersions(...snapshots);
  const paths = git("diff", "--no-renames", "--name-only", "-z", base, head)
    .split("\0")
    .filter(Boolean);
  const added = git("diff", "--no-renames", "--diff-filter=A", "--name-only", "-z", base, head)
    .split("\0")
    .filter(changesetPath);
  const deleted = git("diff", "--no-renames", "--diff-filter=D", "--name-only", "-z", base, head)
    .split("\0")
    .filter(changesetPath);
  const changedNotes = paths.filter(changesetPath);
  if (!versioned) {
    if (!added.length) fail("Every ordinary PR must add a nonempty patch Changeset");
    if (changedNotes.some((path) => !added.includes(path)))
      fail("Merged Changesets are immutable until consumed by a version PR");
    for (const file of added) validateChangeset(at(head, file), file);
    return "Ordinary PR includes patch Changesets and leaves versions unchanged";
  }
  if (!deleted.length || added.length || changedNotes.some((path) => !deleted.includes(path)))
    fail("A version PR must consume existing patch Changesets without adding or editing them");
  const baseNotes = git("ls-tree", "-r", "--name-only", base, ".changeset")
    .trim()
    .split("\n")
    .filter(changesetPath);
  if (baseNotes.length !== deleted.length || baseNotes.some((file) => !deleted.includes(file)))
    fail("A version PR must consume all pending Changesets");
  for (const file of deleted) validateChangeset(at(base, file), file);
  const allowed = new Set([
    "package-lock.json",
    ...deleted,
    ...packages.flatMap((pkg) => [
      `${pkg.directory}/package.json`,
      `${pkg.directory}/CHANGELOG.md`,
    ]),
  ]);
  if (paths.some((path) => !allowed.has(path)))
    fail(
      "A version PR may change only versions, internal dependency versions, lockfile, changelogs, and consumed Changesets"
    );
  for (const [index, before] of snapshots[0].entries()) {
    const after = structuredClone(snapshots[1][index]);
    after.version = before.version;
    for (const name of names) {
      if (before.dependencies?.[name] !== undefined)
        after.dependencies[name] = before.dependencies[name];
    }
    if (!isDeepStrictEqual(before, after))
      fail("A version PR must not modify other package metadata");
  }
  return "Version PR consumes patch Changesets and advances all packages by one patch";
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    validateRepository();
    if (process.argv.includes("--pr")) {
      process.stdout.write(
        `${checkPullRequest(process.cwd(), process.env.BASE_SHA, process.env.HEAD_SHA)}\n`
      );
    } else {
      process.stdout.write("Patch-only release policy and workspace metadata passed\n");
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
