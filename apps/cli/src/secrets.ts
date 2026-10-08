import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

export type SecretError = {
  readonly code:
    | "SecretReferenceInvalid"
    | "SecretUnavailable"
    | "SecretNotFound"
    | "SecretInvalid";
  readonly message: string;
};
export interface CredentialEntry {
  setPassword(value: string, signal?: AbortSignal): Promise<void>;
  getPassword(signal?: AbortSignal): Promise<string | null | undefined>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
}
export type CredentialEntryFactory = (identifier: string) => Promise<CredentialEntry>;

const unavailable = (): SecretError => ({
  code: "SecretUnavailable",
  message: "OS credential storage is unavailable or locked. Unlock it and retry.",
});

const nativeEntry: CredentialEntryFactory = async (identifier) => {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  // Require persistent Secret Service on Linux; never fall back to an in-memory kernel keyring.
  return new AsyncEntry("runnel", identifier, { linux: { store: "secret-service" } });
};

/** OS-backed connection secrets. The factory seam lets unit tests avoid the user's vault. */
export function credentialStore(entryFactory: CredentialEntryFactory = nativeEntry) {
  const entry = (reference: string) =>
    Effect.gen(function* () {
      const match = /^keyring:runnel\/([A-Za-z0-9_-]{1,128})$/.exec(reference);
      if (!match?.[1])
        return yield* Effect.fail({
          code: "SecretReferenceInvalid" as const,
          message: "The credential reference is invalid.",
        });
      const identifier = match[1];
      return yield* Effect.tryPromise({
        try: () => entryFactory(identifier),
        catch: unavailable,
      });
    });
  const remove = (reference: string): Effect.Effect<boolean, SecretError> =>
    Effect.gen(function* () {
      const credential = yield* entry(reference);
      return yield* Effect.tryPromise({
        try: (signal) => credential.deleteCredential(signal),
        catch: unavailable,
      });
    });
  return {
    withStored: <A, E>(
      value: string,
      use: (reference: string) => Effect.Effect<A, E>
    ): Effect.Effect<A, E | SecretError> =>
      Effect.gen(function* () {
        if (!value || Buffer.byteLength(value, "utf8") > 1024 * 1024)
          return yield* Effect.fail({
            code: "SecretInvalid" as const,
            message: "The connection secret is empty or exceeds the size limit.",
          });
        const reference = `keyring:runnel/${randomUUID()}`;
        const credential = yield* entry(reference);
        // Finish storage and the catalog commit together before observing cancellation.
        return yield* Effect.acquireUseRelease(
          Effect.tryPromise({
            try: async () => {
              try {
                await credential.setPassword(value);
              } catch {
                // A rejected native write may have stored the value before failing.
                await credential.deleteCredential();
                throw unavailable();
              }
              return reference;
            },
            catch: unavailable,
          }),
          use,
          (_reference, exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Effect.tryPromise({
                  try: async () => {
                    await credential.deleteCredential();
                  },
                  catch: unavailable,
                })
        );
      }).pipe(Effect.uninterruptible),
    read: (reference: string): Effect.Effect<string, SecretError> =>
      Effect.gen(function* () {
        const credential = yield* entry(reference);
        const value = yield* Effect.tryPromise({
          try: (signal) => credential.getPassword(signal),
          catch: unavailable,
        });
        // The native async binding can return null despite declaring undefined in its types.
        if (value === undefined || value === null)
          return yield* Effect.fail({
            code: "SecretNotFound" as const,
            message: "The configured connection credential is missing. Run setup again.",
          });
        return value;
      }),
    remove,
  };
}
