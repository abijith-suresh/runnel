import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import * as Effect from "effect/Effect";
import { readCatalog } from "../dist/catalog.js";
import { daemonCommand } from "../dist/daemon-client.js";
import { startDaemon } from "../dist/daemon-server.js";
import { credentialStore } from "../dist/secrets.js";
import { setSettings } from "../dist/settings.js";
import { type ManagerOptions, startManager } from "../dist/ui-server.js";

const syntheticUri = "mongodb://fixture-user:fixture-password@owned-fixture.invalid/accounts";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}
async function fixture(t: TestContext, options: ManagerOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "runnel-manager-"));
  const values = new Map<string, string>(),
    calls = { reads: 0, writes: 0, removes: 0 };
  const secrets = credentialStore(async (key) => ({
    async setPassword(value) {
      calls.writes++;
      values.set(key, value);
    },
    async getPassword() {
      calls.reads++;
      return values.get(key);
    },
    async deleteCredential() {
      calls.removes++;
      return values.delete(key);
    },
  }));
  const manager = await startManager(home, { secrets, ...options });
  t.after(async () => {
    await manager.stop();
    await rm(home, { recursive: true, force: true });
  });
  const pairing = () => new URL(manager.pairingUrl()).hash.slice(6);
  const send = (path: string, init: RequestInit = {}, token?: string) =>
    fetch(manager.origin + path, {
      ...init,
      headers: {
        Origin: manager.origin,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  const session = async () => {
    const response = await send("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing() }),
    });
    assert.equal(response.status, 200);
    return ((await response.json()) as { token: string }).token;
  };
  const configuration = async (token: string) => {
    const r = await send("/api/configuration", {}, token);
    assert.equal(r.status, 200);
    return (await r.json()) as {
      revision: string;
      environments: unknown[];
      settings: { idleTimeoutMs: number; historyEnabled: boolean };
    };
  };
  const operation = async (token: string, input: unknown) =>
    send(
      "/api/operation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
      token
    );
  return {
    home,
    values,
    calls,
    manager,
    secrets,
    pairing,
    send,
    session,
    configuration,
    operation,
  };
}

test("manager pairs independently once; catalog/settings/status and bundled shell stay offline and redacted", async (t) => {
  const f = await fixture(t),
    code = f.pairing();
  const page = await f.send("/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/);
  assert.equal(page.headers.get("access-control-allow-origin"), null);
  assert.match(page.headers.get("content-security-policy")!, /default-src 'none'/);
  assert.doesNotMatch(page.headers.get("content-security-policy")!, /unsafe-|\*/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const token = await f.session();
  const used = await f.send("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  assert.equal(used.status, 401); // issuing a new link invalidated the earlier one
  const current = await f.configuration(token);
  assert.deepEqual(current.environments, []);
  assert.equal(current.settings.idleTimeoutMs, 300000);
  const status = await f.send("/api/status", {}, token);
  assert.deepEqual(await status.json(), { running: false });
  assert.deepEqual(f.calls, { reads: 0, writes: 0, removes: 0 });
  await assert.rejects(readFile(join(f.home, "catalog.json")));
  await assert.rejects(readFile(join(f.home, "daemon", "daemon.json")));
  const other = await fixture(t);
  assert.equal((await other.send("/api/configuration", {}, token)).status, 401);
  assert.equal((await f.send("/api/configuration")).status, 401);
});

test("loopback authority, origin, target, methods, content type and exact operation contracts reject hostile requests", async (t) => {
  const f = await fixture(t),
    token = await f.session();
  const raw = async (
    path: string,
    headers: Record<string, string>,
    method = "GET",
    data?: string | Buffer
  ) =>
    new Promise<number>((resolve, reject) => {
      const req = request(f.manager.origin, { path, method, headers }, (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.end(data);
    });
  for (const host of [
    "localhost",
    "attacker.invalid",
    new URL(f.manager.origin).host + ".attacker.invalid",
  ])
    assert.equal(await raw("/", { Host: host }), 403);
  for (const origin of [
    "http://attacker.invalid",
    "null",
    "http://localhost:" + new URL(f.manager.origin).port,
  ]) {
    assert.equal(
      (await f.send("/api/configuration", { headers: { Origin: origin } }, token)).status,
      403
    );
    assert.equal(
      (
        await f.send("/api/session", {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify({ code: f.pairing() }),
        })
      ).status,
      403
    );
  }
  for (const path of [
    "http://attacker.invalid/",
    "/api/configuration?secret=fixture",
    "/%61pi/configuration",
    "/../index.html",
    "//api/configuration",
    "/assets/../index.html",
  ])
    assert.equal(
      await raw(path, { Host: new URL(f.manager.origin).host, Authorization: `Bearer ${token}` }),
      403
    );
  assert.equal(
    await raw(
      "/api/session",
      { Host: new URL(f.manager.origin).host, "Content-Type": "application/json" },
      "POST",
      "{}"
    ),
    403
  );
  for (const method of ["OPTIONS", "PUT", "DELETE", "HEAD"])
    assert.equal(await raw("/", { Host: new URL(f.manager.origin).host }, method), 403);
  for (const type of [
    "text/plain",
    "application/x-www-form-urlencoded",
    "application/json; charset=utf-8",
  ])
    assert.equal(
      (
        await f.send(
          "/api/operation",
          { method: "POST", headers: { "Content-Type": type }, body: "{}" },
          token
        )
      ).status,
      403
    );
  assert.equal(
    await raw("/", {
      Host: new URL(f.manager.origin).host,
      ...Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`X-Fixture-${i}`, "x"])),
    }),
    403
  );
  assert.equal(
    await raw("/", { Host: new URL(f.manager.origin).host, "Content-Length": "1" }, "GET", "x"),
    400
  );
  assert.equal(
    await raw(
      "/api/session",
      {
        Host: new URL(f.manager.origin).host,
        Origin: f.manager.origin,
        "Content-Type": "application/json",
      },
      "POST",
      Buffer.from([123, 34, 99, 111, 100, 101, 34, 58, 34, 255, 34, 125])
    ),
    400
  );
  const before = await f.configuration(token);
  for (const value of [
    { action: "run", uri: syntheticUri },
    {
      action: "registerEnvironment",
      env: "local",
      uri: syntheticUri,
      revision: before.revision,
      extra: "unexpected",
    },
    { action: "settings", patch: { uri: syntheticUri }, revision: before.revision },
  ]) {
    const r = await f.operation(token, value);
    assert.equal(r.status, 400);
    assert.doesNotMatch(await r.text(), /fixture-password|owned-fixture/);
  }
  assert.deepEqual(f.calls, { reads: 0, writes: 0, removes: 0 });
});

test("offline two-input save, shared aliases/settings and stale-browser protection never expose stored credentials", async (t) => {
  const f = await fixture(t),
    token = await f.session(),
    initial = await f.configuration(token);
  const save = await f.operation(token, {
    action: "registerEnvironment",
    env: "local",
    uri: syntheticUri,
    revision: initial.revision,
  });
  assert.equal(save.status, 200);
  assert.doesNotMatch(await save.text(), /fixture-password|secretRef|keyring:|owned-fixture/);
  assert.deepEqual(f.calls, { reads: 0, writes: 1, removes: 0 });
  const config = await f.configuration(token);
  assert.doesNotMatch(JSON.stringify(config), /fixture-password|secretRef|keyring:|owned-fixture/);
  const stale = await f.operation(token, {
    action: "settings",
    patch: { historyEnabled: false },
    revision: initial.revision,
  });
  assert.equal(stale.status, 409);
  const alias = await f.operation(token, {
    action: "addDatabase",
    env: "local",
    connection: "primary",
    alias: "shop",
    database: "physical_shop",
    revision: config.revision,
  });
  assert.equal(alias.status, 200);
  const latest = await f.configuration(token);
  await Effect.runPromise(setSettings(f.home, { idleTimeoutMs: 1234 }));
  assert.equal(
    (
      await f.operation(token, {
        action: "removeDatabase",
        env: "local",
        alias: "shop",
        revision: latest.revision,
      })
    ).status,
    409
  );
  assert.equal(
    (await Effect.runPromise(readCatalog(f.home))).environments["local"]!.databases["shop"]!
      .database,
    "physical_shop"
  );
  const raw = await readFile(join(f.home, "catalog.json"), "utf8");
  assert.doesNotMatch(raw, /fixture-password|mongodb:\/\//);
  assert.equal((await daemonCommand(f.home, "status")).ok, true);
  assert.deepEqual(await (await f.send("/api/status", {}, token)).json(), { running: false });
});

test("explicit tests use registered worker target and permission errors cannot reflect upstream URI text", async (t) => {
  const executed: unknown[] = [];
  const f = await fixture(t, {
    execute: async (_directory, input) => {
      executed.push(input);
      return { ok: false, error: { code: "PermissionDenied", message: syntheticUri } };
    },
  });
  const token = await f.session();
  const revision = (await f.configuration(token)).revision;
  await f.operation(token, {
    action: "registerEnvironment",
    env: "local",
    uri: syntheticUri,
    revision,
  });
  assert.deepEqual(executed, []);
  const result = await f.operation(token, {
    action: "discover",
    env: "local",
    connection: "primary",
  });
  assert.equal(result.status, 400);
  assert.doesNotMatch(await result.text(), /fixture-password|owned-fixture/);
  assert.deepEqual(executed, [
    { operation: "inspectConnection", env: "local", connection: "primary" },
  ]);
  assert.equal(f.calls.reads, 0);
});

test("lost registration response commits exactly once; shutdown drains atomic storage/catalog work", async (t) => {
  const entered = gate(),
    finish = gate(),
    values = new Map<string, string>();
  let writes = 0;
  const secrets = credentialStore(async (key) => ({
    async setPassword(value) {
      writes++;
      entered.release();
      await finish.promise;
      values.set(key, value);
    },
    async getPassword() {
      return values.get(key);
    },
    async deleteCredential() {
      return values.delete(key);
    },
  }));
  const f = await fixture(t, { secrets }),
    token = await f.session(),
    revision = (await f.configuration(token)).revision;
  const req = request(f.manager.origin + "/api/operation", {
    method: "POST",
    headers: {
      Origin: f.manager.origin,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  req.on("error", () => {});
  req.end(
    JSON.stringify({ action: "registerEnvironment", env: "local", uri: syntheticUri, revision })
  );
  await entered.promise;
  req.destroy();
  let stopped = false;
  const stopping = f.manager.stop().then(() => {
    stopped = true;
  });
  await pause(30);
  assert.equal(stopped, false);
  finish.release();
  await stopping;
  const catalog = await Effect.runPromise(readCatalog(f.home));
  assert.equal(catalog.environments["local"]!.defaultConnection, "primary");
  assert.equal(writes, 1);
  assert.equal(values.size, 1);
  assert.doesNotMatch(JSON.stringify(catalog), /fixture-password/);
});

test("disconnect cancels rotation validation before storage; replacement explicitly validates without listing", async (t) => {
  const entered = gate(),
    cancelled = gate();
  let calls = 0;
  const f = await fixture(t, {
    execute: async (_directory, input, signal) => {
      calls++;
      assert.deepEqual(input, { operation: "inspect", uri: syntheticUri, testOnly: true });
      entered.release();
      await new Promise<void>((resolve) =>
        signal!.addEventListener(
          "abort",
          () => {
            cancelled.release();
            resolve();
          },
          { once: true }
        )
      );
      return { ok: false, error: { code: "OperationCancelled", message: syntheticUri } };
    },
  });
  const token = await f.session();
  await f.operation(token, {
    action: "registerEnvironment",
    env: "local",
    uri: syntheticUri,
    revision: (await f.configuration(token)).revision,
  });
  const revision = (await f.configuration(token)).revision;
  const controller = new AbortController();
  const pending = f
    .send(
      "/api/operation",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "replaceCredential",
          env: "local",
          connection: "primary",
          uri: syntheticUri,
          revision,
        }),
        signal: controller.signal,
      },
      token
    )
    .catch(() => undefined);
  await entered.promise;
  controller.abort();
  await cancelled.promise;
  await pending;
  assert.equal(calls, 1);
  assert.equal(f.calls.writes, 1);
  assert.equal((await f.configuration(token)).revision, revision);
});

test("pairing/session expiry and metadata polling cannot prolong manager or daemon idle lifetime", {
  timeout: 5000,
}, async (t) => {
  const f = await fixture(t, { pairingTimeoutMs: 30, sessionTimeoutMs: 80, idleTimeoutMs: 300 });
  const code = f.pairing();
  await pause(40);
  assert.equal(
    (
      await f.send("/api/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      })
    ).status,
    401
  );
  const token = await f.session();
  await f.configuration(token);
  await pause(90);
  assert.equal((await f.send("/api/status", {}, token)).status, 401);
  await f.manager.closed;
  const other = await fixture(t, { idleTimeoutMs: 150 });
  const next = await other.session();
  let reads = 0;
  const poll = setInterval(() => {
    void other
      .send("/api/status", {}, next)
      .then(() => {
        reads++;
      })
      .catch(() => {});
  }, 20);
  try {
    await other.manager.closed;
  } finally {
    clearInterval(poll);
  }
  assert(reads > 1);
  assert.deepEqual(other.calls, { reads: 0, writes: 0, removes: 0 });
  const third = await fixture(t);
  await Effect.runPromise(setSettings(third.home, { idleTimeoutMs: 200 }));
  const daemon = await startDaemon(third.home);
  t.after(() => daemon.stop());
  const thirdToken = await third.session();
  const timer = setInterval(() => {
    void third.send("/api/status", {}, thirdToken).catch(() => {});
  }, 20);
  try {
    await daemon.closed;
  } finally {
    clearInterval(timer);
  }
  assert.deepEqual(await (await third.send("/api/status", {}, thirdToken)).json(), {
    running: false,
  });
});

test("manager stop interrupts an incomplete HTTP body without entering credential storage", {
  timeout: 3000,
}, async (t) => {
  const f = await fixture(t),
    token = await f.session();
  const req = request(f.manager.origin + "/api/operation", {
    method: "POST",
    headers: {
      Origin: f.manager.origin,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Content-Length": "60000",
    },
  });
  req.on("error", () => {});
  const closed = new Promise<void>((resolve) => req.once("close", resolve));
  req.write("{");
  await pause(30);
  const start = performance.now();
  await f.manager.stop();
  await closed;
  assert(performance.now() - start < 1000);
  assert.equal(f.calls.writes, 0);
});
