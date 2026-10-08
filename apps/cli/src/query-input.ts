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

/** The driver's EJSON parser coerces some malformed numeric wrappers instead of rejecting them. */
function validateNumericWrapper(value: unknown): void {
  if (!object(value)) return;
  for (const key of ["$numberInt", "$numberLong", "$numberDouble", "$numberDecimal"]) {
    if (!Object.hasOwn(value, key)) continue;
    const text: unknown = value[key];
    if (Object.keys(value).length !== 1 || typeof text !== "string") throw invalid();
    if (key === "$numberInt") BSON.Int32.fromString(text);
    else if (key === "$numberLong") {
      if (!/^[+-]?\d+$/.test(text)) throw invalid();
      const integer = BigInt(text);
      if (integer < -(1n << 63n) || integer > (1n << 63n) - 1n) throw invalid();
    } else if (key === "$numberDouble") BSON.Double.fromString(text);
    else BSON.Decimal128.fromString(text);
  }
}

function parse(text: string): unknown {
  try {
    if (Buffer.byteLength(text, "utf8") > inputLimitBytes) throw oversized();
    JSON.parse(text, (_key, value: unknown) => {
      if (
        typeof value === "number" &&
        (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      )
        throw invalid();
      validateNumericWrapper(value);
      return value;
    });
    return BSON.EJSON.parse(text, { relaxed: false });
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
