import { executeWithDaemon } from "./daemon-client.js";
import type { DaemonResponse } from "./daemon-protocol.js";
import { prepareQuery, type QueryOperation } from "./mongodb-query.js";
import { parsePipeline, parseQueryObject, QueryError, readQueryInput } from "./query-input.js";
import { decodeOperation } from "./worker-protocol.js";

export type QueryCommand = "describe" | "find" | "export" | "count" | "aggregate";
export type QueryValues = Partial<
  Record<
    | "filter"
    | "filter-file"
    | "projection"
    | "projection-file"
    | "sort"
    | "sort-file"
    | "pipeline"
    | "pipeline-file"
    | "limit"
    | "skip"
    | "format"
    | "env"
    | "connection"
    | "db",
    string
  >
>;

export async function buildQueryRequest(
  command: QueryCommand,
  collection: string,
  values: QueryValues
): Promise<QueryOperation> {
  if (!/^[^\0]{1,1024}$/.test(collection))
    throw new QueryError(
      "InputInvalid",
      "Use a nonempty collection name up to 1024 characters without NUL."
    );
  if (values.format !== undefined && !["json", "ejson"].includes(values.format))
    throw new QueryError(
      "InputInvalid",
      "Use --format ejson or --format json. EJSON preserves BSON numeric types."
    );
  const limit =
    ["find", "export", "aggregate"].includes(command) && values.limit !== undefined
      ? integer(values.limit, "limit")
      : undefined;
  if (limit !== undefined && (limit < 1 || limit > 1000))
    throw new QueryError("InputInvalid", "Use --limit with an integer from 1 to 1000.");
  const skip =
    ["find", "export"].includes(command) && values.skip !== undefined
      ? integer(values.skip, "skip")
      : undefined;
  if (skip !== undefined && (skip < 0 || skip > 2147483647))
    throw new QueryError("InputInvalid", "Use --skip with an integer from 0 to 2147483647.");
  const stems = ["filter", "projection", "sort", "pipeline"] as const;
  const stdinCount = stems.filter((key) => values[`${key}-file`] === "-").length;
  if (stdinCount > 1)
    throw new QueryError("InputInvalid", "Only one JSON/EJSON option can read stdin.");
  for (const key of stems)
    if (values[key] !== undefined && values[`${key}-file`] !== undefined)
      throw new QueryError(
        "InputInvalid",
        "Choose inline input or a file for each JSON/EJSON option."
      );
  const source = async (key: (typeof stems)[number], fallback?: string) => {
    const inline = values[key];
    const file = values[`${key}-file`];
    return file === undefined
      ? (inline ?? fallback)
      : await readQueryInput(file, process.stdin, undefined, `${key}-file`);
  };
  const base = {
    operation: command,
    collection,
    ...(values.env === undefined ? {} : { env: values.env }),
    ...(values.db === undefined ? {} : { db: values.db }),
    ...(values.connection === undefined ? {} : { connection: values.connection }),
    ...(values.format === undefined ? {} : { format: values.format }),
    ...(limit === undefined ? {} : { limit }),
    ...(skip === undefined ? {} : { skip }),
  };
  // Check source-independent options before a file read or a potentially unbounded stdin wait.
  validateQueryRequest({ ...base, ...(command === "aggregate" ? { pipeline: "[]" } : {}) });
  let request: unknown;
  if (command === "aggregate") {
    const pipeline = await source("pipeline");
    if (pipeline === undefined)
      throw new QueryError(
        "InputInvalid",
        "Aggregate requires --pipeline or --pipeline-file. Use - as the filename to read stdin."
      );
    parsePipeline(pipeline);
    request = {
      ...base,
      pipeline,
    };
  } else if (command === "describe") request = base;
  else {
    const filter = await source("filter", "{}");
    if (filter !== undefined) parseQueryObject(filter);
    request = { ...base, filter };
    if (command === "find" || command === "export") {
      const projection = await source("projection");
      const sort = await source("sort");
      request = {
        ...base,
        filter,
        ...(projection === undefined ? {} : { projection }),
        ...(sort === undefined ? {} : { sort }),
      };
    }
  }
  return validateQueryRequest(request);
}
function validateQueryRequest(request: unknown): QueryOperation {
  try {
    const decoded = decodeOperation(request) as QueryOperation;
    prepareQuery(decoded);
    return decoded;
  } catch (error) {
    if (error instanceof QueryError) throw error;
    throw new QueryError(
      "InputInvalid",
      "Use a nonempty collection, json/ejson format, limit 1-1000, and a nonnegative skip up to 2147483647. Input must fit the IPC budget."
    );
  }
}
function integer(value: string, option: "limit" | "skip"): number {
  if (!/^\d+$/.test(value))
    throw new QueryError(
      "InputInvalid",
      `Use --${option} with a nonnegative decimal integer in its supported range.`
    );
  return Number(value);
}
export async function runQueryCommand(
  directory: string,
  command: QueryCommand,
  collection: string,
  values: QueryValues
): Promise<DaemonResponse> {
  try {
    return await executeWithDaemon(directory, await buildQueryRequest(command, collection, values));
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof QueryError
          ? { code: error.code, message: error.message }
          : { code: "RequestInvalid", message: "Cannot prepare this database request." },
    };
  }
}
