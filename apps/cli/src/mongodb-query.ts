import * as Schema from "effect/Schema";
import { BSON, type Db, type Document, type Sort } from "mongodb";
import { parsePipeline, parseQueryObject, QueryError } from "./query-input.js";
import type { WorkerOperation, WorkerResult } from "./worker-protocol.js";

export const queryDocumentLimit = 100;
export const queryMaximumDocuments = 1000;
export const queryResultBytes = 512 * 1024;
export type QueryOperation = Extract<
  WorkerOperation,
  { operation: "describe" | "find" | "count" | "aggregate" }
>;
const decodeJson = Schema.decodeUnknownSync(Schema.JsonObject);

/** Canonical EJSON preserves BSON types. Relaxed JSON refuses unsafe Int64 conversion. */
function encode(document: Document, format: "json" | "ejson"): Schema.JsonObject {
  const checkLongs = (value: unknown): void => {
    if (value instanceof BSON.Long && !(value instanceof BSON.Timestamp)) {
      const number = value.toBigInt();
      if (number > BigInt(Number.MAX_SAFE_INTEGER) || number < BigInt(Number.MIN_SAFE_INTEGER))
        throw new QueryError(
          "ResultPrecisionLoss",
          "Use --format ejson to preserve this BSON Int64 value."
        );
    } else if (Array.isArray(value)) {
      for (const item of value) checkLongs(item);
    } else if (value instanceof BSON.Code) {
      checkLongs(value.scope);
    } else if (value instanceof BSON.DBRef) {
      checkLongs(value.oid);
      checkLongs(value.fields);
    } else if (value instanceof Map) {
      for (const item of value.values()) checkLongs(item);
    } else if (
      value !== null &&
      typeof value === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value))
    ) {
      for (const item of Object.values(value)) checkLongs(item);
    }
  };
  try {
    if (format === "json") checkLongs(document);
    return decodeJson(BSON.EJSON.serialize(document, { relaxed: format === "json" }));
  } catch (error) {
    if (error instanceof QueryError) throw error;
    throw new QueryError(
      "ResultEncodingFailed",
      "Cannot encode the operation result as JSON/EJSON."
    );
  }
}
type Cursor = AsyncIterable<Document> & { close(): Promise<void> };
async function collect(
  cursor: Cursor,
  limit: number,
  format: "json" | "ejson",
  budget = queryResultBytes
) {
  const documents: Schema.JsonObject[] = [];
  let bytes = 2;
  let reason: "documents" | "bytes" | undefined;
  try {
    for await (const item of cursor) {
      if (documents.length === limit) {
        reason = "documents";
        break;
      }
      const document = encode(item, format);
      const size = Buffer.byteLength(JSON.stringify(document), "utf8") + (documents.length ? 1 : 0);
      if (bytes + size > budget) {
        reason = "bytes";
        break;
      }
      documents.push(document);
      bytes += size;
    }
    return {
      documents,
      truncated: reason !== undefined,
      ...(reason === undefined ? {} : { truncationReason: reason }),
    };
  } finally {
    await cursor.close();
  }
}

/** Validate supplied inputs before target resolution, credential lookup, or pool acquisition. */
function parseSort(text: string): Sort {
  const input = parseQueryObject(text);
  return Object.fromEntries(
    Object.entries(input).map(([key, value]: [string, unknown]) => {
      const direction =
        value instanceof BSON.Int32 || value instanceof BSON.Double ? value.value : value;
      if (direction !== 1 && direction !== -1)
        throw new QueryError("InputInvalid", "Sort directions must be 1 or -1.");
      return [key, direction];
    })
  );
}
export function prepareQuery(request: QueryOperation): {
  filter?: Document;
  projection?: Document;
  sort?: Sort;
  pipeline?: Document[];
} {
  if (request.operation === "aggregate") return { pipeline: parsePipeline(request.pipeline) };
  if (request.operation === "describe") return {};
  const filter = parseQueryObject(request.filter ?? "{}");
  return request.operation === "count"
    ? { filter }
    : {
        filter,
        ...(request.projection === undefined
          ? {}
          : { projection: parseQueryObject(request.projection) }),
        ...(request.sort === undefined ? {} : { sort: parseSort(request.sort) }),
      };
}

