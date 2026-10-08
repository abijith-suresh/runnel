import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { readCatalog } from "../dist/catalog.js";
import { credentialStore } from "../dist/secrets.js";
import { PromptError, type SetupPrompt, terminalPrompt } from "../dist/setup-prompt.js";
import { type Registration, registerConnection, setup } from "../dist/setup.js";

const envName = "local";
const connName = "primary";
const aliasName = "accounts";
const otherEnv = "other";
const secondAlias = "second";
const newAlias = "new_accounts";

const uri = "mongodb://synthetic-user:synthetic-private-value@example.invalid";
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), "runnel-setup-"));
  const stored = new Map<string, string>();
  let writes = 0;
  const secrets = credentialStore(async (id) => ({
    async setPassword(value) {
      writes++;
      stored.set(id, value);
    },
    async getPassword() {
      return stored.get(id);
    },
    async deleteCredential() {
      return stored.delete(id);
    },
  }));
  return { directory, stored, secrets, writes: () => writes };
};
const input = (answers: Array<string | Error>) => {
  const prompts: Array<{ label: string; hidden: boolean }> = [];
  let output = "";
  const prompt: SetupPrompt = {
    async ask(label, options = {}) {
      prompts.push({ label, hidden: options.hidden ?? false });
      const answer = answers.shift();
      assert.notEqual(answer, undefined, `Unexpected prompt: ${label}`);
      if (answer instanceof Error) throw answer;
      return answer === "" ? (options.defaultValue ?? "") : (answer ?? "");
    },
    write(message) {
      output += message;
    },
  };
  return { prompt, prompts, output: () => output, remaining: () => answers.length };
};
const inspect = async () => ({
  ok: true as const,
  data: { databases: ["physical_accounts", "physical_events"], truncated: false },
});
const registration: Registration = {
  env: "local",
  connection: "primary",
  uri,
  aliases: [{ name: "accounts", database: "physical_accounts" }],
};

test("setup hides URI input, selects and names multiple databases, and stores only a reference", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const io = input(["local", "", uri, "1", "accounts", "2", "events", "", "y"]);
  const result = await setup(f.directory, io.prompt, {
    inspect: async (value) => {
      assert.equal(value, uri);
      assert.equal(f.writes(), 0);
      return inspect();
    },
    secrets: f.secrets,
  });
  assert.deepEqual(result, {
    ok: true,
    data: { env: "local", connection: "primary", databases: ["accounts", "events"] },
  });
  assert.equal(io.remaining(), 0);
  assert.deepEqual(
    io.prompts.filter(({ hidden }) => hidden).map(({ label }) => label),
    ["MongoDB URI (hidden)"]
  );
  assert(!io.output().includes(uri));
  assert.equal(f.writes(), 1);
  const catalog = await Effect.runPromise(readCatalog(f.directory));
  const ref = catalog.environments[envName]?.connections[connName]?.secretRef;
  assert(ref);
  assert.equal(await Effect.runPromise(f.secrets.read(ref)), uri);
  assert.deepEqual(catalog.environments[envName]?.databases, {
    accounts: { connection: "primary", database: "physical_accounts" },
    events: { connection: "primary", database: "physical_events" },
  });
  const persisted = readFileSync(join(f.directory, "catalog.json"), "utf8");
  assert(!persisted.includes(uri));
  assert(!persisted.includes("synthetic-private-value"));
  assert(!JSON.stringify(result).includes(ref));
});

test("permission-limited discovery permits manual names, including numeric database names", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const io = input(["local", "primary", uri, "m", "123", "accounts", "", "yes"]);
  const result = await setup(f.directory, io.prompt, {
    inspect: async () => ({
      ok: false,
      error: { code: "PermissionDenied", message: "No listing permission." },
    }),
    secrets: f.secrets,
  });
  assert(result.ok);
  assert.match(io.output(), /cannot list databases/);
  assert.equal(
    (await Effect.runPromise(readCatalog(f.directory))).environments[envName]?.databases[aliasName]
      ?.database,
    "123"
  );
});

test("empty and truncated discovery retain manual selection and expose truncation", async (t) => {
  for (const databases of [[], ["physical_accounts"]]) {
    const f = fixture();
    t.after(() => rmSync(f.directory, { recursive: true, force: true }));
    const io = input(["local", "primary", uri, "", "manual_database", "accounts", "", "y"]);
    const result = await setup(f.directory, io.prompt, {
      inspect: async () => ({ ok: true, data: { databases, truncated: true } }),
      secrets: f.secrets,
    });
    assert(result.ok);
    assert.match(io.output(), /truncated/);
    assert.match(io.output(), /at least one database/);
  }
});

