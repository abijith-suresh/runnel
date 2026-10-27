// Synthetic process for lifecycle tests. It never opens a DB or credential store.
let active = false;
let calls = 0;
process.on("SIGTERM", () => {});
if (process.env.RUNNEL_HOME?.endsWith("no-ready")) {
  setInterval(() => {}, 1000);
} else {
  process.send({ type: "ready" });
}
process.on("message", ({ type, id, request }) => {
  if (type === "shutdown") {
    process.send({ type: "shutdownComplete", id, closed: true }, () => process.exit(0));
    return;
  }
  if (active) process.exit(80);
  active = true;
  calls++;
  const mode = request.env;
  if (mode === "crash") process.exit(81);
  if (mode === "hang") return;
  if (mode === "invalid") {
    process.send({ type: "result", id, result: { ok: true, data: { nativeHandle: "forbidden" } } });
    return;
  }
  if (mode === "oversized") {
    process.send({
      type: "result",
      id,
      result: { ok: false, error: { code: "x", message: "x".repeat(1024 * 1024) } },
    });
    return;
  }
  setTimeout(
    () => {
      active = false;
      process.send({
        type: "result",
        id,
        result: {
          ok: true,
          data: {
            env: String(process.pid),
            db: mode ?? "none",
            collections: [{ name: String(calls), type: "collection" }],
            truncated: false,
          },
        },
      });
    },
    mode === "slow" ? 150 : 5
  );
});
