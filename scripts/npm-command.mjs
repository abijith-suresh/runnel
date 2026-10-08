import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";

/** npm supplies its JavaScript entry point to scripts; invoke it without a shell. */
export function runNpm(args, options = {}) {
  const entry = process.env.npm_execpath;
  if (!entry || !isAbsolute(entry) || !/\.(?:c?js|mjs)$/i.test(entry))
    throw new Error(
      "Run this check through npm so npm_execpath identifies its JavaScript entry point."
    );
  return execFileSync(process.execPath, [entry, ...args], { ...options, shell: false });
}
