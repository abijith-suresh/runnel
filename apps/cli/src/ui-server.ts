import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { daemonCommand } from "./daemon-client.js";
import {
  type ManagerDependencies,
  managerConfiguration,
  managerOperation,
} from "./ui-operations.js";
import {
  decodeManagerOperation,
  decodePairing,
  type ManagerOperation,
  managerError,
} from "./ui-protocol.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const random = () => randomBytes(32).toString("hex");
const bodyLimit = 65536;
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'";
const mime: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  woff2: "font/woff2",
  svg: "image/svg+xml",
};

async function assets() {
  const root = new URL("./ui/", import.meta.url);
  const result = new Map<string, { body: Buffer; type: string }>();
  let total = 0;
  async function visit(base: URL, prefix: string) {
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error("Invalid bundled asset");
      if (entry.isDirectory()) {
        await visit(new URL(`${entry.name}/`, base), `${prefix}${entry.name}/`);
        continue;
      }
      const type = mime[entry.name.split(".").at(-1)!];
      if (!entry.isFile() || !type) continue;
      const body = await readFile(new URL(entry.name, base));
      total += body.length;
      if (body.length > 2 * 1024 * 1024 || total > 8 * 1024 * 1024)
        throw new Error("Invalid bundled asset");
      result.set(`${prefix}${entry.name}`, { body, type });
    }
  }
  await visit(root, "/");
  const index = result.get("/index.html");
  if (!index) throw new Error(`Missing bundled UI assets in ${fileURLToPath(root)}`);
  result.set("/", index);
  return result;
}

function oneHeader(req: IncomingMessage, name: string) {
  const values: string[] = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i]?.toLowerCase() === name) values.push(req.rawHeaders[i + 1]!);
  return values.length === 1 ? values[0] : undefined;
}
function headers(res: ServerResponse) {
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}
function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 2 * 1024 * 1024) {
    fail(res, 500, "ManagementUnavailable");
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
function fail(res: ServerResponse, status: number, code: string) {
  json(res, status, { ok: false, error: managerError(code) });
}
async function body(req: IncomingMessage, signal: AbortSignal) {
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > bodyLimit))
    throw new Error("Body limit");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    if (signal.aborted) throw new Error("Cancelled");
    bytes += chunk.length;
    if (bytes > bodyLimit) throw new Error("Body limit");
    chunks.push(chunk);
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  return JSON.parse(text) as unknown;
}
export type ManagerOptions = ManagerDependencies & {
  readonly idleTimeoutMs?: number;
  readonly sessionTimeoutMs?: number;
  readonly pairingTimeoutMs?: number;
};
const duration = (value: number | undefined, fallback: number) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 10 || value > 2147483647)
    throw new Error("Invalid manager timeout");
  return value;
};

