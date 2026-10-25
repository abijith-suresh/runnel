import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Schema from "effect/Schema";
import { emptyCatalog } from "../dist/catalog.js";
import { startDaemon } from "../dist/daemon-server.js";
import { runExportCommand } from "../dist/export-command.js";
import { readHistory } from "../dist/history.js";
import { queryResultBytes } from "../dist/mongodb-query.js";

const executable = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const response = (documents: Schema.JsonObject[] = []) => ({
  ok: true as const,
  data: {
    env: "local",
    db: "accounts",
    collection: "users",
    format: "ejson" as const,
    documents,
    truncated: false,
    limits: { documents: 100, bytes: queryResultBytes },
  },
});
const code = (result: Awaited<ReturnType<typeof runExportCommand>>) => {
  assert(!result.ok);
  return result.error.code;
};
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "runnel-export-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function cli(directory: string, args: string[], input?: string) {
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [executable, ...args], {
        cwd: directory,
        env: { ...process.env, RUNNEL_HOME: join(directory, "home") },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (value: Buffer) => {
        stdout += value.toString();
      });
      child.stderr.on("data", (value: Buffer) => {
        stderr += value.toString();
      });
      child.once("error", reject);
      child.once("close", (status) => resolve({ status, stdout, stderr }));
      child.stdin.end(input);
    }
  );
}

test("export preflight validates targets, output and query options before dispatch", async (t) => {
  const directory = await fixture(t);
  let executions = 0;
  const execute = async () => {
    executions++;
    return response();
  };
  for (const [values, expected] of [
    [{ output: join(directory, "users.ejson") }, "EnvironmentRequired"],
    [{ env: "local" }, "InputInvalid"],
    [{ env: "local", output: "-" }, "InputInvalid"],
    [{ env: "local", output: `${join(directory, "missing")}/` }, "InputInvalid"],
    [{ env: "local", output: `${join(directory, "missing")}/.` }, "InputInvalid"],
    [{ env: "local", output: `${join(directory, "missing")}/child/..` }, "InputInvalid"],
    [{ env: "local", output: `${join(directory, "missing")}\\` }, "InputInvalid"],
    [{ env: "local", output: "\0" }, "InputInvalid"],
    [{ env: "local", output: join(directory, "users.ejson"), limit: "1001" }, "InputInvalid"],
    [{ env: "local", output: join(directory, "users.ejson"), filter: "[]" }, "InputInvalid"],
    [{ env: "local", output: join(directory, "users.ejson"), format: "csv" }, "InputInvalid"],
    [{ env: "local", output: join(directory, "absent", "users.ejson") }, "OutputUnavailable"],
  ] as const) {
    assert.equal(code(await runExportCommand(directory, "users", values, execute)), expected);
  }
  assert.equal(executions, 0);
  assert.deepEqual(await readdir(directory), []);
});

test("export writes a complete private array and returns metadata without documents", async (t) => {
  const directory = await fixture(t);
  for (const format of ["json", "ejson"] as const) {
    const output = join(directory, `users.${format}`);
    const documents =
      format === "ejson" ? [{ n: { $numberLong: "9007199254740993" } }] : [{ n: 5 }];
    const result = await runExportCommand(
      directory,
      "users",
      { env: "local", output, format },
      async () => ({
        ...response(),
        ok: true,
        data: {
          ...response().data,
          format,
          documents,
          truncated: true,
          truncationReason: "documents",
        },
        warning: "HistoryUnavailable",
      })
    );
    assert(result.ok);
    assert.equal(result.data.documents, 1);
    assert.equal(result.data.truncationReason, "documents");
    assert.equal(result.warning, "HistoryUnavailable");
    const contents = await readFile(output, "utf8");
    assert.equal(contents, `${JSON.stringify(documents)}\n`);
    assert.equal(result.data.bytes, Buffer.byteLength(contents));
    assert(!JSON.stringify(result).includes("9007199254740993"));
    if (process.platform !== "win32") assert.equal((await stat(output)).mode & 0o777, 0o600);
  }
  assert.deepEqual((await readdir(directory)).sort(), ["users.ejson", "users.json"]);
});

