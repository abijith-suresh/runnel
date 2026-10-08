import type { Socket } from "node:net";
import { ipcLimitBytes } from "./worker-protocol.js";

/** One bounded newline-terminated JSON frame per connection. */
export function readFrame(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    const cleanup = () => {
      socket.off("data", data);
      socket.off("error", failed);
      socket.off("end", ended);
      socket.off("close", ended);
    };
    const failed = () => {
      cleanup();
      reject(new Error("Local transport failed."));
    };
    const ended = () => {
      cleanup();
      reject(new Error("Local transport ended before a result."));
    };
    const data = (chunk: Buffer) => {
      length += chunk.length;
      if (length > ipcLimitBytes + 1) {
        failed();
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      const newline = chunk.indexOf(10);
      if (newline < 0) return;
      cleanup();
      try {
        if (newline !== chunk.length - 1) throw new Error("Unexpected trailing frame");
        resolve(
          JSON.parse(
            Buffer.concat(chunks, length)
              .subarray(0, length - 1)
              .toString("utf8")
          ) as unknown
        );
      } catch {
        reject(new Error("Invalid local frame."));
      }
    };
    socket.on("data", data);
    socket.once("error", failed);
    socket.once("end", ended);
    socket.once("close", ended);
  });
}
