import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as Effect from "effect/Effect";
import { readCatalog } from "../dist/catalog.js";
import { updateCatalog } from "../dist/catalog-write.js";
import {
  addDatabase,
  type ManagementResult,
  removeConnection,
  removeDatabase,
  renameDatabase,
  rotateConnection,
} from "../dist/management.js";
import { credentialStore } from "../dist/secrets.js";
import { PromptError, type SetupPrompt } from "../dist/setup-prompt.js";

const envName = "local";
const connectionName = "primary";
const customersAlias = "customers";
const target = { env: "local", connection: "primary" };
const alias = { env: "local", alias: "accounts" };
const original = "mongodb://synthetic:old-private-value@example.invalid";
const replacement = "mongodb://synthetic:new-private-value@example.invalid";

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "runnel-management-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const stored = new Map<string, string>();
  const hooks: {
    set?: (id: string, value: string) => Promise<void>;
    remove?: (id: string) => Promise<void>;
  } = {};
  const removed: string[] = [];
  let writes = 0;
  const secrets = credentialStore(async (id) => ({
    async setPassword(value) {
      writes++;
      stored.set(id, value);
      await hooks.set?.(id, value);
    },
    async getPassword() {
      return stored.get(id);
    },
    async deleteCredential() {
      await hooks.remove?.(id);
      removed.push(id);
      return stored.delete(id);
    },
  }));
  const catalog = () => Effect.runPromise(readCatalog(directory));
  const text = () => readFileSync(join(directory, "catalog.json"), "utf8");
  const seed = async (databases = true) => {
    await Effect.runPromise(
      secrets.withStored(original, (reference) =>
        updateCatalog(directory, (current) =>
          Effect.succeed({
            ...current,
            environments: {
              ...current.environments,
              local: {
                connections: { primary: { provider: "mongodb", secretRef: reference } },
                databases: databases
                  ? { accounts: { connection: "primary", database: "physical_accounts" } }
                  : {},
              },
            },
          })
        )
      )
    );
    const reference = (await catalog()).environments[envName]?.connections[connectionName]
      ?.secretRef;
    assert(reference);
    return reference;
  };
  return { directory, stored, secrets, hooks, removed, catalog, text, seed, writes: () => writes };
}

function input(answer: string | Error = replacement) {
  const prompts: Array<{ label: string; hidden: boolean }> = [];
  let output = "";
  const prompt: SetupPrompt = {
    color: false,
    async ask(label, options) {
      prompts.push({ label, hidden: options?.hidden ?? false });
      if (answer instanceof Error) throw answer;
      return answer;
    },
    write(message) {
      output += message;
    },
    async progress(_label, action) {
      return action(new AbortController().signal);
    },
  };
  return { prompt, prompts, output: () => output };
}

const inspect = async () => ({ ok: true as const });
const failure = <A,>(result: ManagementResult<A>, code: string) => {
  assert(!result.ok);
  assert.equal(result.error.code, code);
  assert(!JSON.stringify(result).includes("private-value"));
  assert(!JSON.stringify(result).includes("keyring:runnel/"));
};
const gate = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("alias lifecycle changes mappings only and leaves credentials and unrelated metadata alone", async (t) => {
  const f = fixture(t);
  await f.seed();
  const before = await f.catalog();
  assert.deepEqual(
    await addDatabase(f.directory, {
      ...target,
      alias: "events",
      database: "physical_events",
    }),
    {
      ok: true,
      data: { ...target, alias: "events", database: "physical_events" },
    }
  );
  assert.deepEqual(await renameDatabase(f.directory, { ...alias, to: "customers" }), {
    ok: true,
    data: { ...alias, to: "customers" },
  });
  const renamed = await f.catalog();
  assert.deepEqual(renamed.environments[envName]?.databases[customersAlias], {
    connection: "primary",
    database: "physical_accounts",
  });
  assert(!Object.hasOwn(renamed.environments[envName]?.databases ?? {}, "accounts"));
  assert.deepEqual(await removeDatabase(f.directory, { env: "local", alias: "customers" }), {
    ok: true,
    data: { env: "local", alias: "customers" },
  });
  const after = await f.catalog();
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(
    after.environments[envName]?.connections,
    before.environments[envName]?.connections
  );
  assert.deepEqual(after.environments[envName]?.databases, {
    events: { connection: "primary", database: "physical_events" },
  });
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.removed, []);
});