test("setup rejects bad names and existing aliases without overwriting them", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  await Effect.runPromise(registerConnection(f.directory, registration, f.secrets));
  const io = input([
    "__proto__",
    "local",
    "primary",
    "other",
    uri,
    "99",
    "bad.name",
    "1",
    "accounts",
    "new_accounts",
    "1",
    "new_accounts",
    "second",
    "",
    "y",
  ]);
  const result = await setup(f.directory, io.prompt, { inspect, secrets: f.secrets });
  assert(result.ok);
  assert.equal(io.remaining(), 0);
  const env = (await Effect.runPromise(readCatalog(f.directory))).environments[envName];
  assert.equal(env?.databases[aliasName]?.connection, "primary");
  assert.equal(env?.databases[newAlias]?.connection, "other");
  assert.equal(env?.databases[secondAlias]?.connection, "other");
  assert.equal(Object.keys(env?.connections ?? {}).length, 2);
});

test("allowed inherited-property names work as new environment, connection and alias names", async (t) => {
  for (const name of ["toString", "valueOf", "hasOwnProperty"]) {
    const f = fixture();
    t.after(() => rmSync(f.directory, { recursive: true, force: true }));
    const io = input([name, name, uri, "1", name, "", "y"]);
    const result = await setup(f.directory, io.prompt, { inspect, secrets: f.secrets });
    assert(result.ok);
    const catalog = await Effect.runPromise(readCatalog(f.directory));
    assert(Object.hasOwn(catalog.environments, name));
    assert(Object.hasOwn(catalog.environments[name]?.connections ?? {}, name));
    assert(Object.hasOwn(catalog.environments[name]?.databases ?? {}, name));
  }
});

test("registration validates all names and aliases before touching credentials", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  for (const bad of [
    { ...registration, env: "__proto__" },
    { ...registration, connection: "constructor" },
    { ...registration, aliases: [] },
    { ...registration, aliases: [...registration.aliases, ...registration.aliases] },
    { ...registration, aliases: [{ name: "bad.name", database: "okay" }] },
    { ...registration, aliases: [{ name: "okay", database: "bad.name" }] },
  ]) {
    const result = await Effect.runPromise(
      registerConnection(f.directory, bad, f.secrets).pipe(Effect.result)
    );
    assert(Result.isFailure(result));
    assert.equal(result.failure.code, "SetupInvalid");
  }
  assert.equal(f.writes(), 0);
  assert(!existsSync(join(f.directory, "catalog.json")));
});

test("concurrent connection and alias conflicts clean the new secret and preserve existing catalog", async (t) => {
  for (const connection of ["primary", "different"]) {
    const f = fixture();
    t.after(() => rmSync(f.directory, { recursive: true, force: true }));
    await Effect.runPromise(registerConnection(f.directory, registration, f.secrets));
    const before = readFileSync(join(f.directory, "catalog.json"), "utf8");
    const result = await Effect.runPromise(
      registerConnection(f.directory, { ...registration, connection }, f.secrets).pipe(
        Effect.result
      )
    );
    assert(Result.isFailure(result));
    assert.equal(result.failure.code, "SetupNameConflict");
    assert.equal(f.stored.size, 1);
    assert.equal(readFileSync(join(f.directory, "catalog.json"), "utf8"), before);
  }
});

test("same URI registered in another environment has an independent credential and keeps unrelated mappings", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  await Effect.runPromise(registerConnection(f.directory, registration, f.secrets));
  await Effect.runPromise(
    registerConnection(f.directory, { ...registration, env: "other" }, f.secrets)
  );
  const catalog = await Effect.runPromise(readCatalog(f.directory));
  assert.notEqual(
    catalog.environments[envName]?.connections[connName]?.secretRef,
    catalog.environments[otherEnv]?.connections[connName]?.secretRef
  );
  assert.equal(f.stored.size, 2);
  assert.deepEqual(
    catalog.environments[envName]?.databases,
    catalog.environments[otherEnv]?.databases
  );
});

test("setup rechecks conflicts that appeared during input collection under the catalog lock", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const io = input(["local", "primary", uri, "1", "accounts", "", "y"]);
  const result = await setup(f.directory, io.prompt, {
    inspect: async () => {
      await Effect.runPromise(registerConnection(f.directory, registration, f.secrets));
      return inspect();
    },
    secrets: f.secrets,
  });
  assert(!result.ok);
  assert.equal(result.error.code, "SetupNameConflict");
  assert.equal(f.stored.size, 1);
});