/** Foreground, loopback-only HTTP manager. No database or vault access on startup. */
export async function startManager(directory: string, options: ManagerOptions = {}) {
  const staticAssets = await assets();
  const idleMs = duration(options.idleTimeoutMs, 30 * 60 * 1000);
  const sessionMs = duration(options.sessionTimeoutMs, 15 * 60 * 1000);
  const pairingMs = duration(options.pairingTimeoutMs, 60 * 1000);
  const sessions = new Map<string, number>();
  let pairing: { digest: string; expires: number } | undefined;
  let origin = "";
  let stopping = false;
  let closing: Promise<void> | undefined;
  let idle: NodeJS.Timeout;
  const active = new Map<AbortController, Promise<void>>();
  const sockets = new Set<Socket>();
  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  function touch() {
    clearTimeout(idle);
    idle = setTimeout(() => {
      void stop();
    }, idleMs);
  }
  async function dispatch(req: IncomingMessage, res: ServerResponse, controller: AbortController) {
    headers(res);
    const path = req.url ?? "";
    const requestOrigin = oneHeader(req, "origin");
    if (stopping) {
      fail(res, 503, "Busy");
      return;
    }
    if (
      req.rawHeaders.length > 64 ||
      oneHeader(req, "host") !== origin.slice(7) ||
      (req.headers["origin"] !== undefined && requestOrigin !== origin) ||
      req.headers["sec-fetch-site"] === "cross-site" ||
      path.length > 2048 ||
      !/^\/(?:[A-Za-z0-9_./-]*)$/.test(path) ||
      path.includes("..") ||
      path.includes("//") ||
      (req.method !== "GET" && req.method !== "POST")
    ) {
      fail(res, 403, "Forbidden");
      return;
    }
    if (
      req.method === "GET" &&
      (req.headers["transfer-encoding"] !== undefined ||
        (req.headers["content-length"] !== undefined && req.headers["content-length"] !== "0"))
    ) {
      fail(res, 400, "RequestInvalid");
      return;
    }
    if (req.method === "GET" && !path.startsWith("/api/")) {
      const asset = staticAssets.get(path);
      if (!asset) {
        fail(res, 404, "RequestInvalid");
        return;
      }
      res.writeHead(200, { "Content-Type": asset.type });
      res.end(asset.body);
      return;
    }
    if (
      req.method === "POST" &&
      (requestOrigin !== origin ||
        oneHeader(req, "content-type") !== "application/json" ||
        req.headers["content-encoding"] !== undefined)
    ) {
      fail(res, 403, "Forbidden");
      return;
    }
    const now = Date.now();
    for (const [token, expiry] of sessions) if (expiry <= now) sessions.delete(token);
    if (path === "/api/session" && req.method === "POST") {
      let code: string;
      try {
        code = decodePairing(await body(req, controller.signal)).code;
      } catch {
        fail(res, 400, "RequestInvalid");
        return;
      }
      if (
        !pairing ||
        pairing.expires <= Date.now() ||
        hash(code) !== pairing.digest ||
        sessions.size >= 8
      ) {
        fail(res, 401, "Unauthorized");
        return;
      }
      pairing = undefined;
      const token = random(),
        expiresAt = Date.now() + sessionMs;
      sessions.set(hash(token), expiresAt);
      touch();
      json(res, 200, { token, expiresAt });
      return;
    }
    const authorization = oneHeader(req, "authorization");
    if (
      !authorization ||
      !/^Bearer [a-f0-9]{64}$/.test(authorization) ||
      !sessions.has(hash(authorization.slice(7)))
    ) {
      fail(res, 401, "Unauthorized");
      return;
    }
    if (path === "/api/configuration" && req.method === "GET") {
      json(res, 200, await managerConfiguration(directory));
      return;
    }
    if (path === "/api/status" && req.method === "GET") {
      const status = await daemonCommand(directory, "status");
      if (status.ok) json(res, 200, status.data);
      else fail(res, 503, status.error.code);
      return;
    }
    if (path !== "/api/operation" || req.method !== "POST") {
      fail(res, 404, "RequestInvalid");
      return;
    }
    let operation: ManagerOperation;
    try {
      operation = decodeManagerOperation(await body(req, controller.signal));
    } catch {
      fail(res, 400, "RequestInvalid");
      return;
    }
    if (controller.signal.aborted) {
      fail(res, 408, "OperationCancelled");
      return;
    }
    touch();
    const result = await managerOperation(directory, operation, controller.signal, options);
    if (result.ok) {
      json(res, 200, {
        ok: true,
        result: result.data,
        ...("warning" in result
          ? {
              warning: {
                code: "SecretCleanupFailed",
                message: "Saved, but obsolete credential cleanup failed.",
              },
            }
          : {}),
      });
      if (operation.action === "stopManager")
        setImmediate(() => {
          void stop();
        });
    } else fail(res, result.error.code === "CatalogChanged" ? 409 : 400, result.error.code);
  }
  const server = createServer(
    { maxHeaderSize: 16384, headersTimeout: 10000, requestTimeout: 10000, keepAliveTimeout: 1000 },
    (req, res) => {
      if (active.size >= 8) {
        headers(res);
        fail(res, 503, "Busy");
        req.resume();
        return;
      }
      const controller = new AbortController();
      controller.signal.addEventListener(
        "abort",
        () => {
          if (!req.complete) req.destroy();
        },
        { once: true }
      );
      const abort = () => controller.abort();
      const disconnected = () => {
        if (!res.writableEnded) abort();
      };
      req.once("aborted", abort);
      res.once("close", disconnected);
      const timeout = setTimeout(() => {
        controller.abort();
        if (!req.complete) req.destroy();
      }, 20000);
      const work = dispatch(req, res, controller)
        .catch(() => {
          headers(res);
          fail(res, 500, "ManagementUnavailable");
        })
        .finally(() => {
          clearTimeout(timeout);
          active.delete(controller);
          req.removeListener("aborted", abort);
          res.removeListener("close", disconnected);
        });
      active.set(controller, work);
    }
  );
  // Count the complete bounded header list ourselves; Node's count limit silently truncates it.
  server.maxHeadersCount = 0;
  server.maxConnections = 32;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => {
    socket.destroy();
  });
  server.on("error", () => {
    void stop();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot bind manager");
  origin = `http://127.0.0.1:${address.port}`;
  touch();
  function stop(): Promise<void> {
    if (closing) return closing;
    stopping = true;
    clearTimeout(idle);
    sessions.clear();
    pairing = undefined;
    // Cancel validation/inspection and close the listener, but let atomic vault/catalog commits finish.
    for (const controller of active.keys()) controller.abort();
    const listenerClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeIdleConnections();
    closing = (async () => {
      await Promise.allSettled([...active.values()]);
      for (const socket of sockets) socket.destroy();
      await listenerClosed;
      resolveClosed();
    })();
    return closing;
  }
  return {
    origin,
    closed,
    stop,
    pairingUrl() {
      if (stopping) throw new Error("Manager is stopped");
      const code = random();
      pairing = { digest: hash(code), expires: Date.now() + pairingMs };
      return `${origin}/#pair=${code}`;
    },
  };
}
