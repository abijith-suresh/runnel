import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { resolveDatabaseTarget } from "@abijith-suresh/runnel-core";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { lock } from "proper-lockfile";
import { type Catalog, isCatalogName, readCatalog } from "./catalog.js";
import { privateDirectory } from "./daemon-state.js";
import { decodeOperation, type WorkerOperation, type WorkerResult } from "./worker-protocol.js";

export const historyMaximumEntries = 1000;
export const historyMaximumBytes = 1024 * 1024;
const operations = Schema.Literals(["list", "describe", "find", "count", "aggregate"]);
const errorCodes = [
  "EnvironmentRequired",
  "EnvironmentNotFound",
  "NoDatabases",
  "DatabaseRequired",
  "DatabaseNotFound",
  "CatalogInvalid",
  "CatalogUnavailable",
  "SecretNotFound",
  "SecretUnavailable",
  "SecretReferenceInvalid",
  "SecretInvalid",
  "ConnectionInvalid",
  "PermissionDenied",
  "AuthenticationFailed",
  "DatabaseUnavailable",
  "DatabaseOperationFailed",
  "DatabaseTimedOut",
  "CollectionNotFound",
  "QueryInvalid",
  "InputInvalid",
  "InputTooLarge",
  "ResultPrecisionLoss",
  "ResultEncodingFailed",
  "ResultTooLarge",
  "WorkerUnavailable",
  "WorkerProtocolError",
  "WorkerCrashed",
  "WorkerRestarted",
  "WorkerStopped",
  "WorkerRestarting",
  "OperationTimedOut",
  "QueueFull",
  "RequestInvalid",
  "OperationFailed",
] as const;
const errorCodeSet = new Set<string>(errorCodes);
const name = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
const entrySchema = Schema.Struct({
  timestamp: Schema.String,
  durationMs: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
  ),
  operation: operations,
  targets: Schema.Struct({
    env: Schema.optionalKey(name),
    db: Schema.optionalKey(name),
    connection: Schema.optionalKey(name),
  }),
  outcome: Schema.Union([
    Schema.Struct({ status: Schema.Literal("success") }),
    Schema.Struct({ status: Schema.Literal("error"), code: Schema.Literals(errorCodes) }),
  ]),
});
const historySchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  entries: Schema.Array(entrySchema).check(Schema.isMaxLength(historyMaximumEntries)),
});
export type HistoryEntry = typeof entrySchema.Type;
export class HistoryError extends Error {
  readonly code = "HistoryUnavailable";
  constructor() {
    super("Cannot read or save private Runnel operation history.");
  }
}
const decodeEntry = Schema.decodeUnknownSync(entrySchema, { onExcessProperty: "error" });
function validatedEntry(input: unknown): HistoryEntry {
  const entry = decodeEntry(input);
  if (
    new Date(entry.timestamp).toISOString() !== entry.timestamp ||
    Object.values(entry.targets).some((value) => !isCatalogName(value))
  )
    throw new HistoryError();
  return entry;
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
async function historyDirectory(directory: string, create: boolean): Promise<string> {
  const path = join(await realpath(directory), "history");
  if (create) await privateDirectory(path);
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
  )
    throw new HistoryError();
  return path;
}
async function readEntries(path: string): Promise<HistoryEntry[]> {
  const flags =
    constants.O_RDONLY |
    (process.platform === "win32" ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(join(path, "entries.json"), flags);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      // Atomic replacement may unlink an already-open reader's inode; its snapshot remains valid.
      info.nlink > 1 ||
      info.size > historyMaximumBytes ||
      (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
    )
      throw new HistoryError();
    const bytes = Buffer.alloc(historyMaximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > historyMaximumBytes) throw new HistoryError();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    const history = Schema.decodeUnknownSync(historySchema, { onExcessProperty: "error" })(
      JSON.parse(text) as unknown
    );
    return history.entries.map(validatedEntry);
  } finally {
    await file.close();
  }
}
/** Offline, bounded, newest-first inspection. A missing history creates no files. */
export async function readHistory(directory: string): Promise<HistoryEntry[]> {
  try {
    return (await readEntries(await historyDirectory(directory, false))).reverse();
  } catch (error) {
    if (missing(error)) return [];
    throw new HistoryError();
  }
}
/** Validate the entire record; never carry unrecognized fields forward into a history file. */
export async function appendHistory(
  directory: string,
  input: HistoryEntry,
  options: { waitForLock?: boolean } = {}
): Promise<void> {
  let release: (() => Promise<void>) | undefined;
  let temporary: string | undefined;
  try {
    const entry = validatedEntry(input);
    const path = await historyDirectory(directory, true);
    let compromised = false;
    release = await lock(join(path, "entries.json"), {
      realpath: false,
      stale: 10000,
      update: 3000,
      retries:
        options.waitForLock === false
          ? 0
          : { retries: 10, factor: 1, minTimeout: 100, maxTimeout: 100 },
      onCompromised: () => {
        compromised = true;
      },
    });
    const entries = [...(await readEntries(path)), entry].slice(-historyMaximumEntries);
    const contents = `${JSON.stringify({ schemaVersion: 1, entries })}\n`;
    if (Buffer.byteLength(contents, "utf8") > historyMaximumBytes) throw new HistoryError();
    temporary = join(path, `.entries-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    if (compromised) throw new HistoryError();
    await rename(temporary, join(path, "entries.json"));
  } catch {
    throw new HistoryError();
  } finally {
    if (temporary) await rm(temporary, { force: true }).catch(() => undefined);
    // Preserve a committed result or the original failure; stale locks recover automatically.
    if (release) await release().catch(() => undefined);
  }
}
function targets(
  catalog: Catalog,
  request: Exclude<WorkerOperation, { operation: "inspect" }>
): HistoryEntry["targets"] {
  if (request.env === undefined || !Object.hasOwn(catalog.environments, request.env)) return {};
  const selected = resolveDatabaseTarget(
    new Map(
      Object.entries(catalog.environments).map(([env, value]) => [
        env,
        new Set(Object.keys(value.databases)),
      ])
    ),
    request
  );
  if (Result.isFailure(selected)) return { env: request.env };
  const { env, db } = selected.success;
  const mapping = catalog.environments[env]?.databases[db];
  return { env, db, ...(mapping === undefined ? {} : { connection: mapping.connection }) };
}
/** One entry per accepted application operation, even if the worker is reset or crashes. */
export function createOperationHistory(
  directory: string,
  worker: { execute(input: unknown): Promise<WorkerResult> }
) {
  let writes = Promise.resolve();
  const pending = new Set<Promise<{ result: WorkerResult; historyFailed: boolean }>>();
  const run = async (input: unknown) => {
    let request: WorkerOperation;
    try {
      request = decodeOperation(input);
      request = decodeOperation(JSON.parse(JSON.stringify(request)) as unknown);
    } catch {
      return { result: await worker.execute(input), historyFailed: false };
    }
    if (request.operation === "inspect")
      return { result: await worker.execute(request), historyFailed: false };
    const timestamp = new Date().toISOString();
    const started = performance.now();
    const snapshot = Effect.runPromise(readCatalog(directory).pipe(Effect.result));
    const operation = worker.execute(request);
    const catalog = await snapshot;
    const result = await operation;
    const durationMs = Math.floor(performance.now() - started);
    if (Result.isFailure(catalog)) return { result, historyFailed: true };
    if (catalog.success.settings.historyEnabled === false) return { result, historyFailed: false };
    const entry: HistoryEntry = {
      timestamp,
      durationMs,
      operation: request.operation,
      targets: targets(catalog.success, request),
      outcome: result.ok
        ? { status: "success" }
        : {
            status: "error",
            code: (errorCodeSet.has(result.error.code)
              ? result.error.code
              : "OperationFailed") as (typeof errorCodes)[number],
          },
    };
    // History must not stall application results or graceful stop behind an external lock.
    const saved = writes.then(() => appendHistory(directory, entry, { waitForLock: false }));
    writes = saved.catch(() => undefined);
    try {
      await saved;
      return { result, historyFailed: false };
    } catch {
      return { result, historyFailed: true };
    }
  };
  return {
    execute(input: unknown) {
      const task = run(input);
      pending.add(task);
      void task.then(
        () => pending.delete(task),
        () => pending.delete(task)
      );
      return task;
    },
    async flush() {
      await Promise.all([...pending]);
      await writes;
    },
  };
}
