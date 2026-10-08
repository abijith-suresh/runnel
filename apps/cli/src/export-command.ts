import { randomUUID } from "node:crypto";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { executeWithDaemon } from "./daemon-client.js";
import { type DaemonResponse, decodeDaemonResponse } from "./daemon-protocol.js";
import { queryResultBytes } from "./mongodb-query.js";
import { buildQueryRequest, type QueryValues } from "./query-command.js";
import { QueryError } from "./query-input.js";

export type ExportResponse =
  | Extract<DaemonResponse, { ok: false }>
  | {
      ok: true;
      data: {
        env: string;
        db: string;
        collection: string;
        format: "json" | "ejson";
        output: string;
        documents: number;
        bytes: number;
        truncated: boolean;
        truncationReason?: "documents" | "bytes";
        limits: { documents: number; bytes: number };
      };
      warning?: "HistoryUnavailable";
    };

/** Save a bounded worker result. Only the CLI touches the destination filesystem. */
export async function runExportCommand(
  directory: string,
  collection: string,
  values: QueryValues & { output?: string },
  execute = executeWithDaemon
): Promise<ExportResponse> {
  let temporary: string | undefined;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let warning: "HistoryUnavailable" | undefined;
  try {
    if (values.env === undefined)
      throw new QueryError("EnvironmentRequired", "Specify an environment with -e or --env.");
    if (
      !values.output ||
      values.output === "-" ||
      values.output.includes("\0") ||
      /(?:[\\/]|(?:^|[\\/])\.{1,2})$/.test(values.output)
    )
      throw new QueryError("InputInvalid", "Export requires --output with a new filename.");
    const request = await buildQueryRequest("export", collection, values);
    const supplied = resolve(values.output);
    const output = join(await realpath(dirname(supplied)), basename(supplied));
    try {
      await lstat(output);
      throw new QueryError(
        "OutputExists",
        "The export destination already exists. Choose a new filename."
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    temporary = join(dirname(output), `.runnel-export-${randomUUID()}.tmp`);
    file = await open(temporary, "wx", 0o600);
    const result = decodeDaemonResponse(await execute(directory, request));
    if ("warning" in result) warning = result.warning;
    if (!result.ok) return result;
    if (!("documents" in result.data))
      throw new QueryError("ResultEncodingFailed", "The worker returned an invalid export result.");
    const data = result.data;
    const contents = `${JSON.stringify(data.documents)}\n`;
    const bytes = Buffer.byteLength(contents, "utf8");
    if (bytes > queryResultBytes + 1)
      throw new QueryError("ResultTooLarge", "Export documents exceed the 512 KiB result budget.");
    await file.writeFile(contents);
    await file.sync();
    await file.close();
    file = undefined;
    // Linking a complete sibling file commits without replacing a racing destination.
    try {
      await link(temporary, output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new QueryError(
          "OutputExists",
          "The export destination already exists. Choose a new filename."
        );
      throw error;
    }
    return {
      ok: true,
      data: {
        env: data.env,
        db: data.db,
        collection: data.collection,
        format: data.format,
        output,
        documents: data.documents.length,
        bytes,
        truncated: data.truncated,
        ...(data.truncationReason === undefined ? {} : { truncationReason: data.truncationReason }),
        limits: data.limits,
      },
      ...(warning === undefined ? {} : { warning }),
    };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof QueryError
          ? { code: error.code, message: error.message }
          : {
              code: "OutputUnavailable",
              message:
                "Cannot prepare or save the export file. Check the destination directory, permissions, and hard-link support.",
            },
      ...(warning === undefined ? {} : { warning }),
    };
  } finally {
    if (file) await file.close().catch(() => undefined);
    if (temporary) await unlink(temporary).catch(() => undefined);
  }
}
