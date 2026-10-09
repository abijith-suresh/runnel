import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import * as Schema from "effect/Schema";
import { BSON, type Db, type Document } from "mongodb";
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
  const copyBytes = (value: unknown): Buffer => {
    if (!(value instanceof Uint8Array) || !ArrayBuffer.isView(value))
      throw new Error("Invalid BSON bytes");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      Reflect.ownKeys(descriptors).some(
        (key) => typeof key !== "string" || !/^\d+$/.test(key) || !("value" in descriptors[key]!)
      )
    )
      throw new Error("Modified BSON bytes");
    const length: unknown = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(Uint8Array.prototype),
      "byteLength"
    )?.get?.call(value);
    if (typeof length !== "number") throw new Error("Invalid BSON bytes");
    const copy = Buffer.alloc(length);
    Uint8Array.prototype.set.call(copy, value);
    return copy;
  };
  const bsonPrototypes = new Set(
    [
      BSON.Binary,
      BSON.BSONRegExp,
      BSON.BSONSymbol,
      BSON.Code,
      BSON.DBRef,
      BSON.Decimal128,
      BSON.Double,
      BSON.Int32,
      BSON.Long,
      BSON.MaxKey,
      BSON.MinKey,
      BSON.ObjectId,
      BSON.Timestamp,
      BSON.UUID,
    ].map((type) => type.prototype)
  );
  const snapshot = (item: unknown): unknown => {
    // Native EJSON can infer an inexact or overflowing Int64 from an unsafe JS integer.
    if (typeof item === "number" && Number.isInteger(item) && !Number.isSafeInteger(item))
      return new BSON.Double(item);
    if (item === null || ["string", "boolean", "number"].includes(typeof item)) return item;
    if (typeof item !== "object" || item === null) throw new Error("Unsupported result");
    if (seen.has(item)) throw new Error("Cyclic result");
    seen.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Reflect.ownKeys(descriptors).some((key) => !("value" in descriptors[key as string]!)))
        throw new Error("Accessor result");
      const data = (key: string): unknown => descriptors[key]?.value;
      const prototype = Object.getPrototypeOf(item);
      if (item instanceof BSON.BSONValue && bsonPrototypes.has(prototype)) {
        if (Object.values(descriptors).some((descriptor) => typeof descriptor.value === "function"))
          throw new Error("Modified BSON result");
        // Copy numeric payloads directly; EJSON deserialization coerces invalid Int64/Int32 values.
        if (item instanceof BSON.Long) {
          const low = data("low"),
            high = data("high"),
            unsigned = data("unsigned");
          if (
            typeof low !== "number" ||
            typeof high !== "number" ||
            typeof unsigned !== "boolean" ||
            !Number.isInteger(low) ||
            !Number.isInteger(high) ||
            low < -2147483648 ||
            low > 2147483647 ||
            high < -2147483648 ||
            high > 2147483647
          )
            throw new Error("Invalid BSON integer");
          if (item instanceof BSON.Timestamp)
            return new BSON.Timestamp({ t: high >>> 0, i: low >>> 0 });
          const value = BSON.Long.fromBits(low, high, unsigned);
          if (value.toBigInt() > 9223372036854775807n) throw new Error("Int64 overflow");
          return value;
        }
        if (item instanceof BSON.Int32) {
          const value = data("value");
          if (
            typeof value !== "number" ||
            !Number.isInteger(value) ||
            value < -2147483648 ||
            value > 2147483647
          )
            throw new Error("Int32 overflow");
          return new BSON.Int32(value);
        }
        if (item instanceof BSON.Double) {
          const value = data("value");
          if (typeof value !== "number") throw new Error("Invalid BSON double");
          return new BSON.Double(value);
        }
        if (item instanceof BSON.Code) {
          const code = data("code"),
            scope = data("scope");
          if (
            typeof code !== "string" ||
            (scope != null &&
              (typeof scope !== "object" ||
                ![Object.prototype, null].includes(Object.getPrototypeOf(scope))))
          )
            throw new Error("Invalid BSON code");
          return new BSON.Code(code, scope == null ? undefined : (snapshot(scope) as Document));
        }
        if (item instanceof BSON.DBRef) {
          const collection = data("collection"),
            db = data("db"),
            fields = data("fields");
          if (
            typeof collection !== "string" ||
            (db !== undefined && typeof db !== "string") ||
            fields === null ||
            typeof fields !== "object" ||
            ![Object.prototype, null].includes(Object.getPrototypeOf(fields))
          )
            throw new Error("Invalid BSON reference");
          return new BSON.DBRef(
            collection,
            snapshot(data("oid")) as BSON.ObjectId,
            db,
            snapshot(fields) as Document
          );
        }
        if (item instanceof BSON.BSONSymbol) {
          const value = data("value");
          if (typeof value !== "string") throw new Error("Invalid BSON symbol");
          return new BSON.BSONSymbol(value);
        }
        if (item instanceof BSON.BSONRegExp) {
          const pattern = data("pattern"),
            options = data("options");
          if (typeof pattern !== "string" || typeof options !== "string")
            throw new Error("Invalid BSON regular expression");
          return new BSON.BSONRegExp(pattern, options);
        }
        if (item instanceof BSON.Binary) {
          const bytes = copyBytes(data("buffer")),
            subtype = data("sub_type"),
            position = data("position");
          if (
            typeof subtype !== "number" ||
            !Number.isInteger(subtype) ||
            subtype < 0 ||
            subtype > 255 ||
            typeof position !== "number" ||
            !Number.isInteger(position) ||
            position < 0 ||
            position > bytes.byteLength
          )
            throw new Error("Invalid BSON binary");
          if ((subtype === 4 && position !== 16) || (item instanceof BSON.UUID && subtype !== 4))
            throw new Error("Invalid UUID");
          return new BSON.Binary(bytes.subarray(0, position), subtype);
        }
        if (item instanceof BSON.Decimal128) {
          const bytes = copyBytes(data("bytes"));
          if (bytes.byteLength !== 16) throw new Error("Invalid BSON decimal");
          return new BSON.Decimal128(bytes);
        }
        if (item instanceof BSON.ObjectId) {
          for (const descriptor of Object.values(descriptors)) snapshot(descriptor.value);
          const bytes = Buffer.alloc(12);
          for (const [index, key] of ["i0", "i1", "i2", "i3"].entries()) {
            const word = data(key);
            if (typeof word !== "number" || !Number.isInteger(word) || word < 0 || word > 0xffffff)
              throw new Error("Invalid ObjectId");
            bytes.writeUIntBE(word, index * 3, 3);
          }
          return new BSON.ObjectId(bytes);
        }
        if (item instanceof BSON.MinKey) return new BSON.MinKey();
        if (item instanceof BSON.MaxKey) return new BSON.MaxKey();
        throw new Error("Unsupported BSON result");
      }
      if (prototype === Date.prototype) {
        const millis = Date.prototype.getTime.call(item);
        if (!Number.isFinite(millis)) throw new Error("Invalid date");
        return new Date(millis);
      }
      if (prototype === RegExp.prototype) {
        if (Reflect.ownKeys(descriptors).some((key) => key !== "lastIndex"))
          throw new Error("Modified regular expression");
        const pattern = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get?.call(
          item
        );
        const flags = Object.getOwnPropertyDescriptor(RegExp.prototype, "flags")?.get?.call(item);
        if (typeof pattern !== "string" || typeof flags !== "string")
          throw new Error("Invalid regular expression");
        return new RegExp(pattern, flags);
      }
      if (Buffer.isBuffer(item)) return new BSON.Binary(copyBytes(item));
      if (Array.isArray(item)) {
        const length = data("length");
        if (
          typeof length !== "number" ||
          !Number.isInteger(length) ||
          length < 0 ||
          length > 0xffffffff ||
          Object.keys(descriptors).some(
            (key) => /^(0|[1-9]\d*)$/.test(key) && Number(key) < 0xffffffff && Number(key) >= length
          )
        )
          throw new Error("Invalid array length");
        if (length > queryResultBytes)
          throw new QueryError("ResultTooLarge", "The script array cannot fit the result budget.");
        return Array.from({ length }, (_, index) => snapshot(data(String(index))));
      }
      if ([Object.prototype, null].includes(prototype))
        return Object.fromEntries(
          Object.entries(descriptors)
            .filter(([, descriptor]) => descriptor.enumerable)
            .map(([key, descriptor]) => [key, snapshot(descriptor.value)])
        );
      throw new Error("Native handles and class instances are not results");
    } finally {
      seen.delete(item);
    }
  };

  try {
    const returned = value === undefined ? null : value;
    const stable = snapshot(returned);
    const encoded = encodeDocument({ value: stable }, format)["value"];
    return Schema.decodeUnknownSync(Schema.Json)(encoded);
  } catch (error) {
    if (error instanceof QueryError) throw error;
    throw new QueryError(
      "ResultEncodingFailed",
      "Return JSON/BSON data without nested undefined, native handles, accessors, functions, cycles, or unsupported classes. Use null for missing values or omit undefined object properties."
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
      const deadline = request.timeoutMs === 0 ? undefined : performance.now() + request.timeoutMs;
      const timer =
        request.timeoutMs === 0
          ? undefined
          : setTimeout(
              () => controller.abort(new Error("Script deadline expired.")),
              request.timeoutMs
            );
      const checkActive = () => {
        // Finite CPU work can finish before a delayed timer callback runs.
        if (deadline !== undefined && performance.now() >= deadline && !controller.signal.aborted)
          controller.abort(new Error("Script deadline expired."));
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
        checkActive();
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
        checkActive();
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
        checkActive();
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
