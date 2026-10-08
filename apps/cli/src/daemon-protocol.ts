import * as Schema from "effect/Schema";
import { bounded, resultSchema } from "./worker-protocol.js";

const text = Schema.String.check(Schema.isMaxLength(1024));
const positive = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0));
const token = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const uuid = Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/));
const descriptorSchema = Schema.Struct({
  protocol: Schema.Literal(1),
  endpoint: text,
  token,
  instance: uuid,
  pid: positive,
  version: text,
});
export type DaemonDescriptor = typeof descriptorSchema.Type;
const commandSchema = Schema.Union([
  Schema.Struct({ token, action: Schema.Literals(["status", "reset", "stop"]) }),
  Schema.Struct({ token, action: Schema.Literal("execute"), request: Schema.Unknown }),
]);
export type DaemonCommand = typeof commandSchema.Type;
const responseSchema = Schema.Union([
  Schema.Union([
    Schema.Struct({
      ...resultSchema.members[0].fields,
      warning: Schema.optionalKey(Schema.Literal("HistoryUnavailable")),
    }),
    Schema.Struct({
      ...resultSchema.members[1].fields,
      warning: Schema.optionalKey(Schema.Literal("HistoryUnavailable")),
    }),
  ]),
  Schema.Struct({
    ok: Schema.Literal(true),
    data: Schema.Union([
      Schema.Struct({ running: Schema.Literal(false) }),
      Schema.Struct({ reset: Schema.Literal(true) }),
      Schema.Struct({ stopped: Schema.Literal(true) }),
      Schema.Struct({
        running: Schema.Literal(true),
        pid: positive,
        version: text,
        worker: Schema.Struct({
          state: Schema.Literals(["idle", "running", "stopped", "restarting"]),
          pid: Schema.optionalKey(positive),
          active: Schema.Boolean,
          queued: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
        }),
      }),
    ]),
  }),
]);
export type DaemonResponse = typeof responseSchema.Type;
export const decodeDescriptor = Schema.decodeUnknownSync(descriptorSchema, {
  onExcessProperty: "error",
});
export function decodeCommand(input: unknown): DaemonCommand {
  bounded(input);
  return Schema.decodeUnknownSync(commandSchema, { onExcessProperty: "error" })(input);
}
export function decodeDaemonResponse(input: unknown): DaemonResponse {
  bounded(input);
  return Schema.decodeUnknownSync(responseSchema, { onExcessProperty: "error" })(input);
}
