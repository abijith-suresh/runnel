import { catalogDirectory } from "./catalog.js";
import { workerOperations } from "./worker-operations.js";
import { bounded, decodeRequest, failure } from "./worker-protocol.js";

// Only the supervisor launches this internal entry point, using a private Node IPC channel.
if (!process.send) process.exit(1);
const operations = workerOperations(catalogDirectory());
let active = false;
let stopping = false;
const shutdown = async (id?: string) => {
  if (stopping) return;
  // Fence admissions and results before closing any driver handle.
  stopping = true;
  // The supervisor owns the shorter grace deadline. This also bounds orphaned cleanup.
  const deadline = setTimeout(() => process.exit(1), 2500);
  let closed = false;
  try {
    await operations.close();
    closed = true;
  } catch {
    // Never return native driver errors, URIs or exception text over IPC.
  }
  if (id !== undefined && process.connected) {
    await new Promise<void>((resolve) => {
      try {
        process.send?.({ type: "shutdownComplete", id, closed }, () => resolve());
      } catch {
        resolve();
      }
    });
  }
  clearTimeout(deadline);
  // The acknowledgement reports close completion, not process exit. Parent observes exit itself.
  process.exitCode = closed ? 0 : 1;
  if (process.connected) process.disconnect();
  // Driver code may retain handles. Do not leave an acknowledged process running indefinitely.
  process.exit(closed ? 0 : 1);
};
process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
process.on("message", (input) => {
  let message: ReturnType<typeof decodeRequest>;
  try {
    message = decodeRequest(input);
  } catch {
    void shutdown();
    return;
  }
  if (message.type === "shutdown") {
    void shutdown(message.id);
    return;
  }
  if (active || stopping) {
    void shutdown();
    return;
  }
  active = true;
  void operations
    .execute(message.request)
    .then((result) => {
      if (stopping) return;
      let response = { type: "result" as const, id: message.id, result };
      try {
        bounded(response);
      } catch {
        response = {
          type: "result",
          id: message.id,
          result: failure("ResultTooLarge", "The operation result exceeds the IPC size limit."),
        };
      }
      active = false;
      process.send?.(response, (error) => {
        if (error) void shutdown();
      });
    })
    .catch(() => void shutdown());
});
process.send({ type: "ready" }, (error) => {
  if (error) void shutdown();
});
