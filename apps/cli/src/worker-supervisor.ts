import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  decodeOperation,
  decodeResponse,
  failure,
  type WorkerOperation,
  type WorkerResult,
} from "./worker-protocol.js";

interface Pending {
  id: string;
  request: WorkerOperation;
  timeoutMs: number;
  finish: (result: WorkerResult) => void;
  timer?: NodeJS.Timeout;
}
interface Session {
  child: ChildProcess;
  ready: Promise<boolean>;
  exited: Promise<void>;
  dead: boolean;
}
interface Options {
  /** Test seam for a synthetic IPC process; production uses worker.js. */
  entrypoint?: URL;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

/** One persistent child, one application operation at a time, and no automatic replay. */
export function createWorkerSupervisor(directory: string, options: Options = {}) {
  const queue: Pending[] = [];
  let session: Session | undefined;
  let active: Pending | undefined;
  let dispatching = false;
  let stopped = false;
  let changing: Promise<void> | undefined;
  const settle = (pending: Pending, result: WorkerResult) => {
    if (pending.timer) clearTimeout(pending.timer);
    pending.finish(result);
  };
  const failPending = (result: WorkerResult, queuedResult = result) => {
    if (active) settle(active, result);
    active = undefined;
    for (const pending of queue.splice(0)) settle(pending, queuedResult);
  };
  const kill = async (current: Session) => {
    current.dead = true;
    current.child.kill("SIGTERM");
    const force = setTimeout(
      () => current.child.kill("SIGKILL"),
      options.shutdownTimeoutMs ?? 1000
    );
    await current.exited;
    clearTimeout(force);
  };
  const broken = (current: Session, result: WorkerResult, queuedResult = result) => {
    if (session !== current || current.dead) return;
    current.dead = true;
    failPending(result, queuedResult);
    void kill(current);
  };
  const start = (): Session => {
    const child = fork(options.entrypoint ?? new URL("./worker.js", import.meta.url), [], {
      env: { ...process.env, RUNNEL_HOME: directory },
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
    });
    let ready!: (value: boolean) => void;
    let exited!: () => void;
    let announced = false;
    const current: Session = {
      child,
      dead: false,
      ready: new Promise((resolve) => {
        ready = resolve;
      }),
      exited: new Promise((resolve) => {
        exited = resolve;
      }),
    };
    session = current;
    const startup = setTimeout(() => {
      ready(false);
      broken(current, failure("WorkerUnavailable", "The database worker did not start in time."));
    }, options.startupTimeoutMs ?? 10000);
    child.on("message", (input) => {
      if (current.dead || session !== current) return;
      let message: ReturnType<typeof decodeResponse>;
      try {
        message = decodeResponse(input);
      } catch {
        broken(
          current,
          failure("WorkerProtocolError", "The database worker returned an invalid response.")
        );
        return;
      }
      if (message.type === "ready" && !announced) {
        announced = true;
        clearTimeout(startup);
        ready(true);
      } else if (message.type === "result" && announced && active?.id === message.id) {
        const completed = active;
        active = undefined;
        settle(completed, message.result);
        void pump();
      } else {
        broken(
          current,
          failure("WorkerProtocolError", "The database worker returned an unexpected response.")
        );
      }
    });
    child.on("error", () => {
      ready(false);
      broken(
        current,
        failure("WorkerUnavailable", "Cannot start or communicate with the database worker.")
      );
    });
    child.once("close", () => {
      clearTimeout(startup);
      ready(false);
      if (session === current) {
        if (!current.dead)
          failPending(
            failure("WorkerCrashed", "The database worker exited. Requests were not retried.")
          );
        session = undefined;
      }
      exited();
      void pump();
    });
    return current;
  };
  const pump = async () => {
    if (dispatching || active || changing || stopped || queue.length === 0) return;
    dispatching = true;
    try {
      if (session?.dead) await session.exited;
      if (changing || stopped || queue.length === 0) return;
      const current = session ?? start();
      if (!(await current.ready) || current.dead || session !== current || changing || stopped)
        return;
      const next = queue.shift();
      if (!next) return;
      active = next;
      if (next.timeoutMs > 0) {
        next.timer = setTimeout(() => {
          broken(
            current,
            failure(
              "OperationTimedOut",
              "The operation deadline expired. The worker was stopped and requests were not retried."
            ),
            failure(
              "WorkerRestarted",
              "The worker stopped after an active deadline. Queued requests were not retried."
            )
          );
        }, next.timeoutMs);
      }
      current.child.send({ type: "request", id: next.id, request: next.request }, (error) => {
        if (error)
          broken(
            current,
            failure("WorkerUnavailable", "Cannot communicate with the database worker.")
          );
      });
    } catch {
      failPending(
        failure("WorkerUnavailable", "Cannot start or communicate with the database worker.")
      );
    } finally {
      dispatching = false;
    }
  };
  const transition = (permanent: boolean): Promise<void> => {
    if (permanent) stopped = true;
    if (changing) return changing;
    failPending(
      failure(
        permanent ? "WorkerStopped" : "WorkerRestarted",
        "The database worker was stopped. Requests were not retried."
      )
    );
    const current = session;
    const completion = current ? kill(current) : Promise.resolve();
    changing = completion.finally(() => {
      changing = undefined;
    });
    return changing;
  };
  return {
    execute(input: unknown, timeoutMs = 15000): Promise<WorkerResult> {
      if (stopped)
        return Promise.resolve(
          failure("WorkerStopped", "The database worker supervisor is stopped.")
        );
      if (changing)
        return Promise.resolve(
          failure("WorkerRestarting", "The database worker is restarting. Retry after it finishes.")
        );
      if (queue.length >= 32)
        return Promise.resolve(
          failure("QueueFull", "The database operation queue is full. Retry later.")
        );
      let request: WorkerOperation;
      try {
        // Snapshot supplied objects so queued requests cannot change after validation.
        request = decodeOperation(input);
        request = decodeOperation(JSON.parse(JSON.stringify(request)) as unknown);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647)
          throw new Error("Invalid deadline");
      } catch {
        return Promise.resolve(
          failure(
            "RequestInvalid",
            "The operation request is invalid or exceeds the IPC size limit."
          )
        );
      }
      return new Promise((finish) => {
        queue.push({ id: randomUUID(), request, timeoutMs, finish });
        void pump();
      });
    },
    status: () => ({
      state: stopped ? "stopped" : changing ? "restarting" : session ? "running" : "idle",
      pid: session?.child.pid,
      active: active !== undefined,
      queued: queue.length,
    }),
    reset: () => transition(false),
    stop: () => transition(true),
  };
}
