import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { type Catalog, readCatalog } from "./catalog.js";
import { updateCatalog } from "./catalog-write.js";
import { describeConnections, describeDatabases } from "./discovery.js";
import { scriptMaximumTimeoutMs } from "./worker-protocol.js";

export const settingsLimits = {
  idleTimeoutMs: { minimum: 0, maximum: 2147483647 },
  scriptTimeoutMs: { minimum: 0, maximum: scriptMaximumTimeoutMs },
} as const;
export const settingsApplication = {
  idleTimeoutMs: "next-daemon-start",
  scriptTimeoutMs: "next-script-without-timeout-override",
  historyEnabled: "next-submitted-operation",
} as const;
const integer = (maximum: number) =>
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum }));
const patchSchema = Schema.Struct({
  idleTimeoutMs: Schema.optionalKey(integer(settingsLimits.idleTimeoutMs.maximum)),
  scriptTimeoutMs: Schema.optionalKey(integer(settingsLimits.scriptTimeoutMs.maximum)),
  historyEnabled: Schema.optionalKey(Schema.Boolean),
});
export type SettingsPatch = typeof patchSchema.Type;
export type SettingsError = { readonly code: "SettingsInvalid"; readonly message: string };
const invalid = (): SettingsError => ({
  code: "SettingsInvalid",
  message:
    "Supply at least one supported setting: integer idleTimeoutMs 0-2147483647, integer scriptTimeoutMs 0-2147483547, or boolean historyEnabled. Unknown settings are rejected.",
});

function settingsView(catalog: Catalog) {
  return {
    settings: {
      idleTimeoutMs: catalog.settings.idleTimeoutMs,
      scriptTimeoutMs: catalog.settings.scriptTimeoutMs,
      historyEnabled: catalog.settings.historyEnabled ?? true,
    },
    limits: settingsLimits,
    applies: settingsApplication,
  };
}

/** Catalog-only reads; never inspect credentials or contact/start the daemon. */
export function getSettings(directory: string) {
  return readCatalog(directory).pipe(Effect.map(settingsView));
}

/** Merge only validated fields inside the existing catalog transaction. */
export function setSettings(directory: string, input: unknown, expectedRevision?: string) {
  return Effect.gen(function* () {
    const patch = yield* Schema.decodeUnknownEffect(patchSchema, { onExcessProperty: "error" })(
      input
    ).pipe(Effect.mapError(invalid));
    if (Object.keys(patch).length === 0) return yield* Effect.fail(invalid());
    const catalog = yield* updateCatalog(
      directory,
      (current) =>
        Effect.succeed({
          ...current,
          settings: { ...current.settings, ...patch },
        }),
      expectedRevision
    );
    return settingsView(catalog);
  });
}

/** A whitelisted management DTO. No stored URI, reference, token or credential status. */
export function configurationView(catalog: Catalog) {
  return {
    schemaVersion: catalog.schemaVersion,
    ...settingsView(catalog),
    environments: Object.keys(catalog.environments)
      .sort()
      .map((name) => {
        const env = catalog.environments[name]!;
        return {
          name,
          ...(env.defaultConnection === undefined
            ? {}
            : { defaultConnection: env.defaultConnection }),
          connections: describeConnections(env),
          databases: describeDatabases(env),
        };
      }),
  };
}

export function getConfiguration(directory: string) {
  return readCatalog(directory).pipe(Effect.map(configurationView));
}
