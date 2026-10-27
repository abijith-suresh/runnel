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
  detach?: () => void;
}
export interface WorkerShutdownResult {
  readonly mode: "graceful" | "forced" | "unconfirmed" | "not-running";
  readonly acknowledged: boolean;
}
interface Session {
  child: ChildProcess;
  ready: Promise<boolean>;
  markReady: (ready: boolean) => void;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  fenced: boolean;
  startup?: NodeJS.Timeout;
  shutdown?: {
    id?: string;
    acknowledged: boolean;
    completed: boolean;
    forced: boolean;
    timer?: NodeJS.Timeout;
    result: Promise<WorkerShutdownResult>;
  };
}
interface Options {
  /** Test seam for a synthetic IPC process; production uses worker.js. */
  entrypoint?: URL;
  startupTimeoutMs?: number;
  /** Grace window for normal IPC shutdown, not an operation-cancellation delay. */
  shutdownTimeoutMs?: number;
}

/** One persistent child, one application operation at a time, and no automatic replay. */
export function createWorkerSupervisor(directory: string, options: Options = {}) {
  const queue: Pending[] = [];
  let session: Session | undefined;
  let active: Pending | undefined;
  let dispatching = false;
  let stopped = false;
  let changing: Promise<WorkerShutdownResult> | undefined;
  let stoppedResult: Promise<WorkerShutdownResult> | undefined;
  const settle = (pending: Pending, result: WorkerResult) => {
    if (pending.timer) clearTimeout(pending.timer);
    pending.detach?.();
    pending.finish(result);
  };
  const failPending = (result: WorkerResult, queuedResult = result) => {
    if (active) settle(active, result);
    active = undefined;
    for (const pending of queue.splice(0)) settle(pending, queuedResult);
  };
  const force = (current: Session) => {
    const shutdown = current.shutdown;
    if (!shutdown || shutdown.forced) return;
    shutdown.forced = true;
    if (shutdown.timer) clearTimeout(shutdown.timer);
    // Cancellation/protocol failure must work even when the JS event loop cannot run cleanup.
    try {
      current.child.kill("SIGKILL");
    } catch {
      /* Actual child close remains authoritative. */
    }
  };
  const shutdown = (current: Session, graceful: boolean): Promise<WorkerShutdownResult> => {
    current.fenced = true;
    current.markReady(false);
    if (current.startup) clearTimeout(current.startup);
    if (current.shutdown) {
      if (!graceful) force(current);
      return current.shutdown.result;
    }
    const state: NonNullable<Session["shutdown"]> = {
      ...(graceful ? { id: randomUUID() } : {}),
      acknowledged: false,
      completed: false,
      forced: false,
      result: current.exited.then(({ code, signal }) => {
        if (state.timer) clearTimeout(state.timer);
        return {
          mode: state.forced
            ? "forced"
            : state.acknowledged && state.completed && code === 0 && signal === null
              ? "graceful"
              : "unconfirmed",
          acknowledged: state.acknowledged,
        };
      }),
    };
    current.shutdown = state;
    if (!graceful || !current.child.connected) force(current);
    else {
      state.timer = setTimeout(() => force(current), options.shutdownTimeoutMs ?? 2000);
      try {
        current.child.send({ type: "shutdown", id: state.id }, (error) => {
          if (error) force(current);
        });
      } catch {
        force(current);
      }
    }
    return state.result;
  };
  const broken = (current: Session, result: WorkerResult, queuedResult = result) => {
    if (session !== current || current.fenced) return;
    current.fenced = true;
    failPending(result, queuedResult);
    void shutdown(current, false);
  };
  const start = (): Session => {
    const child = fork(options.entrypoint ?? new URL("./worker.js", import.meta.url), [], {
      env: { ...process.env, RUNNEL_HOME: directory },
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "json",
      windowsHide: true,
    });
    let ready!: (value: boolean) => void;
    let exited!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
    let announced = false;
    const current: Session = {
      child,
      fenced: false,
      ready: new Promise((resolve) => {
        ready = resolve;
      }),
      markReady: (value) => ready(value),
      exited: new Promise((resolve) => {
        exited = resolve;
      }),
    };
    session = current;
    current.startup = setTimeout(() => {
      broken(current, failure("WorkerUnavailable", "The database worker did not start in time."));
    }, options.startupTimeoutMs ?? 10000);
    child.on("message", (input) => {
      if (session !== current) return;
      let message: ReturnType<typeof decodeResponse>;
      try {
        message = decodeResponse(input);
      } catch {
        if (current.fenced) force(current);
        else
          broken(
            current,
            failure(
              "WorkerProtocolError",
              "The database worker returned an invalid response. Requests were not retried. Database writes may already have occurred."
            )
          );
        return;
      }
      if (current.fenced) {
        const state = current.shutdown;
        // Late operation results/readiness cannot unfence this child or enter a replacement session.
        if (message.type !== "shutdownComplete") return;
        if (!state?.id || message.id !== state.id || state.acknowledged) {
          force(current);
          return;
        }
        state.acknowledged = true;
        state.completed = message.closed;
        return; // Only actual child exit completes shutdown, even after a valid acknowledgement.
      }
      if (message.type === "ready" && !announced) {
        announced = true;
        clearTimeout(current.startup);
        ready(true);
      } else if (message.type === "result" && announced && active?.id === message.id) {
        const completed = active;
        active = undefined;
        settle(completed, message.result);
        void pump();
      } else
        broken(
          current,
          failure(
            "WorkerProtocolError",
            "The database worker returned an unexpected response. Requests were not retried. Database writes may already have occurred."
          )
        );
    });
    child.on("disconnect", () => {
      if (session !== current) return;
      if (current.fenced) {
        if (!current.shutdown?.acknowledged) force(current);
      } else {
        // A process exit also disconnects IPC. Fence immediately, but classify the failure
        // from its actual exit rather than racing disconnect against the close event.
        current.fenced = true;
        const retired = [...(active ? [active] : []), ...queue.splice(0)];
        active = undefined;
        for (const pending of retired) {
          if (pending.timer) clearTimeout(pending.timer);
          pending.detach?.();
        }
        void shutdown(current, false);
        void current.exited.then(({ code }) => {
          const result = failure(
            code === null ? "WorkerUnavailable" : "WorkerCrashed",
            "The worker exited or lost its IPC channel. Requests were not retried. Database writes may already have occurred."
          );
          for (const pending of retired) settle(pending, result);
        });
      }
    });
    child.on("error", () => {
      ready(false);
      if (current.fenced) force(current);
      else
        broken(
          current,
          failure("WorkerUnavailable", "Cannot start or communicate with the database worker.")
        );
    });
    child.once("close", (code, signal) => {
      clearTimeout(current.startup);
      ready(false);
      if (session === current) {
        if (!current.fenced)
          failPending(
            failure(
              "WorkerCrashed",
              "The database worker exited. Requests were not retried. Database writes may already have occurred."
            )
          );
        session = undefined;
      }
      exited({ code, signal });
      void pump();
    });
    return current;
  };
  const pump = async () => {
    if (dispatching || active || changing || stopped || queue.length === 0) return;
    dispatching = true;
    try {
      if (session?.fenced) await session.exited;
      if (changing || stopped || queue.length === 0) return;
      const current = session ?? start();
      if (!(await current.ready) || current.fenced || session !== current || changing || stopped)
        return;
      const next = queue.shift();
      if (!next) return;
      active = next;
      if (next.timeoutMs > 0)
        next.timer = setTimeout(() => {
          broken(
            current,
            failure(
              "OperationTimedOut",
              "The operation deadline expired. The worker was stopped without replay. Database writes may already have occurred."
            ),
            failure(
              "WorkerRestarted",
              "The worker stopped after an active deadline. Queued requests were not retried."
            )
          );
        }, next.timeoutMs);
      current.child.send({ type: "request", id: next.id, request: next.request }, (error) => {
        if (error)
          broken(
            current,
            failure(
              "WorkerUnavailable",
              "Cannot communicate with the database worker. Requests were not retried. Database writes may already have occurred."
            )
          );
      });
    } catch {
      failPending(
        failure("WorkerUnavailable", "Cannot start or communicate with the database worker.")
      );
    } finally {
      dispatching = false;
      if (!active && !changing && !stopped && queue.length > 0) void pump();
    }
  };
  const transition = (permanent: boolean): Promise<WorkerShutdownResult> => {
    if (permanent) {
      stopped = true;
      if (stoppedResult) return stoppedResult;
    }
    if (changing) {
      if (permanent) stoppedResult = changing;
      return changing;
    }
    failPending(
      failure(
        permanent ? "WorkerStopped" : "WorkerRestarted",
        "The database worker was stopped. Requests were not retried. Database writes may already have occurred."
      )
    );
    const completion = session
      ? shutdown(session, true)
      : Promise.resolve<WorkerShutdownResult>({ mode: "not-running", acknowledged: false });
    changing = completion.finally(() => {
      changing = undefined;
    });
    if (permanent) stoppedResult = changing;
    return changing;
  };
  return {
    execute(input: unknown, timeoutMs?: number, signal?: AbortSignal): Promise<WorkerResult> {
      const cancelled = () =>
        failure(
          "OperationCancelled",
          "The attached operation was cancelled and was not retried. Database writes may already have occurred."
        );
      if (signal?.aborted) return Promise.resolve(cancelled());
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
        timeoutMs ??=
          request.operation === "run"
            ? request.timeoutMs === 0
              ? 0
              : request.timeoutMs + 100
            : 15000;
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
        const pending: Pending = { id: randomUUID(), request, timeoutMs, finish };
        const cancel = () => {
          if (active === pending && session) {
            broken(
              session,
              cancelled(),
              failure(
                "WorkerRestarted",
                "The active operation was cancelled. Queued requests were not retried."
              )
            );
          } else {
            const index = queue.indexOf(pending);
            if (index >= 0) {
              queue.splice(index, 1);
              settle(pending, cancelled());
            }
          }
        };
        queue.push(pending);
        if (signal) {
          signal.addEventListener("abort", cancel, { once: true });
          pending.detach = () => signal.removeEventListener("abort", cancel);
        }
        if (signal?.aborted) cancel();
        else void pump();
      });
    },
    status: () =>
      ({
        state: stopped
          ? session
            ? "stopping"
            : "stopped"
          : changing || session?.fenced
            ? "restarting"
            : session
              ? "running"
              : "idle",
        pid: session?.child.pid,
        active: active !== undefined,
        queued: queue.length,
      }) as const,
    reset: () => transition(false),
    stop: () => transition(true),
  };
}