test("connection removal refuses aliases and deletes only its unused catalog registration", async (t) => {
  const f = fixture(t);
  const reference = await f.seed();
  const before = f.text();
  failure(await removeConnection(f.directory, target, f.secrets), "ConnectionInUse");
  assert.equal(f.text(), before);
  assert.equal(await Effect.runPromise(f.secrets.read(reference)), original);
  assert((await removeDatabase(f.directory, alias)).ok);
  assert.deepEqual(await removeConnection(f.directory, target, f.secrets), {
    ok: true,
    data: target,
  });
  assert.deepEqual((await f.catalog()).environments[envName], {
    connections: {},
    databases: {},
  });
  assert.equal(f.stored.size, 0);
  failure(await removeConnection(f.directory, target, f.secrets), "ConnectionNotFound");
});

test("rotation uses a hidden prompt, creates a new reference, preserves aliases and cleans the old secret", async (t) => {
  const f = fixture(t);
  const old = await f.seed();
  const before = await f.catalog();
  const io = input();
  const result = await rotateConnection(f.directory, target, io.prompt, {
    secrets: f.secrets,
    inspect: async (uri, signal) => {
      assert.equal(uri, replacement);
      assert(signal instanceof AbortSignal);
      assert.equal(f.writes(), 1);
      return inspect();
    },
  });
  assert.deepEqual(result, { ok: true, data: target });
  assert.equal(io.prompts.length, 1);
  assert(io.prompts.every(({ hidden }) => hidden));
  assert(!io.output().includes(replacement));
  assert(!JSON.stringify(result).includes("keyring:runnel/"));
  assert(!f.text().includes("private-value"));
  const after = await f.catalog();
  const current = after.environments[envName]?.connections[connectionName]?.secretRef;
  assert(current);
  assert.notEqual(current, old);
  assert.deepEqual(after.environments[envName]?.databases, before.environments[envName]?.databases);
  assert.equal(await Effect.runPromise(f.secrets.read(current)), replacement);
  assert.equal(f.stored.size, 1);
  assert.deepEqual(f.removed, [old.slice("keyring:runnel/".length)]);
});

test("shared secret references in other environments survive rotation and removal", async (t) => {
  for (const action of ["rotate", "remove"]) {
    const f = fixture(t);
    const reference = await f.seed(false);
    await Effect.runPromise(
      updateCatalog(f.directory, (catalog) =>
        Effect.succeed({
          ...catalog,
          environments: {
            ...catalog.environments,
            other: {
              connections: { shared: { provider: "mongodb", secretRef: reference } },
              databases: {},
            },
          },
        })
      )
    );
    const result =
      action === "rotate"
        ? await rotateConnection(f.directory, target, input().prompt, {
            secrets: f.secrets,
            inspect,
          })
        : await removeConnection(f.directory, target, f.secrets);
    assert(result.ok);
    assert.equal(await Effect.runPromise(f.secrets.read(reference)), original);
    assert.deepEqual(f.removed, []);
    assert.equal(f.stored.size, action === "rotate" ? 2 : 1);
  }
});

test("missing names and collisions fail without changing mappings or touching credentials", async (t) => {
  const f = fixture(t);
  await f.seed();
  const before = f.text();
  failure(
    await addDatabase(f.directory, { ...target, alias: "accounts", database: "another" }),
    "DatabaseNameConflict"
  );
  failure(await renameDatabase(f.directory, { ...alias, to: "accounts" }), "DatabaseNameConflict");
  failure(await removeDatabase(f.directory, { ...alias, alias: "missing" }), "DatabaseNotFound");
  failure(
    await renameDatabase(f.directory, { ...alias, alias: "missing", to: "next" }),
    "DatabaseNotFound"
  );
  failure(
    await addDatabase(f.directory, {
      ...target,
      connection: "missing",
      alias: "new",
      database: "physical",
    }),
    "ConnectionNotFound"
  );
  failure(
    await removeConnection(f.directory, { ...target, env: "missing" }, f.secrets),
    "EnvironmentNotFound"
  );
  failure(
    await rotateConnection(f.directory, { ...target, connection: "missing" }, input().prompt, {
      secrets: f.secrets,
      inspect,
    }),
    "ConnectionNotFound"
  );
  assert.equal(f.text(), before);
  assert.equal(f.writes(), 1);
  assert.equal(f.removed.length, 0);
});

