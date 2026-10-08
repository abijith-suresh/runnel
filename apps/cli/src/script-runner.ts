import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import * as Schema from "effect/Schema";
import { BSON, type Db } from "mongodb";
import { encodeDocument, queryResultBytes } from "./mongodb-query.js";
import { inputLimitBytes, QueryError } from "./query-input.js";
import type { WorkerOperation, WorkerResult } from "./worker-protocol.js";

export type ScriptOperation = Extract<WorkerOperation, { operation: "run" }>;
export const scriptSourceBytes = 1024 * 1024;
const targetSchema = Schema.Struct({ env: Schema.String, db: Schema.optionalKey(Schema.String) });
const decodeTarget = Schema.decodeUnknownSync(targetSchema, { onExcessProperty: "error" });
const unavailable = () =>
  new QueryError(
    "ScriptUnavailable",
    "Cannot read the JavaScript entry script. Use an absolute regular .mjs or .js file up to 1 MiB."
  );

/** Plain JSON arguments are data; EJSON-looking keys are not converted into BSON. */
export function prepareScript(request: ScriptOperation): Schema.Json {
  if (!isAbsolute(request.path) || ![".mjs", ".js"].includes(extname(request.path)))
    throw unavailable();
  const text = request.args ?? "{}";
  if (Buffer.byteLength(text, "utf8") > inputLimitBytes)
    throw new QueryError("InputTooLarge", "Script arguments exceed the 256 KiB input limit.");
  try {
    const value: unknown = JSON.parse(text);
    const numbers = (item: unknown): void => {
      if (
        typeof item === "number" &&
        (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))
      )
        throw new Error("Inexact number");
      if (Array.isArray(item)) item.forEach(numbers);
      else if (item !== null && typeof item === "object") Object.values(item).forEach(numbers);
    };
    numbers(value);
    return Schema.decodeUnknownSync(Schema.Json)(value);
  } catch {
    throw new QueryError(
      "InputInvalid",
      "Use valid JSON script arguments with safe numeric literals."
    );
  }
}
async function source(path: string): Promise<{ path: string; hash: string }> {
  try {
    const canonical = await realpath(path);
    const file = await open(
      canonical,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK)
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > scriptSourceBytes) throw unavailable();
      const bytes = Buffer.alloc(scriptSourceBytes + 1);
      let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > scriptSourceBytes) throw unavailable();
      return {
        path: canonical,
        hash: createHash("sha256").update(bytes.subarray(0, length)).digest("hex"),
      };
    } finally {
      await file.close();
    }
  } catch {
    throw unavailable();
  }
}
function resultValue(value: unknown, format: "json" | "ejson"): Schema.Json {
  const seen = new Set<object>();
  const check = (item: unknown): void => {
    if (item === null || ["string", "boolean", "number"].includes(typeof item)) return;
    if (typeof item !== "object" || item === null) throw new Error("Unsupported result");
    if (seen.has(item)) throw new Error("Cyclic result");
    seen.add(item);
    try {
      if (item instanceof BSON.Code) {
        if (item.scope !== null && item.scope !== undefined) check(item.scope);
      } else if (item instanceof BSON.DBRef) {
        check(item.oid);
        check(item.fields);
      } else if (
        item instanceof BSON.BSONValue ||
        item instanceof Date ||
        item instanceof RegExp ||
        Buffer.isBuffer(item)
      )
        return;
      else if (Array.isArray(item)) item.forEach(check);
      else if ([Object.prototype, null].includes(Object.getPrototypeOf(item)))
        Object.values(item).forEach(check);
      else throw new Error("Native handles and class instances are not results");
    } finally {
      seen.delete(item);
    }
  };
  try {
    const returned = value === undefined ? null : value;
    check(returned);
    const encoded = encodeDocument({ value: returned }, format)["value"];
    return Schema.decodeUnknownSync(Schema.Json)(encoded);
  } catch (error) {
    if (error instanceof QueryError) throw error;
    throw new QueryError(
      "ResultEncodingFailed",
      "Return JSON/BSON data rather than native handles, functions, or cyclic values."
    );
  }
}

/** Worker-local modules and real driver handles. This executes trusted local JavaScript. */
export function createScriptRunner() {
  const loaded = new Map<string, string>();
  const controllers = new Set<AbortController>();
  let closed = false;
  return {
    async execute(
      request: ScriptOperation,
      resolve: () => Promise<{ env: string; db: string; handle: Db }>,
      connect: (target: { env: string; db?: string }) => Promise<Db>,
      args: Schema.Json
    ): Promise<WorkerResult> {
      if (closed) throw new QueryError("ScriptStopped", "The script runner is stopped.");
      const controller = new AbortController();
      controllers.add(controller);
      let ended = false;
      const timer =
        request.timeoutMs === 0
          ? undefined
          : setTimeout(
              () => controller.abort(new Error("Script deadline expired.")),
              request.timeoutMs
            );
      const checkActive = () => {
        if (ended)
          throw new QueryError("ScriptScopeEnded", "The script operation has already ended.");
        if (controller.signal.aborted)
          throw new QueryError(
            closed ? "ScriptStopped" : "ScriptTimedOut",
            "The script was stopped or exceeded its deadline. It was not retried."
          );
      };
      try {
        const selected = await resolve();
        checkActive();
        const entry = await source(request.path);
        if (loaded.has(entry.path) && loaded.get(entry.path) !== entry.hash)
          throw new QueryError(
            "ScriptChanged",
            "The loaded entry script changed. Reset the worker before running it again."
          );
        loaded.set(entry.path, entry.hash);
        let module: { default?: unknown };
        try {
          module = (await import(pathToFileURL(entry.path).href)) as typeof module;
        } catch {
          throw new QueryError(
            "ScriptInvalid",
            "Cannot load the JavaScript module and its imports. Reset the worker after fixing it."
          );
        }
        if ((await source(request.path)).hash !== entry.hash)
          throw new QueryError(
            "ScriptChanged",
            "The entry script changed during loading. Reset the worker before running it again."
          );
        if (typeof module.default !== "function")
          throw new QueryError(
            "ScriptInvalid",
            "The JavaScript module must default-export an async function."
          );
        checkActive();
        const value: unknown = await module.default({
          db: selected.handle,
          args,
          bson: BSON,
          signal: controller.signal,
          connect: async (input: unknown) => {
            checkActive();
            let target: typeof targetSchema.Type;
            try {
              target = decodeTarget(input);
            } catch {
              throw new QueryError(
                "InputInvalid",
                "connect requires an explicit environment and optional database alias."
              );
            }
            const handle = await connect(target);
            checkActive();
            return handle;
          },
        });
        checkActive();
        const format = request.format ?? "ejson";
        const encoded = resultValue(value, format);
        if (Buffer.byteLength(JSON.stringify(encoded), "utf8") > queryResultBytes)
          throw new QueryError(
            "ResultTooLarge",
            "The script result exceeds the 512 KiB result budget. Return a bounded result."
          );
        return {
          ok: true,
          data: {
            env: selected.env,
            db: selected.db,
            format,
            value: encoded,
            limits: { bytes: queryResultBytes },
          },
        };
      } catch (error) {
        if (controller.signal.aborted) checkActive();
        throw error;
      } finally {
        ended = true;
        controller.abort(new Error("Script operation ended."));
        if (timer) clearTimeout(timer);
        controllers.delete(controller);
      }
    },
    close() {
      closed = true;
      for (const controller of controllers) controller.abort(new Error("Script runner stopped."));
    },
  };
}