test("existing files, directories, links and racing destinations are never replaced", async (t) => {
  const directory = await fixture(t);
  const sentinel = join(directory, "sentinel");
  await writeFile(sentinel, "preserve");
  const hard = join(directory, "hard");
  await link(sentinel, hard);
  const folder = join(directory, "folder");
  await mkdir(folder);
  const outputs = [sentinel, hard, folder];
  if (process.platform !== "win32") {
    const dangling = join(directory, "dangling");
    await symlink(join(directory, "missing"), dangling);
    outputs.push(dangling);
  }
  let executions = 0;
  for (const output of outputs) {
    assert.equal(
      code(
        await runExportCommand(directory, "users", { env: "local", output }, async () => {
          executions++;
          return response();
        })
      ),
      "OutputExists"
    );
  }
  assert.equal(executions, 0);
  const racing = join(directory, "racing");
  assert.equal(
    code(
      await runExportCommand(directory, "users", { env: "local", output: racing }, async () => {
        await writeFile(racing, "winner");
        return response([{ n: 1 }]);
      })
    ),
    "OutputExists"
  );
  assert.equal(await readFile(sentinel, "utf8"), "preserve");
  assert.equal(await readFile(racing, "utf8"), "winner");
  assert(!(await readdir(directory)).some((name) => name.startsWith(".runnel-export-")));
});

test("failed or oversized results leave no destination or temporary files", async (t) => {
  const directory = await fixture(t);
  const output = join(directory, "users.ejson");
  for (const [execute, expected] of [
    [
      async () => ({
        ok: false as const,
        error: { code: "PermissionDenied", message: "Denied." },
        warning: "HistoryUnavailable" as const,
      }),
      "PermissionDenied",
    ],
    [
      async () => {
        throw new Error("private returned document");
      },
      "OutputUnavailable",
    ],
    [async () => response([{ value: "x".repeat(queryResultBytes) }]), "ResultTooLarge"],
  ] as const) {
    const result = await runExportCommand(directory, "users", { env: "local", output }, execute);
    assert.equal(code(result), expected);
    assert(!JSON.stringify(result).includes("private returned document"));
    assert.deepEqual(await readdir(directory), []);
  }
});

test("CLI exports resolve relative destinations, read stdin filters and record one sanitized operation", async (t) => {
  const directory = await fixture(t);
  const home = join(directory, "home");
  await mkdir(home);
  await writeFile(
    join(home, "catalog.json"),
    JSON.stringify({
      ...emptyCatalog(),
      environments: {
        local: {
          connections: {
            primary: { provider: "mongodb", secretRef: "keyring:runnel/export-test" },
          },
          databases: { accounts: { connection: "primary", database: "physical" } },
        },
      },
    })
  );
  const worker = join(directory, "worker.mjs");
  await writeFile(
    worker,
    `process.on('message', ({id, request}) => {
    const valid = request.operation === 'export' && request.filter === '{"active":true}' && request.sort === '{"n":1}';
    process.send({type:'result', id, result: valid ? {ok:true, data:{env:'local', db:'accounts', collection:'users', format:'ejson', documents:[{secretDocument:'fixture'}], truncated:true, truncationReason:'documents', limits:{documents:1,bytes:524288}}} : {ok:false,error:{code:'InputInvalid',message:'Unexpected request.'}}});
  }); process.send({type:'ready'});`
  );
  const daemon = await startDaemon(home, { workerEntrypoint: pathToFileURL(worker) });
  try {
    const result = await cli(
      directory,
      [
        "export",
        "users",
        "-e",
        "local",
        "--output",
        "users.ejson",
        "--filter-file",
        "-",
        "--sort",
        '{"n":1}',
        "--limit",
        "1",
      ],
      '{"active":true}'
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const envelope = JSON.parse(result.stdout);
    // Windows temporary roots can use an 8.3 alias; export reports the real parent.
    assert.equal(envelope.data.output, join(await realpath(directory), "users.ejson"));
    assert.equal(envelope.data.documents, 1);
    assert.equal(envelope.data.truncated, true);
    assert(!result.stdout.includes("secretDocument"));
    assert.deepEqual(JSON.parse(await readFile(join(directory, "users.ejson"), "utf8")), [
      { secretDocument: "fixture" },
    ]);
    const history = await readHistory(home);
    assert.equal(history.length, 1);
    assert.equal(history[0]?.operation, "export");
    assert.deepEqual(history[0]?.targets, { env: "local", db: "accounts", connection: "primary" });
    assert(!JSON.stringify(history).includes("users.ejson"));
    assert(!JSON.stringify(history).includes("secretDocument"));
    assert.equal(
      (await cli(directory, ["export", "users", "-e", "local", "--output", "users.ejson"])).status,
      1
    );
    assert.equal((await readHistory(home)).length, 1);
  } finally {
    await daemon.stop();
  }
});
