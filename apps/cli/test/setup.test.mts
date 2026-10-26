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
import { type Registration, registerConnection, setup } from "../dist/setup.js";
import { PromptError, type SetupPrompt, terminalPrompt } from "../dist/setup-prompt.js";

const envName = "local";
const connName = "primary";
const otherEnv = "other";

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
    color: false,
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
    async progress(_label, action) {
      return action(new AbortController().signal);
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

test("setup --env needs exactly one hidden URI prompt and no inspection or aliases", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const io = input([`${uri}/accounts?authSource=admin`]);
  const result = await setup(
    f.directory,
    io.prompt,
    {
      inspect: async () => {
        throw new Error("Saving must not inspect or enumerate");
      },
      secrets: f.secrets,
    },
    { env: "local" }
  );
  assert.deepEqual(result, {
    ok: true,
    data: { env: "local", connection: "primary", databases: [] },
  });
  assert.deepEqual(io.prompts, [{ label: "MongoDB connection URI (hidden)", hidden: true }]);
  assert.equal(io.remaining(), 0);
  assert.equal(f.writes(), 1);
  const catalog = await Effect.runPromise(readCatalog(f.directory));
  const env = catalog.environments[envName];
  assert.equal(catalog.schemaVersion, 2);
  assert.equal(env?.defaultConnection, "primary");
  assert.equal(env?.connections[connName]?.defaultDatabase, "accounts");
  assert.deepEqual(env?.databases, {});
  const ref = env?.connections[connName]?.secretRef;
  assert(ref);
  assert.equal(await Effect.runPromise(f.secrets.read(ref)), `${uri}/accounts?authSource=admin`);
  assert.doesNotMatch(
    readFileSync(join(f.directory, "catalog.json"), "utf8") + io.output() + JSON.stringify(result),
    /synthetic-private-value|mongodb:\/\//
  );
});

test("bare setup asks only an environment and hidden URI, with literal numeric names", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const io = input(["__proto__", "123", `${uri}/?authSource=admin`]);
  const result = await setup(f.directory, io.prompt, { secrets: f.secrets });
  assert(result.ok);
  assert.equal(result.data.env, "123");
  assert.equal(io.prompts.length, 3);
  const env = (await Effect.runPromise(readCatalog(f.directory))).environments["123"];
  assert.equal(env?.connections[connName]?.defaultDatabase, undefined);
  assert.deepEqual(env?.databases, {});
});

test("advanced setup preserves aliases and default unless explicitly selecting a new default", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  await Effect.runPromise(registerConnection(f.directory, registration, f.secrets));
  for (const [connection, makeDefault] of [
    ["other", false],
    ["reporting", true],
  ] as const) {
    const io = input([uri]);
    assert(
      (
        await setup(
          f.directory,
          io.prompt,
          { secrets: f.secrets },
          { env: "local", connection, makeDefault }
        )
      ).ok
    );
    assert.equal(io.prompts.length, 1);
    const env = (await Effect.runPromise(readCatalog(f.directory))).environments[envName];
    assert.deepEqual(env?.databases, {
      accounts: { connection: "primary", database: "physical_accounts" },
    });
    assert.equal(env?.defaultConnection, makeDefault ? connection : undefined);
  }
  assert.equal(f.stored.size, 3);
});

test("existing environment fails before hidden input with rotation guidance", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  await Effect.runPromise(registerConnection(f.directory, registration, f.secrets));
  const before = readFileSync(join(f.directory, "catalog.json"), "utf8");
  const io = input([]);
  const result = await setup(f.directory, io.prompt, { secrets: f.secrets }, { env: "local" });
  assert(!result.ok);
  assert.equal(result.error.code, "SetupNameConflict");
  assert.match(result.error.message, /connection rotate/);
  assert.equal(io.prompts.length, 0);
  assert.equal(f.writes(), 1);
  assert.equal(readFileSync(join(f.directory, "catalog.json"), "utf8"), before);
});