test("management rejects reserved names and oversized database names", async (t) => {
  const f = fixture(t);
  await f.seed();
  const before = f.text();
  const bad = "__proto__";
  failure(
    await addDatabase(f.directory, { ...target, alias: bad, database: "physical" }),
    "ManagementInvalid"
  );
  failure(await renameDatabase(f.directory, { ...alias, to: bad }), "ManagementInvalid");
  failure(await removeDatabase(f.directory, { ...alias, alias: bad }), "ManagementInvalid");
  failure(
    await removeConnection(f.directory, { ...target, connection: bad }, f.secrets),
    "ManagementInvalid"
  );
  failure(
    await rotateConnection(f.directory, { ...target, env: bad }, input().prompt, {
      secrets: f.secrets,
      inspect,
    }),
    "ManagementInvalid"
  );
  const database = "é".repeat(32);
  failure(
    await addDatabase(f.directory, { ...target, alias: "new", database }),
    "ManagementInvalid"
  );
  assert.equal(f.text(), before);
  assert.equal(f.writes(), 1);
});

test("inherited property names are looked up as own properties and can be real aliases", async (t) => {
  const f = fixture(t);
  await f.seed(false);
  const name = "toString";
  failure(await removeDatabase(f.directory, { env: "local", alias: name }), "DatabaseNotFound");
  failure(
    await removeConnection(f.directory, { env: "local", connection: name }, f.secrets),
    "ConnectionNotFound"
  );
  failure(await removeDatabase(f.directory, { env: name, alias: "x" }), "EnvironmentNotFound");
  assert((await addDatabase(f.directory, { ...target, alias: name, database: "physical" })).ok);
  assert(Object.hasOwn((await f.catalog()).environments[envName]?.databases ?? {}, name));
  assert((await removeDatabase(f.directory, { env: "local", alias: name })).ok);
});

test("cancelled, invalid and rejected rotation input leaves the original credential intact", async (t) => {
  const f = fixture(t);
  await f.seed();
  const before = f.text();
  for (const code of ["SetupCancelled", "SetupInputTooLong", "SetupTerminalRequired"] as const) {
    failure(
      await rotateConnection(f.directory, target, input(new PromptError(code)).prompt, {
        secrets: f.secrets,
        inspect,
      }),
      code
    );
  }
  for (const uri of ["", "x".repeat(16385)]) {
    failure(
      await rotateConnection(f.directory, target, input(uri).prompt, {
        secrets: f.secrets,
        inspect,
      }),
      "SecretInvalid"
    );
  }
  for (const code of [
    "AuthenticationFailed",
    "ConnectionInvalid",
    "DatabaseUnavailable",
    "DatabaseTimedOut",
    "UnknownFailure",
  ]) {
    failure(
      await rotateConnection(f.directory, target, input().prompt, {
        secrets: f.secrets,
        inspect: async () => ({ ok: false, error: { code, message: replacement } }),
      }),
      code === "UnknownFailure" ? "InspectionFailed" : code
    );
  }
  failure(
    await rotateConnection(f.directory, target, input().prompt, {
      secrets: f.secrets,
      inspect: async () => {
        throw new Error(replacement);
      },
    }),
    "ManagementUnavailable"
  );
  assert.equal(f.text(), before);
  assert.equal(f.writes(), 1);
  assert.equal(f.stored.size, 1);
});

test("rotation supports a database user without discovery permission", async (t) => {
  const f = fixture(t);
  await f.seed();
  const result = await rotateConnection(f.directory, target, input().prompt, {
    secrets: f.secrets,
    inspect: async () => ({ ok: false, error: { code: "PermissionDenied", message: "Denied" } }),
  });
  assert.deepEqual(result, { ok: true, data: target });
  assert.deepEqual([...f.stored.values()], [replacement]);
});

test("failed catalog commit rolls back the newly stored secret only", async (t) => {
  const f = fixture(t);
  const old = await f.seed();
  const result = await rotateConnection(f.directory, target, input().prompt, {
    secrets: f.secrets,
    inspect: async () => {
      writeFileSync(join(f.directory, "catalog.json"), "{broken");
      return inspect();
    },
  });
  failure(result, "CatalogInvalid");
  assert.equal(f.text(), "{broken");
  assert.equal(f.writes(), 2);
  assert.equal(f.stored.size, 1);
  assert.equal(await Effect.runPromise(f.secrets.read(old)), original);
});

