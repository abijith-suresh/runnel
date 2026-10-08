import { catalogDirectory } from "./catalog.js";
import { startDaemon } from "./daemon-server.js";

// Internal detached entry point. Only the CLI client launches it.
try {
  const daemon = await startDaemon(catalogDirectory());
  process.on("SIGTERM", () => void daemon.stop());
  process.on("SIGINT", () => void daemon.stop());
  await daemon.closed;
} catch {
  process.exitCode = 1;
}
