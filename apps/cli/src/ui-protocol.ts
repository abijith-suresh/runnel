import * as Schema from "effect/Schema";

const name = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
const database = Schema.String.check(Schema.isMaxLength(63));
const uri = Schema.String.check(Schema.isMaxLength(16384));
const revision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const target = { env: name, connection: name };
const request = Schema.Union([
  Schema.Struct({ action: Schema.Literal("registerEnvironment"), env: name, uri, revision }),
  Schema.Struct({
    action: Schema.Literal("registerConnection"),
    ...target,
    uri,
    revision,
    makeDefault: Schema.Boolean,
    aliases: Schema.Array(Schema.Struct({ name, database })).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({ action: Schema.Literal("defaultConnection"), ...target, revision }),
  Schema.Struct({ action: Schema.Literal("removeConnection"), ...target, revision }),
  Schema.Struct({ action: Schema.Literal("replaceCredential"), ...target, uri, revision }),
  Schema.Struct({
    action: Schema.Literal("addDatabase"),
    ...target,
    alias: name,
    database,
    revision,
  }),
  Schema.Struct({
    action: Schema.Literal("renameDatabase"),
    env: name,
    alias: name,
    name,
    revision,
  }),
  Schema.Struct({ action: Schema.Literal("removeDatabase"), env: name, alias: name, revision }),
  Schema.Struct({ action: Schema.Literals(["test", "discover"]), ...target }),
  Schema.Struct({ action: Schema.Literal("settings"), patch: Schema.Unknown, revision }),
  Schema.Struct({ action: Schema.Literals(["stopDaemon", "stopManager"]) }),
]);
export type ManagerOperation = typeof request.Type;
export const decodeManagerOperation = Schema.decodeUnknownSync(request, {
  onExcessProperty: "error",
});
export const decodePairing = Schema.decodeUnknownSync(
  Schema.Struct({ code: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)) }),
  { onExcessProperty: "error" }
);

/** Responses never include upstream exception text or a reflected input. */
export function managerError(code: string) {
  const messages: Record<string, string> = {
    RequestInvalid: "The management request is invalid or exceeds its limits.",
    Unauthorized: "This browser session has expired. Use a fresh pairing link from the terminal.",
    Forbidden: "This request is not from the paired local manager.",
    Busy: "The manager is busy. Refresh before making another change.",
    CatalogChanged: "The catalog changed. Refresh before making another change.",
    SetupNameConflict: "That environment or connection already exists. Refresh its registration.",
    ConnectionChanged: "The connection changed. Refresh before replacing credentials.",
    ConnectionInUse: "Remove this connection's aliases before removing the connection.",
    ConnectionNotFound: "The connection is not configured. Refresh the catalog.",
    EnvironmentNotFound: "The environment is not configured. Refresh the catalog.",
    DatabaseNotFound: "The alias is not configured. Refresh the catalog.",
    DatabaseNameConflict: "That alias already exists in this environment.",
    ConnectionInvalid: "Enter a valid MongoDB URI with a valid optional default database.",
    SecretInvalid: "Enter a MongoDB URI of at most 16 KiB.",
    SecretNotFound: "The stored credential is missing. Replace the connection credential.",
    SecretUnavailable: "OS credential storage is unavailable or locked. Unlock it and retry.",
    PermissionDenied:
      "The database user does not have permission for this operation. Discovery is optional.",
    AuthenticationFailed: "MongoDB rejected the credentials. The connection was not changed.",
    DatabaseUnavailable: "Cannot reach MongoDB. Check the connection and retry explicitly.",
    DatabaseTimedOut: "MongoDB exceeded its operation deadline.",
    OperationCancelled:
      "The request was cancelled. Refresh to check whether a catalog change completed.",
    OperationOutcomeUnknown:
      "The result was lost. Refresh before retrying. The request was not replayed.",
    SettingsInvalid: "Use supported timeout bounds and a boolean history setting.",
    CatalogBusy: "Another process is updating the catalog. Refresh before trying again.",
    CatalogTooLarge: "The catalog exceeds the 1 MiB size limit.",
    ManagementInvalid: "Use valid environment, connection, alias and physical database names.",
    SetupInvalid: "Use valid environment, connection and optional alias names.",
  };
  return Object.hasOwn(messages, code)
    ? { code, message: messages[code]! }
    : {
        code: "ManagementUnavailable",
        message: "Cannot complete this operation. Refresh before trying again.",
      };
}