test("postcommit credential cleanup failures report success and a warning without deleting the live new secret", async (t) => {
  for (const action of ["rotate", "remove"]) {
    const f = fixture(t);
    await f.seed(false);
    f.hooks.remove = async () => {
      throw new Error(replacement);
    };
    const result =
      action === "rotate"
        ? await rotateConnection(f.directory, target, input().prompt, {
            secrets: f.secrets,
            inspect,
          })
        : await removeConnection(f.directory, target, f.secrets);
    assert(result.ok);
    assert.equal(result.warning?.code, "SecretCleanupFailed");
    assert(!JSON.stringify(result).includes("private-value"));
    assert(!JSON.stringify(result).includes("keyring:runnel/"));
    const connection = (await f.catalog()).environments[envName]?.connections[connectionName];
    if (action === "rotate") {
      assert(connection);
      assert.equal(await Effect.runPromise(f.secrets.read(connection.secretRef)), replacement);
      assert.equal(f.stored.size, 2);
    } else {
      assert.equal(connection, undefined);
      assert.equal(f.stored.size, 1);
    }
  }
});

test("two rotations sharing a snapshot cannot overwrite each other and the loser rolls back its secret", async (t) => {
  const f = fixture(t);
  await f.seed();
  const waiting = gate();
  const proceed = gate();
  const stale = rotateConnection(
    f.directory,
    target,
    input("mongodb://stale-private-value@example.invalid").prompt,
    {
      secrets: f.secrets,
      inspect: async () => {
        waiting.resolve();
        await proceed.promise;
        return inspect();
      },
    }
  );
  await waiting.promise;
  assert(
    (await rotateConnection(f.directory, target, input().prompt, { secrets: f.secrets, inspect }))
      .ok
  );
  proceed.resolve();
  failure(await stale, "ConnectionChanged");
  assert.deepEqual([...f.stored.values()], [replacement]);
  const current = (await f.catalog()).environments[envName]?.connections[connectionName]?.secretRef;
  assert(current);
  assert.equal(await Effect.runPromise(f.secrets.read(current)), replacement);
});

test("removal while rotation waits for a vault write cannot be undone by the stale commit", async (t) => {
  const f = fixture(t);
  await f.seed(false);
  const waiting = gate();
  const proceed = gate();
  f.hooks.set = async () => {
    waiting.resolve();
    await proceed.promise;
  };
  const rotation = rotateConnection(f.directory, target, input().prompt, {
    secrets: f.secrets,
    inspect,
  });
  await waiting.promise;
  assert((await removeConnection(f.directory, target, f.secrets)).ok);
  proceed.resolve();
  failure(await rotation, "ConnectionNotFound");
  assert.deepEqual((await f.catalog()).environments[envName]?.connections, {});
  assert.equal(f.stored.size, 0);
});

test("adding an alias concurrently with connection removal never leaves a dangling mapping", async (t) => {
  const f = fixture(t);
  await f.seed(false);
  const [added, removed] = await Promise.all([
    addDatabase(f.directory, { ...target, alias: "new", database: "physical" }),
    removeConnection(f.directory, target, f.secrets),
  ]);
  const current = (await f.catalog()).environments[envName];
  if (added.ok) {
    failure(removed, "ConnectionInUse");
    assert(current?.connections[connectionName]);
    assert.equal(f.stored.size, 1);
  } else {
    failure(added, "ConnectionNotFound");
    assert(removed.ok);
    assert.deepEqual(current?.databases, {});
    assert.equal(f.stored.size, 0);
  }
});

test("rotation preserves aliases added after the interactive snapshot", async (t) => {
  const f = fixture(t);
  await f.seed();
  const result = await rotateConnection(f.directory, target, input().prompt, {
    secrets: f.secrets,
    inspect: async () => {
      assert(
        (await addDatabase(f.directory, { ...target, alias: "new", database: "physical" })).ok
      );
      return inspect();
    },
  });
  assert(result.ok);
  assert.deepEqual(Object.keys((await f.catalog()).environments[envName]?.databases ?? {}).sort(), [
    "accounts",
    "new",
  ]);
});

test("credential deletion holds the catalog writer lock through its reference check and vault deletion", async (t) => {
  const f = fixture(t);
  await f.seed(false);
  const entered = gate();
  const proceed = gate();
  f.hooks.remove = async () => {
    entered.resolve();
    await proceed.promise;
  };
  const removal = removeConnection(f.directory, target, f.secrets);
  await entered.promise;
  let writerEntered = false;
  const writer = Effect.runPromise(
    updateCatalog(f.directory, (catalog) => {
      writerEntered = true;
      return Effect.succeed(catalog);
    })
  );
  // Give the independent writer a chance to acquire the OS lock while deletion is paused.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(writerEntered, false);
  proceed.resolve();
  assert((await removal).ok);
  await writer;
  assert.equal(writerEntered, true);
});

