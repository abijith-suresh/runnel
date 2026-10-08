import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DaemonDescriptor, decodeDescriptor } from "./daemon-protocol.js";

export const daemonStateError = () => ({
  code: "DaemonStateInvalid",
  message:
    "Runnel daemon metadata or permissions are invalid. Check the private runtime directory.",
});
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
export function packageVersion(): string {
  const metadata: { version?: unknown } = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  if (typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+$/.test(metadata.version))
    throw daemonStateError();
  return metadata.version;
}
export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw daemonStateError();
  if (process.platform !== "win32") await chmod(directory, 0o700);
}
export async function runtimeDirectory(directory: string, create = false): Promise<string> {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const runtime = join(await realpath(directory), "daemon");
  if (create) await privateDirectory(runtime);
  else {
    const info = await lstat(runtime);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
    )
      throw daemonStateError();
  }
  return runtime;
}
export function socketPath(runtime: string, instance: string): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\runnel-${instance}`;
  const direct = join(runtime, "socket");
  if (Buffer.byteLength(direct) < 100) return direct;
  const hash = createHash("sha256").update(runtime).digest("hex").slice(0, 20);
  const fallback = join(tmpdir(), `runnel-${process.getuid?.() ?? "user"}-${hash}`, "socket");
  if (Buffer.byteLength(fallback) >= 100) throw daemonStateError();
  return fallback;
}
export async function readDaemonState(directory: string): Promise<DaemonDescriptor | undefined> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const runtime = await runtimeDirectory(directory);
    const flags =
      process.platform === "win32"
        ? constants.O_RDONLY
        : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW;
    file = await open(join(runtime, "daemon.json"), flags);
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > 4096 ||
      (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
    )
      throw daemonStateError();
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw daemonStateError();
    const descriptor = decodeDescriptor(
      JSON.parse(bytes.toString("utf8", 0, bytesRead)) as unknown
    );
    if (descriptor.endpoint !== socketPath(runtime, descriptor.instance)) throw daemonStateError();
    return descriptor;
  } catch (error) {
    if (missing(error)) return undefined;
    throw daemonStateError();
  } finally {
    await file?.close();
  }
}
export async function writeDaemonState(
  runtime: string,
  descriptor: DaemonDescriptor
): Promise<void> {
  const destination = join(runtime, "daemon.json");
  try {
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink()) throw daemonStateError();
  } catch (error) {
    if (!missing(error)) throw error;
  }
  const temporary = join(runtime, `.daemon-${descriptor.instance}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    try {
      await file.writeFile(JSON.stringify(descriptor));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
export async function removeDaemonState(directory: string, instance: string): Promise<void> {
  const descriptor = await readDaemonState(directory);
  if (descriptor?.instance === instance)
    await rm(join(await runtimeDirectory(directory), "daemon.json"), { force: true });
}
