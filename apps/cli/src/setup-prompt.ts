import { createInterface } from "node:readline/promises";
import { type Readable, Writable } from "node:stream";

export interface SetupPrompt {
  ask(label: string, options?: { hidden?: boolean; defaultValue?: string }): Promise<string>;
  write(message: string): void;
}
export class PromptError extends Error {
  readonly code: "SetupTerminalRequired" | "SetupCancelled" | "SetupInputTooLong";
  constructor(code: "SetupTerminalRequired" | "SetupCancelled" | "SetupInputTooLong") {
    super(code);
    this.code = code;
  }
}
type TerminalInput = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};
type TerminalOutput = Writable & { isTTY?: boolean };

/** Hidden input uses readline's raw terminal handling and discards all echo/redraw output. */
export function terminalPrompt(
  input: TerminalInput = process.stdin,
  output: TerminalOutput = process.stderr
): SetupPrompt {
  if (!input.isTTY || !output.isTTY || !input.setRawMode)
    throw new PromptError("SetupTerminalRequired");
  return {
    write: (message) => {
      output.write(message);
    },
    ask: (label, options = {}) =>
      new Promise((resolve, reject) => {
        const wasRaw = input.isRaw ?? false;
        const echo = options.hidden
          ? new Writable({ write: (_chunk, _encoding, done) => done() })
          : output;
        const reader = createInterface({
          input,
          output: echo,
          terminal: true,
          crlfDelay: Infinity,
          historySize: 0,
        });
        let settled = false;
        let bytes = 0;
        const finish = (error?: PromptError, answer?: string) => {
          if (settled) return;
          settled = true;
          input.off("data", bound);
          input.off("error", failed);
          output.off("error", failed);
          reader.close();
          if (wasRaw) input.setRawMode?.(true);
          if (options.hidden) output.write("\n");
          if (error) reject(error);
          else resolve(answer === "" ? (options.defaultValue ?? "") : (answer ?? ""));
        };
        const bound = (chunk: string | Buffer) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > 16384) finish(new PromptError("SetupInputTooLong"));
        };
        const failed = () => finish(new PromptError("SetupCancelled"));
        input.on("data", bound);
        input.once("error", failed);
        output.once("error", failed);
        reader.once("error", failed);
        reader.once("SIGINT", failed);
        reader.once("close", failed);
        const question = `${label}${options.defaultValue ? ` [${options.defaultValue}]` : ""}: `;
        if (options.hidden) output.write(question);
        reader
          .question(options.hidden ? "" : question)
          .then((answer) => finish(undefined, answer), failed);
      }),
  };
}
