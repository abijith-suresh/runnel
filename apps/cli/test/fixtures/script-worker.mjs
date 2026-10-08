// Real script execution and IPC, injected synthetic credentials, and lazy native handles.
import { createMongoPool } from "@abijith-suresh/runnel-mongodb";
import * as Effect from "effect/Effect";
import { MongoClient } from "mongodb";
import { credentialStore } from "../../dist/secrets.js";
import { workerOperations } from "../../dist/worker-operations.js";

const operations = workerOperations(
  process.env.RUNNEL_HOME,
  createMongoPool((_uri, options) => new MongoClient("mongodb://127.0.0.1:1", options)),
  { ...credentialStore(), read: () => Effect.succeed("synthetic-uri") }
);
process.on("SIGTERM", () => void operations.close().finally(() => process.exit(0)));
process.on("disconnect", () => void operations.close().finally(() => process.exit(0)));
process.on("message", ({ id, request }) => {
  void operations.execute(request).then((result) => process.send({ type: "result", id, result }));
});
process.send({ type: "ready" });
