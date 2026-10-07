import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const name = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));
const connection = Schema.Struct({
  provider: Schema.Literal("mongodb"),
  secretRef: Schema.String.check(Schema.isPattern(/^keyring:runnel\/[A-Za-z0-9_-]{1,128}$/)),
});
const database = Schema.Struct({
  connection: name,
  database: Schema.String.check(Schema.isPattern(/^[^\s/\\."$*<>:|?\0]{1,63}$/)),
});
const timeout = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 2147483647 })
);
const catalogSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  settings: Schema.Struct({ idleTimeoutMs: timeout, scriptTimeoutMs: timeout }),
  environments: Schema.Record(
    name,
    Schema.Struct({
      connections: Schema.Record(name, connection),
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
  schemaVersion: 1,
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
    const catalog = yield* Schema.decodeUnknownEffect(catalogSchema, { onExcessProperty: "error" })(
      input
    ).pipe(Effect.mapError(invalid));
    for (const [envName, env] of Object.entries(catalog.environments)) {
      if (
        [envName, ...Object.keys(env.connections), ...Object.keys(env.databases)].some((key) =>
          ["__proto__", "constructor", "prototype"].includes(key)
        )
      )
        return yield* Effect.fail(invalid());
      for (const alias of Object.values(env.databases)) {
        if (
          !Object.hasOwn(env.connections, alias.connection) ||
          Buffer.byteLength(alias.database, "utf8") > 63
        )
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
            return JSON.parse(buffer.toString("utf8", 0, length)) as unknown;
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
