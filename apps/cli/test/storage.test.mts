import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { lock } from "proper-lockfile";
import { updateCatalog } from "../dist/catalog-write.js";
import { emptyCatalog, readCatalog } from "../dist/catalog.js";
import { type CredentialEntryFactory, credentialStore } from "../dist/secrets.js";

test("catalog updates persist validated mappings, tighten new file permissions, and leave no temporary files", async (t) => {
  const parent = mkdtempSync(join(tmpdir(), "runnel-store-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, "config");
  const first = await Effect.runPromise(
    updateCatalog(directory, (current) =>
      Effect.succeed({
        ...current,
        environments: { ...current.environments, local: { connections: {}, databases: {} } },
      })
    )
  );
  assert.deepEqual(await Effect.runPromise(readCatalog(directory)), first);
  await Effect.runPromise(
    updateCatalog(directory, (current) =>
      Effect.succeed({
        ...current,
        environments: { ...current.environments, work: { connections: {}, databases: {} } },
      })
    )
  );
  assert.deepEqual(Object.keys((await Effect.runPromise(readCatalog(directory))).environments), [
    "local",
    "work",
  ]);
  assert.deepEqual(readdirSync(directory), ["catalog.json"]);
  if (process.platform !== "win32") {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(directory, "catalog.json")).mode & 0o777, 0o600);
  }
});

test("invalid updates and updater failures preserve the original catalog and release the lock", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-store-fail-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = JSON.stringify(emptyCatalog());
  writeFileSync(join(directory, "catalog.json"), initial);
  const invalid = await Effect.runPromise(
    updateCatalog(directory, () =>
      Effect.succeed({ ...emptyCatalog(), uri: "synthetic-private-value" })
    ).pipe(Effect.result)
  );
  assert(Result.isFailure(invalid));
  assert.equal(invalid.failure.code, "CatalogInvalid");
  const declined = await Effect.runPromise(
    updateCatalog(directory, () => Effect.fail("declined")).pipe(Effect.result)
  );
  assert(Result.isFailure(declined));
  assert.equal(declined.failure, "declined");
  assert.equal(readFileSync(join(directory, "catalog.json"), "utf8"), initial);
  assert.deepEqual(readdirSync(directory), ["catalog.json"]);
  await Effect.runPromise(updateCatalog(directory, Effect.succeed));
});

test("writer refuses oversized catalogs without replacing the previous file", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-store-size-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = JSON.stringify(emptyCatalog());
  writeFileSync(join(directory, "catalog.json"), initial);
  const connections = Object.fromEntries(
    Array.from({ length: 13000 }, (_, index) => [
      `connection_${index}`,
      { provider: "mongodb" as const, secretRef: `keyring:runnel/connection_${index}` },
    ])
  );
  const result = await Effect.runPromise(
    updateCatalog(directory, () =>
      Effect.succeed({
        ...emptyCatalog(),
        environments: { local: { connections, databases: {} } },
      })
    ).pipe(Effect.result)
  );
  assert(Result.isFailure(result));
  assert.equal(result.failure.code, "CatalogTooLarge");
  assert.equal(readFileSync(join(directory, "catalog.json"), "utf8"), initial);
  assert.deepEqual(readdirSync(directory), ["catalog.json"]);
});

test("invalid persisted catalogs are preserved and never passed to an updater", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-store-invalid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "catalog.json"), "{synthetic-private-value");
  let touched = false;
  const result = await Effect.runPromise(
    updateCatalog(directory, () => {
      touched = true;
      return Effect.succeed(emptyCatalog());
    }).pipe(Effect.result)
  );
  assert(Result.isFailure(result));
  assert.equal(result.failure.code, "CatalogInvalid");
  assert.equal(touched, false);
  assert.equal(readFileSync(join(directory, "catalog.json"), "utf8"), "{synthetic-private-value");
  assert.deepEqual(readdirSync(directory), ["catalog.json"]);
});

test("interruption during an updater preserves the file and releases its lock", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-store-cancel-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const initial = JSON.stringify(emptyCatalog());
  writeFileSync(join(directory, "catalog.json"), initial);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* updateCatalog(directory, () =>
        Effect.sync(entered).pipe(Effect.andThen(Effect.never))
      ).pipe(Effect.forkChild);
      yield* Effect.promise(() => ready);
      yield* Fiber.interrupt(fiber);
    })
  );
  assert.equal(readFileSync(join(directory, "catalog.json"), "utf8"), initial);
  assert.deepEqual(readdirSync(directory), ["catalog.json"]);
  await Effect.runPromise(updateCatalog(directory, Effect.succeed));
});

test("an active writer returns a bounded busy error; abandoned stale locks recover", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-store-lock-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "catalog.json");
  const release = await lock(path, { realpath: false, stale: 10000, update: 3000 });
  try {
    const result = await Effect.runPromise(
      updateCatalog(directory, Effect.succeed).pipe(Effect.result)
    );
    assert(Result.isFailure(result));
    assert.equal(result.failure.code, "CatalogBusy");
  } finally {
    await release();
  }
  mkdirSync(`${path}.lock`);
  const stale = new Date(Date.now() - 20000);
  utimesSync(`${path}.lock`, stale, stale);
  await Effect.runPromise(updateCatalog(directory, Effect.succeed));
  assert.deepEqual(readdirSync(directory), ["catalog.json"]);
});

