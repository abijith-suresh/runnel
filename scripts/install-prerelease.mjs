import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installPrepared } from "./prerelease.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4)
      throw new Error(
        "Usage: npm run install:prerelease -- /absolute/bundle /absolute/new-installation"
      );
    const installation = installPrepared(process.argv[2], process.argv[3]);
    process.stdout.write(`${JSON.stringify(installation)}\n`);
  } catch {
    process.stderr.write(
      "Cannot install the prepared Runnel bundle. Verify the approved source/checksums, runtime, offline dependency cache and new absolute destination.\n"
    );
    process.exitCode = 1;
  }
}
