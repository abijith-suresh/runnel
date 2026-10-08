import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { readCatalog } from "./catalog.js";
import { readFrame } from "./daemon-frame.js";
import {
  type DaemonDescriptor,
  type DaemonResponse,
  decodeDaemonResponse,
} from "./daemon-protocol.js";
import { daemonStateError, packageVersion, readDaemonState } from "./daemon-state.js";
import { bounded, decodeOperation, failure } from "./worker-protocol.js";

class BeforeSend extends Error {}
const cancelled = () =>
  failure(
    "OperationCancelled",
    "The attached operation was cancelled and was not retried. Database writes may already have occurred."
  );

export async function daemonExchange(
  descriptor: DaemonDescriptor,
  command: { action: "status" | "reset" | "stop" } | { action: "execute"; request: unknown },
  signal?: AbortSignal
): Promise<DaemonResponse> {
  if (signal?.aborted) throw new BeforeSend();
  if (process.platform !== "win32") {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(descriptor.endpoint);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new BeforeSend();
      throw daemonStateError();
    }
    if (
      !info.isSocket() ||
      (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
    )
      throw daemonStateError();
  }
  const input = { ...command, token: descriptor.token };
  bounded(input);
  if (signal?.aborted) throw new BeforeSend();
  const socket = createConnection(descriptor.endpoint);
  let sent = false;
  socket.on("error", () => {});
  socket.setTimeout(2000, () => socket.destroy());
  const response = readFrame(socket);
  const abort = () => socket.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  socket.once("connect", () => {
    if (signal?.aborted) {
      socket.destroy();
      return;
    }
    sent = true;
    // Active operation deadlines belong to the supervisor; queue wait has no response timer.
    socket.setTimeout(command.action === "execute" ? 0 : 5000, () => socket.destroy());
    socket.write(`${JSON.stringify(input)}\n`);
  });
  try {
    return decodeDaemonResponse(await response);
  } catch (error) {
    if (!sent) throw new BeforeSend();
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    socket.destroy();
  }
}

async function readyDaemon(
  directory: string,
  signal?: AbortSignal
): Promise<DaemonDescriptor | DaemonResponse> {
  if (signal?.aborted) return cancelled();
  const current = await readDaemonState(directory);
  if (signal?.aborted) return cancelled();
  if (current) {
    try {
      const status = await daemonExchange(current, { action: "status" }, signal);
      return status.ok ? current : status;
    } catch (error) {
      if (signal?.aborted) return cancelled();
      if (!(error instanceof BeforeSend))
        return failure(
          "DaemonUnavailable",
          "Cannot communicate with the Runnel daemon. It was not restarted."
        );
    }
  }
  const catalog = await Effect.runPromise(readCatalog(directory).pipe(Effect.result));
  if (signal?.aborted) return cancelled();
  if (Result.isFailure(catalog)) return { ok: false, error: catalog.failure };
  const child = spawn(process.execPath, [fileURLToPath(new URL("./daemon.js", import.meta.url))], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, RUNNEL_HOME: directory },
  });
  let failed = false;
  child.once("error", () => {
    failed = true;
  });
  child.unref();
  for (let attempt = 0; attempt < 150 && !failed; attempt++) {
    if (signal?.aborted) return cancelled();
    const candidate = await readDaemonState(directory);
    if (signal?.aborted) return cancelled();
    if (candidate) {
      try {
        const status = await daemonExchange(candidate, { action: "status" }, signal);
        if (status.ok) {
          if (candidate.pid !== child.pid) child.kill();
          return candidate;
        }
        child.kill();
        return status;
      } catch (error) {
        if (signal?.aborted) return cancelled();
        if (!(error instanceof BeforeSend)) {
          child.kill();
          return failure(
            "DaemonUnavailable",
            "Cannot communicate with the Runnel daemon. It was not restarted."
          );
        }
      }
    }
    await delay(100, undefined, signal ? { signal } : {}).catch(() => undefined);
  }
  child.kill();
  return failure(
    "DaemonUnavailable",
    "The Runnel daemon did not start. Check its runtime directory and retry."
  );
}

export async function daemonCommand(
  directory: string,
  action: "status" | "reset" | "stop"
): Promise<DaemonResponse> {
  try {
    const descriptor = await readDaemonState(directory);
    if (!descriptor) return { ok: true, data: { running: false } };
    try {
      return await daemonExchange(descriptor, { action });
    } catch (error) {
      if (error instanceof BeforeSend) return { ok: true, data: { running: false } };
      throw error;
    }
  } catch {
    return failure("DaemonUnavailable", "Cannot read or communicate with the Runnel daemon.");
  }
}

export async function executeWithDaemon(
  directory: string,
  input: unknown,
  signal?: AbortSignal
): Promise<DaemonResponse> {
  if (signal?.aborted) return cancelled();
  let request: ReturnType<typeof decodeOperation>;
  try {
    request = decodeOperation(JSON.parse(JSON.stringify(decodeOperation(input))) as unknown);
    bounded({ action: "execute", token: "0".repeat(64), request });
  } catch {
    return failure(
      "RequestInvalid",
      "The operation request is invalid or exceeds the IPC size limit."
    );
  }
  try {
    const ready = await readyDaemon(directory, signal);
    if ("ok" in ready) return ready;
    if (ready.version !== packageVersion())
      return failure(
        "DaemonVersionMismatch",
        "The daemon uses another Runnel version. Run runnel daemon stop and retry."
      );
    try {
      return await daemonExchange(ready, { action: "execute", request }, signal);
    } catch {
      if (signal?.aborted) return cancelled();
      return failure(
        "OperationOutcomeUnknown",
        "The daemon connection ended without a result. The operation was not retried."
      );
    }
  } catch {
    if (signal?.aborted) return cancelled();
    return failure(
      "DaemonUnavailable",
      "Cannot prepare the Runnel daemon. Check the catalog and private runtime directory."
    );
  }
}
