// Test-only bootstrap: real installed worker and adapter, synthetic credential/driver I/O.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

const driverUrl = import.meta.resolve("mongodb");
const consumer = fileURLToPath(new URL(".", import.meta.url));
const home = resolve(process.env.RUNNEL_HOME ?? "");
assert(
  home.startsWith(`${resolve(consumer)}${sep}`),
  "An owned installed fixture home is required"
);
const scenario = JSON.parse(readFileSync(resolve(home, "fixture.json"), "utf8"));
const marker = resolve(home, "driver-events.jsonl");
const record = (event, extra = {}) =>
  appendFileSync(
    marker,
    `${JSON.stringify({ event, pid: process.pid, at: Date.now(), ...extra })}\n`
  );
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const pending = () => new Promise(() => {});

// Resolve before the production worker imports secrets. The native credential package is never loaded.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "mongodb") return { url: driverUrl, shortCircuit: true };
    if (specifier === "@napi-rs/keyring")
      return {
        url: `data:text/javascript,${encodeURIComponent(`
          export class AsyncEntry {
            async getPassword() { return "mongodb://synthetic:owned-driver@fixture.invalid/accounts"; }
            async setPassword() { throw new Error("Unexpected synthetic vault write"); }
            async deleteCredential() { throw new Error("Unexpected synthetic vault deletion"); }
          }
        `)}`,
        shortCircuit: true,
      };
    return nextResolve(specifier, context);
  },
});
const clients = new WeakMap();
let nextClient = 0;
function clientId(client) {
  if (!clients.has(client)) {
    clients.set(client, ++nextClient);
    record("client-open", { client: nextClient });
  }
  return clients.get(client);
}
async function operation(database) {
  record("operation-start", { database });
  if (scenario.operation === "hang") await pending();
  if (scenario.operation === "slow") await pause(120);
  record("operation-complete", { database });
}
// The real MongoClient constructor and adapter own client lifetime. Only external driver I/O is fake.
MongoClient.prototype.connect = async () => {
  throw new Error("Synthetic fixture forbids native database connections");
};
MongoClient.prototype.db = function (database) {
  clientId(this);
  return {
    async command() {
      await operation(database);
      return { ok: 1 };
    },
    listCollections() {
      let sent = false;
      return {
        async next() {
          if (sent) return { done: true };
          sent = true;
          await operation(database);
          return { done: false, value: { name: "owned_collection", type: "collection" } };
        },
        [Symbol.asyncIterator]() {
          return this;
        },
        async close() {
          record("cursor-close");
        },
      };
    },
  };
};
MongoClient.prototype.close = async function () {
  const client = clientId(this);
  record("close-start", { client });
  if (scenario.close === "hang") await pending();
  if (scenario.close === "reject")
    throw new Error("Synthetic close failure, never return this text");
  await pause(scenario.closeDelayMs ?? 50);
  record("close-complete", { client });
};
record("bootstrap");
await import(new URL("./node_modules/@abijith-suresh/runnel/dist/worker.js", import.meta.url));
