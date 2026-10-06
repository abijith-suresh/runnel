import { rmSync } from "node:fs";

for (const directory of ["packages/core", "packages/mongodb", "apps/cli"]) {
  rmSync(`${directory}/dist`, { recursive: true, force: true });
  rmSync(`${directory}/tsconfig.tsbuildinfo`, { force: true });
}