test("catalog commit failure after input removes the new credential and preserves the file", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const io = input(["local", "primary", uri, "1", "accounts", "", "y"]);
  const result = await setup(f.directory, io.prompt, {
    inspect: async () => {
      writeFileSync(join(f.directory, "catalog.json"), "{broken");
      return inspect();
    },
    secrets: f.secrets,
  });
  assert(!result.ok);
  assert.equal(result.error.code, "CatalogInvalid");
  assert.equal(f.writes(), 1);
  assert.equal(f.stored.size, 0);
  assert.equal(readFileSync(join(f.directory, "catalog.json"), "utf8"), "{broken");
  assert(!JSON.stringify(result).includes(uri));
});

test("cancellation, failed inspection, empty URI and invalid catalogs never store credentials", async (t) => {
  const cases = [
    input(["local", "primary", new PromptError("SetupCancelled")]),
    input(["local", "primary", uri, "1", "accounts", "", "n"]),
    input(["local", "primary", ""]),
  ];
  for (const io of cases) {
    const f = fixture();
    t.after(() => rmSync(f.directory, { recursive: true, force: true }));
    const result = await setup(f.directory, io.prompt, { inspect, secrets: f.secrets });
    assert(!result.ok);
    assert.equal(f.writes(), 0);
    assert(!existsSync(join(f.directory, "catalog.json")));
  }
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const failed = await setup(f.directory, input(["local", "primary", uri]).prompt, {
    inspect: async () => ({
      ok: false,
      error: { code: "AuthenticationFailed", message: "Rejected credentials." },
    }),
    secrets: f.secrets,
  });
  assert(!failed.ok);
  assert.equal(failed.error.code, "AuthenticationFailed");
  assert.equal(f.writes(), 0);
  writeFileSync(join(f.directory, "catalog.json"), "{");
  const invalid = await setup(f.directory, input([]).prompt, { inspect, secrets: f.secrets });
  assert(!invalid.ok);
  assert.equal(invalid.error.code, "CatalogInvalid");
  assert.equal(f.writes(), 0);
});

const terminal = () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true,
    isRaw: false,
    setRawMode(value: boolean) {
      this.isRaw = value;
      return this;
    },
  });
  let written = "";
  const output = Object.assign(
    new Writable({
      write(chunk, _encoding, done) {
        written += chunk.toString();
        done();
      },
    }),
    { isTTY: true }
  );
  return { input, output, written: () => written };
};

test("hidden terminal input suppresses typed characters, supports editing, and restores raw mode", async () => {
  const io = terminal();
  const prompt = terminalPrompt(io.input, io.output);
  const answer = prompt.ask("URI", { hidden: true });
  io.input.write("secret-valuX");
  io.input.write("\u007f");
  io.input.write("e\r");
  assert.equal(await answer, "secret-value");
  assert.equal(io.written(), "URI: \n");
  assert.equal(io.input.isRaw, false);
  const named = prompt.ask("Name", { defaultValue: "primary" });
  io.input.write("\r");
  assert.equal(await named, "primary");
});

test("terminal cancellation, EOF and oversized input restore raw mode without hidden echo", async () => {
  for (const value of ["\u0003", "\u0004", "x".repeat(16385)]) {
    const io = terminal();
    const answer = terminalPrompt(io.input, io.output).ask("URI", { hidden: true });
    io.input.write(value);
    await assert.rejects(answer, (error: unknown) => error instanceof PromptError);
    assert.equal(io.input.isRaw, false);
    assert.equal(io.written(), "URI: \n");
  }
});

test("terminal stream errors reject safely and restore raw mode without revealing input", async () => {
  for (const source of ["input", "output"] as const) {
    const io = terminal();
    const answer = terminalPrompt(io.input, io.output).ask("URI", { hidden: true });
    io.input.write("synthetic-secret");
    io[source].emit("error", new Error("synthetic-secret-bearing-error"));
    await assert.rejects(
      answer,
      (error: unknown) => error instanceof PromptError && error.code === "SetupCancelled"
    );
    assert.equal(io.input.isRaw, false);
    assert.equal(io.written(), "URI: \n");
  }
});

test("setup refuses piped input and credential flags without creating any configuration", (t) => {
  const parent = mkdtempSync(join(tmpdir(), "runnel-setup-cli-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const home = join(parent, "absent");
  const executable = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [executable, "setup"], {
    env: { ...process.env, RUNNEL_HOME: home },
    input: uri,
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).error.code, "SetupTerminalRequired");
  assert(!result.stdout.includes(uri));
  assert(!existsSync(home));
});
