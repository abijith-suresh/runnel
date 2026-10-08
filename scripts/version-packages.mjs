import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNpm } from "./npm-command.mjs";
import { nextPatch, packages, validateRepository, validateVersions } from "./release-policy.mjs";

const before = validateRepository();
if (!before.pending.length) throw new Error("No pending patch Changesets to version");
const directory = mkdtempSync(join(tmpdir(), "runnel-version-plan-"));
try {
  const output = join(directory, "plan.json");
  runNpm(["exec", "--no", "--", "changeset", "status", "--output", output], {
    stdio: "inherit",
  });
  const plan = JSON.parse(readFileSync(output, "utf8"));
  if (
    plan.releases.length !== packages.length ||
    plan.releases.some(
      (release) =>
        !packages.some((pkg) => pkg.name === release.name) ||
        release.type !== "patch" ||
        release.newVersion !== nextPatch(before.manifests[0].version)
    )
  )
    throw new Error("Changesets produced a disallowed release plan");
  runNpm(["exec", "--no", "--", "changeset", "version"], { stdio: "inherit" });
  runNpm(["install", "--package-lock-only", "--ignore-scripts"], { stdio: "inherit" });
  const after = validateRepository();
  if (!validateVersions(before.manifests, after.manifests) || after.pending.length)
    throw new Error("Version output does not match the patch-only plan");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
