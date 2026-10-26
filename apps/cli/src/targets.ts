import { type ConnectionTargetRequest, resolveConnectionTarget } from "@abijith-suresh/runnel-core";
import type { Catalog } from "./catalog.js";

/** Shared selection for worker execution and redacted history/discovery. */
export function resolveCatalogTarget(catalog: Catalog, request: ConnectionTargetRequest) {
  return resolveConnectionTarget(
    new Map(
      Object.entries(catalog.environments).map(([env, value]) => [
        env,
        {
          ...value,
          connections: new Map(Object.entries(value.connections)),
          databases: new Map(Object.entries(value.databases)),
        },
      ])
    ),
    request
  );
}
