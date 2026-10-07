import { catalogDirectory } from "./catalog.js";
import { workerOperations } from "./worker-operations.js";
import { bounded, decodeRequest, failure } from "./worker-protocol.js";

// Only the supervisor launches this internal entry point, using a private Node IPC channel.
if (!process.send) process.exit(1);
const operations = workerOperations(catalogDirectory());
let active = false;
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 1000);
  try {
    await operations.close();
  } finally {
    clearTimeout(deadline);
    process.exit(0);
  }
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
