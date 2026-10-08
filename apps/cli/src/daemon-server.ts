import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { chmod, lstat, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import * as Effect from "effect/Effect";
import lockfile from "proper-lockfile";
import { readCatalog } from "./catalog.js";
import { readFrame } from "./daemon-frame.js";
import { type DaemonDescriptor, type DaemonResponse, decodeCommand } from "./daemon-protocol.js";
import {
  packageVersion,
  privateDirectory,
  readDaemonState,
  removeDaemonState,
  runtimeDirectory,
  socketPath,
  writeDaemonState,
} from "./daemon-state.js";
import { bounded, failure } from "./worker-protocol.js";
import { createWorkerSupervisor } from "./worker-supervisor.js";

export async function startDaemon(directory: string, options: { workerEntrypoint?: URL } = {}) {
  const runtime = await runtimeDirectory(directory, true);
  const instance = randomUUID();
  const descriptor: DaemonDescriptor = {
    protocol: 1,
    instance,
    endpoint: socketPath(runtime, instance),
    token: randomBytes(32).toString("hex"),
    pid: process.pid,
    version: packageVersion(),
  };
  let stop: ((afterWorker?: () => void) => Promise<void>) | undefined;
  let compromised = false;
  const release = await lockfile.lock(runtime, {
    stale: 10000,
    update: 3000,
    retries: { retries: 120, minTimeout: 100, maxTimeout: 100, factor: 1 },
    onCompromised: () => {
      compromised = true;
      void stop?.();
    },
  });
  const worker = createWorkerSupervisor(
    directory,
    options.workerEntrypoint ? { entrypoint: options.workerEntrypoint } : {}
  );
  const sockets = new Set<Socket>();
  let idle: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let inFlight = 0;
  let closed!: () => void;
  const completion = new Promise<void>((resolve) => {
    closed = resolve;
  });
  const server = createServer((socket) => {
    if (closing || sockets.size >= 64) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(2000, () => socket.destroy());
    const respond = (response: DaemonResponse) => {
      if (socket.destroyed) return;
      try {
        bounded(response);
        socket.end(`${JSON.stringify(response)}\n`);
      } catch {
        socket.destroy();
      }
    };
    void readFrame(socket)
      .then(async (input) => {
        let command: ReturnType<typeof decodeCommand>;
        try {
          command = decodeCommand(input);
        } catch {
          respond(failure("RequestInvalid", "The daemon request is invalid."));
          return;
        }
        if (
          !timingSafeEqual(Buffer.from(command.token, "hex"), Buffer.from(descriptor.token, "hex"))
        ) {
          respond(
            failure("DaemonAuthenticationFailed", "Cannot authenticate with the Runnel daemon.")
          );
          return;
        }
        socket.setTimeout(0);
        if (closing) {
          respond(failure("DaemonStopping", "The Runnel daemon is stopping."));
          return;
        }
        if (command.action === "status") {
          const { pid, ...status } = worker.status();
          respond({
            ok: true,
            data: {
              running: true,
              pid: process.pid,
              version: descriptor.version,
              worker: { ...status, ...(pid === undefined ? {} : { pid }) },
            },
          });
        } else if (command.action === "stop") {
          void stop?.(() => respond({ ok: true, data: { stopped: true } }));
        } else {
          inFlight++;
          if (idle) clearTimeout(idle);
          try {
            if (command.action === "reset") {
              await worker.reset();
              respond({ ok: true, data: { reset: true } });
            } else if (command.action === "execute") respond(await worker.execute(command.request));
          } finally {
            inFlight--;
            armIdle();
          }
        }
      })
      .catch(() => socket.destroy());
  });
  const stopListening = () =>
    new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      const force = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
      }, 1500);
      server.once("close", () => clearTimeout(force));
    });
  stop = (afterWorker) => {
    if (closing) return closing;
    if (idle) clearTimeout(idle);
    closing = (async () => {
      // Stop accepting first; pending operation failures can still reach attached clients.
      const listening = stopListening();
      try {
        await worker.stop();
        afterWorker?.();
        await listening;
      } finally {
        await removeDaemonState(directory, instance).catch(() => undefined);
        await release().catch(() => undefined);
        closed();
      }
    })();
    return closing;
  };
  let idleTimeoutMs = 300000;
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    if (!closing && inFlight === 0 && idleTimeoutMs > 0)
      idle = setTimeout(() => void stop?.(), idleTimeoutMs);
  };
  server.on("error", () => void stop?.());
  try {
    // A stale lock never authorizes killing or replacing a live descriptor PID.
    const previous = await readDaemonState(directory);
    if (previous) {
      try {
        process.kill(previous.pid, 0);
        throw new Error("A daemon process is already present.");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    const catalog = await Effect.runPromise(readCatalog(directory));
    idleTimeoutMs = catalog.settings.idleTimeoutMs;
    if (process.platform !== "win32") {
      await privateDirectory(dirname(descriptor.endpoint));
      try {
        const info = await lstat(descriptor.endpoint);
        if (!info.isSocket() || (process.getuid && info.uid !== process.getuid()))
          throw new Error("Invalid socket destination");
        await rm(descriptor.endpoint);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path: descriptor.endpoint, readableAll: false, writableAll: false }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    if (process.platform !== "win32") await chmod(descriptor.endpoint, 0o600);
    if (compromised) throw new Error("Daemon ownership lock was lost.");
    await writeDaemonState(runtime, descriptor);
    armIdle();
    const shutdown = stop;
    return { descriptor, stop: () => shutdown(), closed: completion };
  } catch (error) {
    await stop();
    throw error;
  }
}
