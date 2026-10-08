import * as Schema from "effect/Schema";

export const ipcLimitBytes = 1024 * 1024;
export const nameLimit = 1000;
const text = Schema.String.check(Schema.isMaxLength(1024));
const target = { env: Schema.optionalKey(text), db: Schema.optionalKey(text) };
const collection = Schema.String.check(Schema.isPattern(/^[^\0]{1,1024}$/));
const format = Schema.optionalKey(Schema.Literals(["json", "ejson"]));
const limit = Schema.optionalKey(
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 1000 }))
);
const input = Schema.optionalKey(Schema.String);
const requestSchema = Schema.Union([
  Schema.Struct({
    operation: Schema.Literal("run"),
    ...target,
    path: Schema.String.check(Schema.isMaxLength(32768)),
    args: Schema.optionalKey(Schema.String),
    format,
    timeoutMs: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 0, maximum: 2147483547 })
    ),
  }),
  Schema.Struct({ operation: Schema.Literal("inspect"), uri: Schema.String }),
  Schema.Struct({
    operation: Schema.Literal("list"),
    ...target,
  }),
  Schema.Struct({ operation: Schema.Literal("describe"), ...target, collection, format }),
  Schema.Struct({
    operation: Schema.Literal("count"),
    ...target,
    collection,
    format,
    filter: input,
  }),
  Schema.Struct({
    operation: Schema.Literal("find"),
    ...target,
    collection,
    format,
    filter: input,
    projection: input,
    sort: input,
    limit,
    skip: Schema.optionalKey(
      Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 2147483647 }))
    ),
  }),
  Schema.Struct({
    operation: Schema.Literal("aggregate"),
    ...target,
    collection,
    format,
    pipeline: Schema.String,
    limit,
  }),
]);
export type WorkerOperation = typeof requestSchema.Type;
const errorSchema = Schema.Struct({ code: text, message: text });
const queryTarget = {
  env: text,
  db: text,
  collection: text,
  format: Schema.Literals(["json", "ejson"]),
};
const truncation = {
  truncated: Schema.Boolean,
  truncationReason: Schema.optionalKey(Schema.Literals(["documents", "bytes"])),
  limits: Schema.Struct({
    documents: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 1000 })),
    bytes: Schema.Number.check(
      Schema.isInt(),
      Schema.isBetween({ minimum: 1, maximum: 512 * 1024 })
    ),
  }),
};
export const resultSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.Union([
      Schema.Struct({
        env: text,
        db: text,
        format: Schema.Literals(["json", "ejson"]),
        value: Schema.Json,
        limits: Schema.Struct({ bytes: Schema.Literal(512 * 1024) }),
      }),
      Schema.Struct({ databases: Schema.Array(text), truncated: Schema.Boolean }),
      Schema.Struct({
        env: text,
        db: text,
        collections: Schema.Array(Schema.Struct({ name: text, type: text })),
        truncated: Schema.Boolean,
      }),
      Schema.Struct({
        ...queryTarget,
        count: Schema.Union([
          Schema.Number.check(
            Schema.isInt(),
            Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
          ),
          Schema.Struct({ $numberLong: Schema.String.check(Schema.isPattern(/^[0-9]{1,19}$/)) }),
        ]),
      }),
      Schema.Struct({
        ...queryTarget,
        ...truncation,
        documents: Schema.Array(Schema.JsonObject).check(Schema.isMaxLength(1000)),
      }),
      Schema.Struct({
        ...queryTarget,
        ...truncation,
        metadata: Schema.JsonObject,
        indexes: Schema.Array(Schema.JsonObject).check(Schema.isMaxLength(1000)),
      }),
    ]),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: errorSchema }),
]);
export type WorkerResult = typeof resultSchema.Type;
const requestMessage = Schema.Struct({
  type: Schema.Literal("request"),
  id: text,
  request: requestSchema,
});
const responseMessage = Schema.Union([
  Schema.Struct({ type: Schema.Literal("ready") }),
  Schema.Struct({ type: Schema.Literal("result"), id: text, result: resultSchema }),
]);

/** Internal IPC format, not a public API or a catalog schema. */
export function decodeOperation(input: unknown): WorkerOperation {
  bounded(input);
  return Schema.decodeUnknownSync(requestSchema, { onExcessProperty: "error" })(input);
}
export function decodeRequest(input: unknown): typeof requestMessage.Type {
  bounded(input);
  return Schema.decodeUnknownSync(requestMessage, { onExcessProperty: "error" })(input);
}
export function decodeResponse(input: unknown): typeof responseMessage.Type {
  bounded(input);
  return Schema.decodeUnknownSync(responseMessage, { onExcessProperty: "error" })(input);
}
export function bounded(input: unknown): void {
  const encoded = JSON.stringify(input);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > ipcLimitBytes)
    throw new Error("IPC size limit exceeded.");
}
export const failure = (code: string, message: string): WorkerResult => ({
  ok: false,
  error: { code, message },
});
