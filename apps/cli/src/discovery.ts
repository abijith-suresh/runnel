import * as Effect from "effect/Effect";
import { type CatalogError, readCatalog } from "./catalog.js";

export type DiscoveryCommand = "envs" | "connections" | "databases";
export type DiscoveryError =
  | CatalogError
  | {
      readonly code: "EnvironmentRequired" | "EnvironmentNotFound";
      readonly message: string;
    };

export function discover(
  directory: string,
  command: DiscoveryCommand,
  env?: string
): Effect.Effect<unknown, DiscoveryError> {
  return Effect.gen(function* () {
    if (command !== "envs" && env === undefined)
      return yield* Effect.fail({
        code: "EnvironmentRequired" as const,
        message: "Specify an environment with -e or --env.",
      });
    const catalog = yield* readCatalog(directory);
    if (command === "envs")
      return {
        environments: Object.keys(catalog.environments)
          .sort()
          .map((name) => ({
            name,
            ...(catalog.environments[name]?.defaultConnection === undefined
              ? {}
              : {
                  defaultConnection: catalog.environments[name]?.defaultConnection,
                }),
          })),
      };
    const selected =
      env !== undefined && Object.hasOwn(catalog.environments, env)
        ? catalog.environments[env]
        : undefined;
    if (!selected)
      return yield* Effect.fail({
        code: "EnvironmentNotFound" as const,
        message: "The named environment is not configured.",
      });
    if (command === "connections")
      return {
        connections: Object.keys(selected.connections)
          .sort()
          .map((name) => ({
            name,
            provider: selected.connections[name]?.provider,
            ...(selected.defaultConnection === name ? { default: true } : {}),
            ...(selected.connections[name]?.defaultDatabase === undefined
              ? {}
              : {
                  defaultDatabase: selected.connections[name]?.defaultDatabase,
                }),
          })),
      };
    return {
      ...(selected.defaultConnection === undefined
        ? {}
        : {
            defaultConnection: selected.defaultConnection,
            physicalDatabaseSelection: true,
            ...(selected.connections[selected.defaultConnection]?.defaultDatabase === undefined
              ? {}
              : {
                  defaultDatabase:
                    selected.connections[selected.defaultConnection]?.defaultDatabase,
                }),
          }),
      databases: Object.keys(selected.databases)
        .sort()
        .map((name) => ({ name, ...selected.databases[name] })),
    };
  });
}
