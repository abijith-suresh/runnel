import { executeWithDaemon } from "./daemon-client.js";
import type { DaemonResponse } from "./daemon-protocol.js";
import { prepareQuery, type QueryOperation } from "./mongodb-query.js";
import { parsePipeline, parseQueryObject, QueryError, readQueryInput } from "./query-input.js";
import { decodeOperation } from "./worker-protocol.js";

export type QueryCommand = "describe" | "find" | "count" | "aggregate";
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
    | "db",
    string
  >
>;

export async function buildQueryRequest(
  command: QueryCommand,
  collection: string,
  values: QueryValues
): Promise<QueryOperation> {
  const stems = ["filter", "projection", "sort", "pipeline"] as const;
  const stdinCount = stems.filter((key) => values[`${key}-file`] === "-").length;
  if (stdinCount > 1)
    throw new QueryError("InputInvalid", "Only one JSON/EJSON option can read stdin.");
  const source = async (key: (typeof stems)[number], fallback?: string) => {
    const inline = values[key];
    const file = values[`${key}-file`];
    if (inline !== undefined && file !== undefined)
      throw new QueryError(
        "InputInvalid",
        "Choose inline input or a file for each JSON/EJSON option."
      );
    return file === undefined ? (inline ?? fallback) : await readQueryInput(file);
  };
  const base = {
    operation: command,
    collection,
    ...(values.env === undefined ? {} : { env: values.env }),
    ...(values.db === undefined ? {} : { db: values.db }),
    ...(values.format === undefined ? {} : { format: values.format }),
  };
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
      ...(values.limit === undefined ? {} : { limit: integer(values.limit) }),
    };
  } else if (command === "describe") request = base;
  else {
    const filter = await source("filter", "{}");
    if (filter !== undefined) parseQueryObject(filter);
    request = { ...base, filter };
    if (command === "find") {
      const projection = await source("projection");
      const sort = await source("sort");
      request = {
        ...base,
        filter,
        ...(projection === undefined ? {} : { projection }),
        ...(sort === undefined ? {} : { sort }),
        ...(values.limit === undefined ? {} : { limit: integer(values.limit) }),
        ...(values.skip === undefined ? {} : { skip: integer(values.skip) }),
      };
    }
  }
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
function integer(value: string): number {
  if (!/^\d+$/.test(value))
    throw new QueryError(
      "InputInvalid",
      "Limits and offsets must be decimal integers in the supported range."
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
