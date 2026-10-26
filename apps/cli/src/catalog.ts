import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const namePattern = /^[A-Za-z0-9_-]{1,64}$/;
const databasePattern = /^[^\s/\\."$*<>:|?\0]{1,63}$/;
export const isCatalogName = (value: string): boolean =>
  namePattern.test(value) && !["__proto__", "constructor", "prototype"].includes(value);
export const isDatabaseName = (value: string): boolean =>
  databasePattern.test(value) && Buffer.byteLength(value, "utf8") <= 63;

const name = Schema.String.check(Schema.isPattern(namePattern));
const connection = Schema.Struct({
  provider: Schema.Literal("mongodb"),
  secretRef: Schema.String.check(Schema.isPattern(/^keyring:runnel\/[A-Za-z0-9_-]{1,128}$/)),
});
const currentConnection = Schema.Struct({
  ...connection.fields,
  defaultDatabase: Schema.optionalKey(Schema.String.check(Schema.isPattern(databasePattern))),
});
const database = Schema.Struct({
  connection: name,
  database: Schema.String.check(Schema.isPattern(databasePattern)),
});
const timeout = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 2147483647 })
);
const settings = Schema.Struct({
  idleTimeoutMs: timeout,
  scriptTimeoutMs: timeout,
  historyEnabled: Schema.optionalKey(Schema.Boolean),
});
const legacyCatalogSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  settings,
  environments: Schema.Record(
    name,
    Schema.Struct({
      connections: Schema.Record(name, connection),
      databases: Schema.Record(name, database),
    })
  ),
});
const catalogSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  settings,
  environments: Schema.Record(
    name,
    Schema.Struct({
      defaultConnection: Schema.optionalKey(name),
      connections: Schema.Record(name, currentConnection),
      databases: Schema.Record(name, database),
    })
  ),
});

/** CLI-owned persisted configuration. Core still accepts only supplied names. */
export type Catalog = typeof catalogSchema.Type;
export type CatalogError = {
  readonly code: "CatalogInvalid" | "CatalogUnavailable";
  readonly message: string;
};

const invalid = (): CatalogError => ({
  code: "CatalogInvalid",
  message:
    "The catalog is invalid or uses an unsupported schema. Check its names, mappings, and secret references.",
});

export const emptyCatalog = (): Catalog => ({
  schemaVersion: 2,
  settings: { idleTimeoutMs: 300000, scriptTimeoutMs: 300000 },
  environments: {},
});

export function catalogDirectory(
  environment: NodeJS.ProcessEnv & {
    RUNNEL_HOME?: string;
    APPDATA?: string;
    XDG_CONFIG_HOME?: string;
  } = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir()
): string {
  const override = environment.RUNNEL_HOME;
  if (override !== undefined) {
    if (!isAbsolute(override)) throw invalid();
    return override;
  }
  const base = platform === "win32" ? environment.APPDATA : environment.XDG_CONFIG_HOME;
  if (base !== undefined && !isAbsolute(base)) throw invalid();
  return join(
    base ?? (platform === "win32" ? join(home, "AppData", "Roaming") : join(home, ".config")),
    "runnel"
  );
}

export function decodeCatalog(input: unknown): Effect.Effect<Catalog, CatalogError> {
  return Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Union([legacyCatalogSchema, catalogSchema]),
      { onExcessProperty: "error" }
    )(input).pipe(Effect.mapError(invalid));
    // Legacy mappings retain exactly their alias-only semantics. Reading never writes.
    // The next locked commit writes v2, which older v1 writers refuse to decode.
    const catalog: Catalog = { ...decoded, schemaVersion: 2 };
    for (const [envName, env] of Object.entries(catalog.environments)) {
      if (
        [envName, ...Object.keys(env.connections), ...Object.keys(env.databases)].some(
          (key) => !isCatalogName(key)
        )
      )
        return yield* Effect.fail(invalid());
      if (
        env.defaultConnection !== undefined &&
        (!isCatalogName(env.defaultConnection) ||
          !Object.hasOwn(env.connections, env.defaultConnection))
      )
        return yield* Effect.fail(invalid());
      for (const entry of Object.values(env.connections))
        if (entry.defaultDatabase !== undefined && !isDatabaseName(entry.defaultDatabase))
          return yield* Effect.fail(invalid());
      for (const alias of Object.values(env.databases)) {
        if (!Object.hasOwn(env.connections, alias.connection) || !isDatabaseName(alias.database))
          return yield* Effect.fail(invalid());
      }
    }
    return catalog;
  });
}

/** A missing catalog is empty. Invalid files fail without exposing their contents. */
export function readCatalog(directory: string): Effect.Effect<Catalog, CatalogError> {
  return Effect.gen(function* () {
    const input = yield* Effect.tryPromise({
      try: async () => {
        let file: FileHandle;
        try {
          const flags =
            process.platform === "win32"
              ? constants.O_RDONLY
              : constants.O_RDONLY | constants.O_NONBLOCK;
          file = await open(join(directory, "catalog.json"), flags);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyCatalog();
          throw error;
        }
        try {
          if (!(await file.stat()).isFile()) throw invalid();
          // Bound memory even if another process replaces or grows the file.
          const buffer = Buffer.alloc(1024 * 1024 + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
            if (bytesRead === 0) break;
            length += bytesRead;
          }
          if (length === buffer.length) throw invalid();
          try {
            // Keep any BOM so JSON.parse retains its existing rejection behavior.
            const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              buffer.subarray(0, length)
            );
            return JSON.parse(text) as unknown;
          } catch {
            throw invalid();
          }
        } finally {
          await file.close();
        }
      },
      catch: (error): CatalogError =>
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "CatalogInvalid"
          ? invalid()
          : { code: "CatalogUnavailable", message: "Cannot read the Runnel catalog." },
    });
    return yield* decodeCatalog(input);
  });
}
