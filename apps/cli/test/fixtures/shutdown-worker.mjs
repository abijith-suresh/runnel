// Adversarial private-IPC fixture. It never imports a provider or a credential store.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.RUNNEL_HOME;
const mode = readFileSync(join(home, "mode"), "utf8");
const record = (event) =>
  appendFileSync(join(home, "events"), `${JSON.stringify({ pid: process.pid, event })}\n`);
let last;
const send = (value) => {
  if (process.connected) process.send(value, () => {});
};
process.on("message", (message) => {
  if (message.type === "shutdown") {
    record("shutdown");
    const ack = { type: "shutdownComplete", id: message.id, closed: true };
    if (mode === "no-ack") return;
    if (mode === "disconnect") {
      process.disconnect();
      setInterval(() => {}, 1000);
      return;
    }
    if (mode === "crash-on-close") process.exit(7);
    if (mode === "wrong-ack") {
      send({ ...ack, id: "a".repeat(36) });
      return;
    }
    if (mode === "malformed-ack") {
      send({ ...ack, uri: "synthetic-never-reflect" });
      return;
    }
    if (mode === "late-result" && last)
      send({
        type: "result",
        id: last.id,
        result: { ok: true, data: { databases: [], truncated: false } },
      });
    if (mode === "close-failed") ack.closed = false;
    const delay =
      mode === "daemon-close" ? 1700 : mode === "slow-close" || mode === "late-result" ? 180 : 0;
    setTimeout(() => {
      send(ack);
      if (mode === "duplicate-ack") send(ack);
      if (mode === "ack-hang") return;
      setTimeout(() => process.exit(mode === "ack-exit-error" || !ack.closed ? 1 : 0), 10);
    }, delay);
    return;
  }
  record("execute");
  last = message;
  if (message.request.env === "hang") return;
  send({
    type: "result",
    id: message.id,
    result: { ok: true, data: { databases: [], truncated: false } },
  });
});
record("start");
setTimeout(() => send({ type: "ready" }), mode === "slow-ready" ? 200 : 0);
