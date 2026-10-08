import * as Schema from "effect/Schema";

export const ipcLimitBytes = 1024 * 1024;
export const nameLimit = 1000;
const text = Schema.String.check(Schema.isMaxLength(1024));
const requestSchema = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("inspect"), uri: Schema.String }),
  Schema.Struct({
    operation: Schema.Literal("list"),
    env: Schema.optionalKey(text),
    db: Schema.optionalKey(text),
  }),
]);
export type WorkerOperation = typeof requestSchema.Type;
const errorSchema = Schema.Struct({ code: text, message: text });
export const resultSchema = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.Union([
      Schema.Struct({ databases: Schema.Array(text), truncated: Schema.Boolean }),
      Schema.Struct({
        env: text,
        db: text,
        collections: Schema.Array(Schema.Struct({ name: text, type: text })),
        truncated: Schema.Boolean,
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
