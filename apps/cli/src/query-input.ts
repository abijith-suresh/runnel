import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Readable } from "node:stream";
import { BSON, type Document } from "mongodb";

export const inputLimitBytes = 256 * 1024;
export class QueryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
const oversized = () =>
  new QueryError("InputTooLarge", "JSON/EJSON input exceeds the 256 KiB input limit.");
const invalid = () =>
  new QueryError(
    "InputInvalid",
    "Use valid JSON or MongoDB EJSON of the required object or pipeline shape. Use EJSON wrappers for integers outside JavaScript's safe range."
  );
const object = (value: unknown): value is Document =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

const wrapperKeys = new Set([
  "$oid",
  "$uuid",
  "$symbol",
  "$numberInt",
  "$numberLong",
  "$numberDouble",
  "$numberDecimal",
  "$binary",
  "$timestamp",
  "$date",
  "$code",
  "$scope",
  "$regularExpression",
  "$minKey",
  "$maxKey",
  "$undefined",
  "$dbPointer",
]);
const exact = (value: Document, keys: string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const uint32 = (value: unknown): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;

function validDate(value: unknown): boolean {
  if (object(value) && exact(value, ["$numberLong"]) && typeof value["$numberLong"] === "string") {
    const text = value["$numberLong"] as string;
    if (!/^[+-]?\d+$/.test(text)) return false;
    const millis = BigInt(text);
    // JavaScript Date cannot represent all BSON signed Int64 milliseconds. Never send Invalid Date.
    return millis >= -8640000000000000n && millis <= 8640000000000000n;
  }
  if (typeof value !== "string") return false;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value
    );
  if (!match || !Number.isFinite(Date.parse(value))) return false;
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = match;
  const lastDay = new Date(0);
  lastDay.setUTCFullYear(Number(year), Number(month), 0);
  return (
    Number(month) >= 1 &&
    Number(month) <= 12 &&
    Number(day) >= 1 &&
    Number(day) <= lastDay.getUTCDate() &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    Number(offsetHour ?? 0) <= 23 &&
    Number(offsetMinute ?? 0) <= 59
  );
}

/** Decode only recognized wrappers: the driver's legacy regex parsing can discard query predicates. */
function decode(value: unknown): unknown {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      throw invalid();
    return BSON.EJSON.parse(Object.is(value, -0) ? "-0" : String(value), { relaxed: false });
  }
  if (Array.isArray(value)) return value.map(decode);
  if (!object(value)) return value;
  const special = Object.keys(value).filter((key) => wrapperKeys.has(key));
  if (!special.length)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
  const key = special[0] as string;
  if (key === "$code" || key === "$scope") {
    const scoped = Object.hasOwn(value, "$scope");
    if (
      !exact(value, scoped ? ["$code", "$scope"] : ["$code"]) ||
      typeof value["$code"] !== "string"
    )
      throw invalid();
    if (!scoped) return new BSON.Code(value["$code"]);
    if (!object(value["$scope"])) throw invalid();
    const scope = decode(value["$scope"]);
    if (!object(scope)) throw invalid();
    return new BSON.Code(value["$code"], scope);
  }
  if (!exact(value, [key])) throw invalid();
  const item: unknown = value[key];
  if (["$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"].includes(key)) {
    if (typeof item !== "string") throw invalid();
    if (key === "$numberInt") BSON.Int32.fromString(item);
    else if (key === "$numberLong") {
      if (!/^[+-]?\d+$/.test(item)) throw invalid();
      const integer = BigInt(item);
      if (integer < -(1n << 63n) || integer > (1n << 63n) - 1n) throw invalid();
    } else if (key === "$numberDouble") BSON.Double.fromString(item);
    else BSON.Decimal128.fromString(item);
  } else if (key === "$date") {
    if (!validDate(item)) throw invalid();
  } else if (key === "$binary") {
    if (
      !object(item) ||
      !exact(item, ["base64", "subType"]) ||
      typeof item["base64"] !== "string" ||
      typeof item["subType"] !== "string" ||
      !/^[a-f\d]{1,2}$/i.test(item["subType"]) ||
      Buffer.from(item["base64"], "base64").toString("base64") !== item["base64"]
    )
      throw invalid();
  } else if (key === "$timestamp") {
    if (!object(item) || !exact(item, ["t", "i"]) || !uint32(item["t"]) || !uint32(item["i"]))
      throw invalid();
  } else if (key === "$regularExpression") {
    if (
      !object(item) ||
      !exact(item, ["pattern", "options"]) ||
      typeof item["pattern"] !== "string" ||
      typeof item["options"] !== "string"
    )
      throw invalid();
  } else if (key === "$oid") {
    if (typeof item !== "string" || !/^[a-f\d]{24}$/i.test(item)) throw invalid();
  } else if (key === "$uuid") {
    if (
      typeof item !== "string" ||
      !/^(?:[a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})$/i.test(item)
    )
      throw invalid();
  } else if (key === "$symbol") {
    if (typeof item !== "string") throw invalid();
  } else if (key === "$minKey" || key === "$maxKey") {
    if (item !== 1) throw invalid();
  } else if (key === "$undefined") {
    if (item !== true) throw invalid();
  } else if (key === "$dbPointer") {
    if (
      !object(item) ||
      !exact(item, ["$ref", "$id"]) ||
      typeof item["$ref"] !== "string" ||
      !object(item["$id"]) ||
      !exact(item["$id"], ["$oid"])
    )
      throw invalid();
    decode(item["$id"]);
  }
  return BSON.EJSON.parse(JSON.stringify(value), { relaxed: false });
}

function parse(text: string): unknown {
  try {
    if (Buffer.byteLength(text, "utf8") > inputLimitBytes) throw oversized();
    const value: unknown = JSON.parse(text, (key, item: unknown) => {
      if (key.includes("\0")) throw invalid();
      return item;
    });
    return decode(value);
  } catch (error) {
    if (error instanceof QueryError) throw error;
    throw invalid();
  }
}
export function parseQueryObject(text: string): Document {
  const value = parse(text);
  if (!object(value)) throw invalid();
  return value;
}
export function parsePipeline(text: string): Document[] {
  const value = parse(text);
  if (
    !Array.isArray(value) ||
    !value.every(
      (stage: unknown) =>
        object(stage) && Object.keys(stage).length === 1 && Object.keys(stage)[0]?.startsWith("$")
    )
  )
    throw invalid();
  return value as Document[];
}

/** Bounded regular-file/stdin reads. Neither filenames nor contents enter diagnostics. */
export async function readQueryInput(
  path: string,
  stdin: Readable = process.stdin
): Promise<string> {
  try {
    let bytes: Buffer;
    if (path === "-") {
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of stdin) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        length += buffer.length;
        if (length > inputLimitBytes) throw oversized();
        chunks.push(buffer);
      }
      bytes = Buffer.concat(chunks);
    } else {
      const file = await open(
        path,
        constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK)
      );
      try {
        if (!(await file.stat()).isFile()) throw invalid();
        const buffer = Buffer.alloc(inputLimitBytes + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length > inputLimitBytes) throw oversized();
        bytes = buffer.subarray(0, length);
      } finally {
        await file.close();
      }
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (error instanceof QueryError) throw error;
    throw new QueryError(
      "InputUnavailable",
      "Cannot read the JSON/EJSON input as a UTF-8 regular file or stdin stream."
    );
  }
}
