import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isStableSourceVersion, validateBuildIdentity } from "./build-identity.js";

/** Bounded offline receipt. No catalog, vault, daemon, network or Git dependency. */
export function readBuildInfo(path: URL = new URL("../package.json", import.meta.url)) {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK)
  );
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 65536) throw new Error("Invalid package receipt");
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 65536) throw new Error("Invalid package receipt");
    const manifest = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))
    ) as Record<string, unknown>;
    if (
      manifest["name"] !== "@abijith-suresh/runnel" ||
      typeof manifest["version"] !== "string" ||
      manifest["version"].length > 128
    )
      throw new Error("Invalid package receipt");
    if (manifest["runnelBuild"] === undefined && !isStableSourceVersion(manifest["version"]))
      throw new Error("Invalid package receipt");
    return {
      name: manifest["name"],
      version: manifest["version"],
      build:
        manifest["runnelBuild"] === undefined
          ? null
          : validateBuildIdentity(manifest["runnelBuild"], manifest["version"]),
    };
  } finally {
    closeSync(descriptor);
  }
}