test("default selection validates connections and removal clears it without promoting another", async (t) => {
  const { defaultConnection } = await import("../dist/management.js");
  const { registerConnection } = await import("../dist/setup.js");
  const f = fixture(t);
  await f.seed(false);
  failure(
    await defaultConnection(f.directory, { env: "local", connection: "missing" }),
    "ConnectionNotFound"
  );
  assert((await defaultConnection(f.directory, target)).ok);
  await Effect.runPromise(
    registerConnection(
      f.directory,
      {
        env: "local",
        connection: "other",
        uri: "mongodb://synthetic.invalid",
        aliases: [],
      },
      f.secrets
    )
  );
  assert.equal((await f.catalog()).environments[envName]?.defaultConnection, "primary");
  assert((await removeConnection(f.directory, target, f.secrets)).ok);
  const env = (await f.catalog()).environments[envName];
  assert.equal(env?.defaultConnection, undefined);
  assert.deepEqual(Object.keys(env?.connections ?? {}), ["other"]);
});

test("rotation updates or clears URI database metadata and preserves default selection", async (t) => {
  const { registerConnection } = await import("../dist/setup.js");
  const f = fixture(t);
  await Effect.runPromise(
    registerConnection(
      f.directory,
      {
        ...target,
        uri: `${original}/old_database`,
        makeDefault: true,
        aliases: [],
      },
      f.secrets
    )
  );
  for (const [uri, database] of [
    [`${replacement}/new_database?authSource=auth`, "new_database"],
    [replacement, undefined],
  ] as const) {
    assert(
      (
        await rotateConnection(f.directory, target, input(uri).prompt, {
          secrets: f.secrets,
          inspect,
        })
      ).ok
    );
    const env = (await f.catalog()).environments[envName];
    assert.equal(env?.defaultConnection, "primary");
    assert.equal(env?.connections[connectionName]?.defaultDatabase, database);
  }
});

test("shared registration and credential replacement return only redacted results and preserve metadata", async (t) => {
  const { registerEnvironment } = await import("../dist/setup.js");
  const { replaceConnectionCredential } = await import("../dist/management.js");
  const f = fixture(t);
  const registered = await Effect.runPromise(
    registerEnvironment(f.directory, { env: "local", uri: original }, f.secrets)
  );
  assert.deepEqual(registered, { env: "local", connection: "primary", databases: [] });
  const result = await replaceConnectionCredential(
    f.directory,
    { ...target, uri: replacement },
    {
      secrets: f.secrets,
      inspect,
    }
  );
  assert.deepEqual(result, { ok: true, data: target });
  assert.doesNotMatch(JSON.stringify(result), /private-value|keyring|secretRef|mongodb:/);
  assert.equal((await f.catalog()).environments[envName]?.defaultConnection, "primary");
  assert.equal(f.stored.size, 1);
  assert.deepEqual([...f.stored.values()], [replacement]);
});

test("shared credential replacement observes cancellation before storing a secret", async (t) => {
  const { replaceConnectionCredential } = await import("../dist/management.js");
  const f = fixture(t);
  await f.seed();
  const before = f.text();
  const controller = new AbortController();
  const result = await replaceConnectionCredential(
    f.directory,
    { ...target, uri: replacement },
    {
      secrets: f.secrets,
      signal: controller.signal,
      inspect: async (_uri, signal) => {
        assert.equal(signal, controller.signal);
        controller.abort();
        return { ok: true };
      },
    }
  );
  failure(result, "OperationCancelled");
  assert.equal(f.text(), before);
  assert.deepEqual([...f.stored.values()], [original]);
});

test("registered inspection passes names only and does not start work for unknown connections", async (t) => {
  const { inspectConnection } = await import("../dist/management.js");
  const f = fixture(t);
  await f.seed();
  let requests = 0;
  const execute: typeof import("../dist/daemon-client.js").executeWithDaemon = async (
    _directory,
    input
  ) => {
    requests++;
    assert.deepEqual(input, { operation: "inspectConnection", ...target, testOnly: true });
    return { ok: true, data: { databases: [], truncated: false } };
  };
  assert.deepEqual(await inspectConnection(f.directory, target, false, undefined, execute), {
    ok: true,
    data: { databases: [], truncated: false },
  });
  failure(
    await inspectConnection(
      f.directory,
      { ...target, connection: "missing" },
      false,
      undefined,
      execute
    ),
    "ConnectionNotFound"
  );
  assert.equal(requests, 1);
  assert.equal(f.writes(), 1);
});
