import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { lock } from "proper-lockfile";
import { type Catalog, type CatalogError, decodeCatalog, readCatalog } from "./catalog.js";

export type CatalogWriteError =
  | CatalogError
  | {
      readonly code: "CatalogBusy" | "CatalogTooLarge";
      readonly message: string;
    };
const unavailable = (): CatalogWriteError => ({
  code: "CatalogUnavailable",
  message: "Cannot update the Runnel catalog.",
});
const busy = (): CatalogWriteError => ({
  code: "CatalogBusy",
  message: "Another process is updating the catalog. Retry shortly.",
});

/** Serialize a read/modify/write transaction. The updater must not perform external side effects. */
export function updateCatalog<E>(
  directory: string,
  update: (catalog: Catalog) => Effect.Effect<Catalog, E>
): Effect.Effect<Catalog, E | CatalogWriteError> {
  const acquire = Effect.tryPromise({
    try: async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const resolved = await realpath(directory);
      const state = { compromised: false, committed: false };
      const release = await lock(join(resolved, "catalog.json"), {
        realpath: false,
        stale: 10000,
        update: 3000,
        retries: { retries: 10, factor: 1, minTimeout: 100, maxTimeout: 100 },
        onCompromised: () => {
          state.compromised = true;
        },
      });
      return { directory: resolved, release, state };
    },
    catch: (error) =>
      (error as NodeJS.ErrnoException).code === "ELOCKED" ? busy() : unavailable(),
  });
  return Effect.acquireUseRelease(
    acquire,
    (owner) =>
      Effect.gen(function* () {
        const current = yield* readCatalog(owner.directory);
        const next = yield* update(current);
        const validated = yield* decodeCatalog(next);
        const contents = `${JSON.stringify(validated, null, 2)}\n`;
        if (Buffer.byteLength(contents, "utf8") > 1024 * 1024)
          return yield* Effect.fail({
            code: "CatalogTooLarge" as const,
            message: "The catalog exceeds the 1 MiB size limit.",
          });
        yield* Effect.tryPromise({
          try: async () => {
            const destination = join(owner.directory, "catalog.json");
            try {
              if (!(await lstat(destination)).isFile()) throw { code: "CatalogInvalid" };
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            const temporary = join(owner.directory, `.catalog-${randomUUID()}.tmp`);
            try {
              const file = await open(temporary, "wx", 0o600);
              try {
                await file.writeFile(contents);
                await file.sync();
              } finally {
                await file.close();
              }
              if (owner.state.compromised) throw { code: "CatalogBusy" };
              await rename(temporary, destination);
              owner.state.committed = true;
            } finally {
              await rm(temporary, { force: true }).catch(() => undefined);
            }
          },
          catch: (error): CatalogWriteError => {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === "CatalogBusy") return busy();
            if (code === "CatalogInvalid")
              return { code, message: "The catalog must be a regular file." };
            return unavailable();
          },
        }).pipe(Effect.uninterruptible);
        return validated;
      }),
    (owner) =>
      Effect.tryPromise({
        try: async () => {
          try {
            await owner.release();
          } catch (error) {
            // A committed catalog must not be reported as rolled back. Stale locks recover automatically.
            if (!owner.state.committed) throw error;
          }
        },
        catch: unavailable,
      })
  );
}