export async function executeQuery(
  handle: Db,
  request: QueryOperation,
  env: string,
  db: string,
  prepared: ReturnType<typeof prepareQuery>
): Promise<WorkerResult> {
  const format = request.format ?? "ejson";
  const base = { env, db, collection: request.collection, format };
  const collection = handle.collection(request.collection, { promoteValues: false });
  if (request.operation === "count") {
    const cursor = collection.aggregate([{ $match: prepared.filter ?? {} }, { $count: "count" }], {
      timeoutMS: 10000,
      promoteValues: false,
    });
    try {
      const first = await cursor.next();
      const value: unknown = first?.["count"] ?? 0;
      let count: number | { $numberLong: string };
      if (value instanceof BSON.Long) {
        const integer = value.toBigInt();
        if (integer < 0)
          throw new QueryError("ResultEncodingFailed", "MongoDB returned an invalid count.");
        count =
          integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(integer)
            : (encode({ count: value }, format)["count"] as { $numberLong: string });
      } else {
        count =
          value instanceof BSON.Int32 || value instanceof BSON.Double
            ? value.value
            : (value as number);
        if (!Number.isSafeInteger(count) || count < 0)
          throw new QueryError(
            "ResultEncodingFailed",
            "MongoDB returned an invalid or inexact count."
          );
      }
      return { ok: true, data: { ...base, count } };
    } finally {
      await cursor.close();
    }
  }
  if (request.operation === "describe") {
    const metadataCursor = handle.listCollections(
      { name: request.collection },
      { timeoutMS: 10000, promoteValues: false }
    );
    let metadata: Schema.JsonObject;
    try {
      const first = await metadataCursor.next();
      if (!first)
        throw new QueryError("CollectionNotFound", "The named collection does not exist.");
      metadata = encode(first, format);
    } finally {
      await metadataCursor.close();
    }
    const size = Buffer.byteLength(JSON.stringify(metadata), "utf8");
    if (size > queryResultBytes - 2)
      throw new QueryError(
        "ResultTooLarge",
        "Collection metadata exceeds the 512 KiB result budget."
      );
    const indexes =
      metadata["type"] === "view"
        ? { documents: [], truncated: false }
        : await collect(
            collection.listIndexes({ timeoutMS: 10000, promoteValues: false }),
            queryMaximumDocuments,
            format,
            queryResultBytes - size
          );
    return {
      ok: true,
      data: {
        ...base,
        metadata,
        indexes: indexes.documents,
        truncated: indexes.truncated,
        ...("truncationReason" in indexes ? { truncationReason: indexes.truncationReason } : {}),
        limits: { documents: queryMaximumDocuments, bytes: queryResultBytes },
      },
    };
  }
  const limit = request.limit ?? queryDocumentLimit;
  const cursor =
    request.operation === "find"
      ? collection.find(prepared.filter ?? {}, {
          limit: limit + 1,
          skip: request.skip ?? 0,
          batchSize: Math.min(limit + 1, 100),
          timeoutMS: 10000,
          ...(prepared.projection === undefined ? {} : { projection: prepared.projection }),
          ...(prepared.sort === undefined ? {} : { sort: prepared.sort }),
        })
      : collection.aggregate(prepared.pipeline ?? [], {
          batchSize: Math.min(limit + 1, 100),
          timeoutMS: 10000,
        });
  const result = await collect(cursor, limit, format);
  return {
    ok: true,
    data: { ...base, ...result, limits: { documents: limit, bytes: queryResultBytes } },
  };
}
