import { resolve } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { readCatalog } from "./catalog.js";
import { executeWithDaemon } from "./daemon-client.js";
import type { DaemonResponse } from "./daemon-protocol.js";
import { QueryError, readQueryInput } from "./query-input.js";
import { prepareScript, type ScriptOperation } from "./script-runner.js";
import { decodeOperation, failure, scriptMaximumTimeoutMs } from "./worker-protocol.js";

export type ScriptValues = Partial<
  Record<"env" | "db" | "format" | "args" | "args-file" | "timeout", string>
>;

/** Positive whole durations require a unit; zero explicitly disables the active deadline. */
export function scriptTimeout(value: string): number {
  const match = /^(\d+)(ms|s|m|h)$/.exec(value);
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  const timeout = value === "0" ? 0 : match ? Number(match[1]) * units[match[2]!]! : NaN;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > scriptMaximumTimeoutMs)
    throw new QueryError(
      "InputInvalid",
      `Use --timeout 0 or a whole ms/s/m/h duration up to ${scriptMaximumTimeoutMs}ms.`
    );
  return timeout;
}

export async function buildScriptRequest(
  entry: string,
  values: ScriptValues,
  defaultTimeoutMs = 300000,
  signal?: AbortSignal
): Promise<ScriptOperation> {
  if (values.env === undefined)
    throw new QueryError("EnvironmentRequired", "Specify an environment with -e or --env.");
  if (values.args !== undefined && values["args-file"] !== undefined)
    throw new QueryError("InputInvalid", "Choose --args or --args-file. Use file - for stdin.");
  signal?.throwIfAborted();
  try {
    const request = decodeOperation({
      operation: "run",
      path: resolve(entry),
      env: values.env,
      ...(values.db === undefined ? {} : { db: values.db }),
      ...(values.format === undefined ? {} : { format: values.format }),
      timeoutMs: values.timeout === undefined ? defaultTimeoutMs : scriptTimeout(values.timeout),
      ...(values.args === undefined ? {} : { args: values.args }),
    }) as ScriptOperation;
    prepareScript(request);
    const supplied =
      values["args-file"] === undefined
        ? request
        : {
            ...request,
            args: await readQueryInput(values["args-file"], process.stdin, signal),
          };
    prepareScript(supplied);
    signal?.throwIfAborted();
    return decodeOperation(supplied) as ScriptOperation;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof QueryError) throw error;
    throw new QueryError(
      "InputInvalid",
      `Use a .mjs or .js entry, json/ejson format, and a deadline from 0 to ${scriptMaximumTimeoutMs}ms. Arguments must fit the IPC budget.`
    );
  }
}

export async function runScriptCommand(
  directory: string,
  entry: string,
  values: ScriptValues,
  signal?: AbortSignal
): Promise<DaemonResponse> {
  try {
    if (values.env === undefined)
      return failure("EnvironmentRequired", "Specify an environment with -e or --env.");
    signal?.throwIfAborted();
    let timeout = 300000;
    if (values.timeout === undefined) {
      const catalog = await Effect.runPromise(readCatalog(directory).pipe(Effect.result));
      if (Result.isFailure(catalog)) return { ok: false, error: catalog.failure };
      timeout = catalog.success.settings.scriptTimeoutMs;
    }
    const request = await buildScriptRequest(entry, values, timeout, signal);
    return await executeWithDaemon(directory, request, signal);
  } catch (error) {
    if (signal?.aborted)
      return failure(
        "OperationCancelled",
        "The attached operation was cancelled and was not retried. Database writes may already have occurred."
      );
    return error instanceof QueryError
      ? failure(error.code, error.message)
      : failure("RequestInvalid", "Cannot prepare this script request.");
  }
}