test("registration validates all names and aliases before touching credentials", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  for (const bad of [
    { ...registration, env: "__proto__" },
    { ...registration, connection: "constructor" },
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

test("registration refuses an alias owned by another connection and rolls back its new secret", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  await Effect.runPromise(registerConnection(f.directory, registration, f.secrets));
  const before = readFileSync(join(f.directory, "catalog.json"), "utf8");
  const result = await Effect.runPromise(
    registerConnection(f.directory, { ...registration, connection: "different" }, f.secrets).pipe(
      Effect.result
    )
  );
  assert(Result.isFailure(result));
  assert.equal(result.failure.code, "SetupNameConflict");
  assert.equal(f.stored.size, 1);
  assert.equal(readFileSync(join(f.directory, "catalog.json"), "utf8"), before);
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

test("setup rechecks concurrent registration under the catalog lock and removes its new secret", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const io = input([uri]);
  const result = await setup(
    f.directory,
    io.prompt,
    {
      inspect: async () => {
        await Effect.runPromise(registerConnection(f.directory, registration, f.secrets));
        return inspect();
      },
      secrets: f.secrets,
    },
    { env: "local", test: true }
  );
  assert(!result.ok);
  assert.equal(result.error.code, "SetupNameConflict");
  assert.equal(f.stored.size, 1);
});

test("catalog commit failure removes the new credential and preserves the file", async (t) => {
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const result = await setup(
    f.directory,
    input([uri]).prompt,
    {
      inspect: async () => {
        writeFileSync(join(f.directory, "catalog.json"), "{broken");
        return inspect();
      },
      secrets: f.secrets,
    },
    { env: "local", test: true }
  );
  assert(!result.ok);
  assert.equal(result.error.code, "CatalogInvalid");
  assert.equal(f.writes(), 1);
  assert.equal(f.stored.size, 0);
  assert.equal(readFileSync(join(f.directory, "catalog.json"), "utf8"), "{broken");
  assert(!JSON.stringify(result).includes(uri));
});

test("cancellation and invalid names/URI/catalogs never store credentials or call inspection", async (t) => {
  for (const answer of [
    new PromptError("SetupCancelled"),
    "",
    "x".repeat(16385),
    "https://example.invalid",
    `${uri}/bad.name`,
    `${uri}/%ZZ`,
    "mongodb://host.invalid:bogus/accounts",
    "mongodb://host.invalid:99999/accounts",
    "mongodb://host.invalid:0/accounts",
  ]) {
    const f = fixture();
    t.after(() => rmSync(f.directory, { recursive: true, force: true }));
    const result = await setup(
      f.directory,
      input([answer]).prompt,
      {
        inspect: async () => {
          throw new Error("Must not inspect");
        },
        secrets: f.secrets,
      },
      { env: "local" }
    );
    assert(!result.ok);
    assert.equal(f.writes(), 0);
    assert(!existsSync(join(f.directory, "catalog.json")));
  }
  const f = fixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const invalidName = await setup(
    f.directory,
    input([]).prompt,
    { secrets: f.secrets },
    { env: "bad.name" }
  );
  assert(!invalidName.ok && invalidName.error.code === "SetupInvalid");
  writeFileSync(join(f.directory, "catalog.json"), "{");
  const invalid = await setup(f.directory, input([]).prompt, { secrets: f.secrets });
  assert(!invalid.ok && invalid.error.code === "CatalogInvalid");
  assert.equal(f.writes(), 0);
});

test("live testing is opt-in, cancellable, and a failed test leaves registration unchanged", async (t) => {
  for (const code of ["PermissionDenied", "AuthenticationFailed", "DatabaseTimedOut"]) {
    const f = fixture();
    t.after(() => rmSync(f.directory, { recursive: true, force: true }));
    let tested = false;
    const result = await setup(
      f.directory,
      input([uri]).prompt,
      {
        inspect: async (value, signal) => {
          assert.equal(value, uri);
          assert(signal);
          tested = true;
          return { ok: false, error: { code, message: "Synthetic test failure." } };
        },
        secrets: f.secrets,
      },
      { env: "local", test: true }
    );
    assert(tested);
    assert(!result.ok && result.error.code === code);
    assert.equal(f.writes(), 0);
    assert(!existsSync(join(f.directory, "catalog.json")));
  }
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

test("setup progress aborts its action on Ctrl+C", async () => {
  const io = terminal();
  let aborted = false;
  const running = terminalPrompt(io.input, io.output).progress("Checking connection…", (signal) => {
    signal.addEventListener("abort", () => {
      aborted = true;
    });
    return new Promise<string>(() => {});
  });
  process.emit("SIGINT");
  await assert.rejects(
    running,
    (error: unknown) => error instanceof PromptError && error.code === "SetupCancelled"
  );
  assert.equal(aborted, true);
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
