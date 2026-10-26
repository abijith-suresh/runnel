import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { readCatalog } from "./catalog.js";
import { catalogRevision } from "./catalog-write.js";
import { daemonCommand, executeWithDaemon } from "./daemon-client.js";
import * as management from "./management.js";
import { credentialStore } from "./secrets.js";
import { configurationView, setSettings } from "./settings.js";
import { registerConnection, registerEnvironment } from "./setup.js";
import { type ManagerOperation, managerError } from "./ui-protocol.js";

export type ManagerDependencies = {
  readonly secrets?: ReturnType<typeof credentialStore>;
  readonly execute?: typeof executeWithDaemon;
};
export async function managerConfiguration(directory: string) {
  return Effect.runPromise(
    readCatalog(directory).pipe(
      Effect.map((catalog) => ({
        ...configurationView(catalog),
        revision: catalogRevision(catalog),
      }))
    )
  );
}
async function effectResult<A, E extends { readonly code: string }>(effect: Effect.Effect<A, E>) {
  const result = await Effect.runPromise(effect.pipe(Effect.result));
  return Result.isSuccess(result)
    ? { ok: true as const, data: result.success }
    : { ok: false as const, error: managerError(result.failure.code) };
}
/** Thin HTTP adapter over the same application operations used by the terminal. */
export async function managerOperation(
  directory: string,
  input: ManagerOperation,
  signal: AbortSignal,
  dependencies: ManagerDependencies
) {
  const secrets = dependencies.secrets ?? credentialStore();
  const execute = dependencies.execute ?? executeWithDaemon;
  const target =
    "env" in input && "connection" in input
      ? { env: input.env, connection: input.connection }
      : undefined;
  switch (input.action) {
    case "registerEnvironment":
      return effectResult(registerEnvironment(directory, input, secrets, input.revision));
    case "registerConnection":
      return effectResult(registerConnection(directory, input, secrets, input.revision));
    case "defaultConnection":
      return management.defaultConnection(directory, target!, input.revision);
    case "removeConnection":
      return management.removeConnection(directory, target!, secrets, input.revision);
    case "replaceCredential":
      return management.replaceConnectionCredential(directory, input, {
        secrets,
        signal,
        expectedRevision: input.revision,
        inspect: (uri, inspectionSignal) =>
          execute(directory, { operation: "inspect", uri, testOnly: true }, inspectionSignal),
      });
    case "addDatabase":
      return management.addDatabase(directory, input, input.revision);
    case "renameDatabase":
      return management.renameDatabase(
        directory,
        { env: input.env, alias: input.alias, to: input.name },
        input.revision
      );
    case "removeDatabase":
      return management.removeDatabase(directory, input, input.revision);
    case "settings":
      return effectResult(setSettings(directory, input.patch, input.revision));
    case "test":
    case "discover":
      return management.inspectConnection(
        directory,
        target!,
        input.action === "discover",
        signal,
        execute
      );
    case "stopDaemon":
      return daemonCommand(directory, "stop");
    case "stopManager":
      return { ok: true as const, data: { stopped: true } };
  }
}