test("separate processes serialize catalog updates without losing aliases", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-store-processes-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const writer = new URL("../dist/catalog-write.js", import.meta.url).href;
  const program = `import * as Effect from 'effect/Effect';
    import { updateCatalog } from ${JSON.stringify(writer)};
    await Effect.runPromise(updateCatalog(process.argv[1], current => Effect.succeed({
      ...current, environments: {...current.environments, [process.argv[2]]: {connections:{},databases:{}}}
    })));`;
  await Promise.all(
    ["alpha", "beta", "gamma", "delta"].map(
      (name) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--input-type=module", "-e", program, directory, name],
            { cwd: new URL("..", import.meta.url), stdio: ["ignore", "ignore", "pipe"] }
          );
          let stderr = "";
          child.stderr.on("data", (data: Buffer) => {
            stderr += data.toString();
          });
          child.on("error", reject);
          child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
        })
    )
  );
  assert.deepEqual(
    Object.keys((await Effect.runPromise(readCatalog(directory))).environments).sort(),
    ["alpha", "beta", "delta", "gamma"]
  );
  assert.deepEqual(readdirSync(directory), ["catalog.json"]);
});

function fakeVault() {
  const values = new Map<string, string>();
  const entryFactory: CredentialEntryFactory = async (identifier) => ({
    setPassword: async (value) => {
      values.set(identifier, value);
    },
    getPassword: async () => values.get(identifier),
    deleteCredential: async () => values.delete(identifier),
  });
  return { values, store: credentialStore(entryFactory) };
}

test("credential storage retains secrets after catalog commit and catalogs contain only references", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-store-secret-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { store } = fakeVault();
  const reference = await Effect.runPromise(
    store.withStored("synthetic-private-value", (secretRef) =>
      updateCatalog(directory, (current) =>
        Effect.succeed({
          ...current,
          environments: {
            local: { connections: { primary: { provider: "mongodb", secretRef } }, databases: {} },
          },
        })
      ).pipe(Effect.as(secretRef))
    )
  );
  assert.match(reference, /^keyring:runnel\/[a-f0-9-]{36}$/);
  assert.equal(await Effect.runPromise(store.read(reference)), "synthetic-private-value");
  assert.doesNotMatch(
    readFileSync(join(directory, "catalog.json"), "utf8"),
    /synthetic-private-value/
  );
  assert.equal(await Effect.runPromise(store.remove(reference)), true);
  assert.equal(await Effect.runPromise(store.remove(reference)), false);
  const missing = await Effect.runPromise(store.read(reference).pipe(Effect.result));
  assert(Result.isFailure(missing));
  assert.equal(missing.failure.code, "SecretNotFound");
});

test("failed catalog commits remove newly stored credentials", async () => {
  const { values, store } = fakeVault();
  const result = await Effect.runPromise(
    store.withStored("synthetic", () => Effect.fail("catalog rejected")).pipe(Effect.result)
  );
  assert(Result.isFailure(result));
  assert.equal(result.failure, "catalog rejected");
  assert.equal(values.size, 0);
});

test("cancellation waits for a credential and catalog commit to finish together", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-secret-cancel-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { values, store } = fakeVault();
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* store
        .withStored("synthetic", (secretRef) =>
          Effect.sync(entered).pipe(
            Effect.andThen(Effect.sleep(25)),
            Effect.andThen(
              updateCatalog(directory, (current) =>
                Effect.succeed({
                  ...current,
                  environments: {
                    local: {
                      connections: { primary: { provider: "mongodb", secretRef } },
                      databases: {},
                    },
                  },
                })
              )
            )
          )
        )
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => ready);
      yield* Fiber.interrupt(fiber);
    })
  );
  const catalog = await Effect.runPromise(readCatalog(directory));
  const { local } = catalog.environments;
  const { primary } = local?.connections ?? {};
  const reference = primary?.secretRef;
  assert(reference);
  assert.equal(values.size, 1);
  assert.equal(await Effect.runPromise(store.read(reference)), "synthetic");
});

test("credential operations validate references and values before accessing the vault", async () => {
  let touched = false;
  const store = credentialStore(async () => {
    touched = true;
    throw new Error("unexpected");
  });
  for (const reference of [
    "",
    "mongodb://private.invalid",
    "keyring:runnel/../other",
    "keyring:other/name",
  ]) {
    for (const operation of [
      store.read(reference).pipe(Effect.as(null)),
      store.remove(reference).pipe(Effect.as(null)),
    ]) {
      const result = await Effect.runPromise(operation.pipe(Effect.result));
      assert(Result.isFailure(result));
      assert.equal(result.failure.code, "SecretReferenceInvalid");
      assert.doesNotMatch(JSON.stringify(result.failure), /private.invalid/);
    }
  }
  for (const value of ["", "x".repeat(1024 * 1024 + 1)]) {
    const result = await Effect.runPromise(
      store.withStored(value, Effect.succeed).pipe(Effect.result)
    );
    assert(Result.isFailure(result));
    assert.equal(result.failure.code, "SecretInvalid");
  }
  assert.equal(touched, false);
});

test("native credential failures omit underlying secret-bearing diagnostics and clean partial writes", async () => {
  const secret = "synthetic-private-value";
  const failure = () => Promise.reject(new Error(secret));
  let deleted = false;
  const store = credentialStore(async () => ({
    setPassword: failure,
    getPassword: failure,
    deleteCredential: async () => {
      deleted = true;
      return true;
    },
  }));
  const write = await Effect.runPromise(
    store.withStored(secret, Effect.succeed).pipe(Effect.result)
  );
  assert(Result.isFailure(write));
  assert.equal(write.failure.code, "SecretUnavailable");
  assert.equal(deleted, true);
  const read = await Effect.runPromise(store.read("keyring:runnel/fixture").pipe(Effect.result));
  assert(Result.isFailure(read));
  assert.equal(read.failure.code, "SecretUnavailable");
  assert.doesNotMatch(JSON.stringify([write.failure, read.failure]), /synthetic-private-value/);
});
