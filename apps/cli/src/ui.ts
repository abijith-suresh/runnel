import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { startManager } from "./ui-server.js";

/** Explicit foreground lifecycle. Browser launch is opt-in and receives only our generated URL. */
export async function runManager(directory: string, openBrowser = false): Promise<number> {
  const manager = await startManager(directory);
  const printPairing = () => {
    const url = manager.pairingUrl();
    process.stdout.write(`Runnel manager: ${url}\n`);
    return url;
  };
  const url = printPairing();
  process.stdout.write(
    "Pair within 60 seconds. Sessions last 15 minutes. Stop with Ctrl+C or Stop manager.\n"
  );
  const terminal = process.stdin.isTTY ? createInterface({ input: process.stdin }) : undefined;
  if (terminal) {
    process.stdout.write("Press Enter for a fresh pairing link.\n");
    terminal.on("line", printPairing);
    terminal.on("SIGINT", () => {
      void manager.stop();
    });
  }
  const stop = () => {
    void manager.stop();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (openBrowser) {
    const command =
      process.platform === "win32"
        ? "rundll32.exe"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";
    const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    child.once("error", () =>
      process.stderr.write("Cannot open the browser. Use the pairing link above.\n")
    );
    child.unref();
  }
  try {
    await manager.closed;
    return 0;
  } finally {
    terminal?.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
