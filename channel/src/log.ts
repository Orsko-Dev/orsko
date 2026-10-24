/**
 * Structured stderr logging. Message text never reaches the log: only event
 * names, seqs, counts, and error classes, so a room transcript cannot leak
 * into a terminal scrollback or a debug file.
 */

export type LogFields = Readonly<Record<string, string | number | boolean>>;

export interface Logger {
  event(name: string, fields?: LogFields): void;
}

function render(name: string, fields: LogFields): string {
  const pairs = Object.entries(fields).map(([key, value]) => `${key}=${String(value)}`);
  return ["orsko-channel", name, ...pairs].join(" ");
}

export function createLogger(write: (line: string) => void = writeStderr): Logger {
  return {
    event(name, fields = {}) {
      write(render(name, fields));
    },
  };
}

function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** The class of an error, for logs that must not carry its message. */
export function errorClass(error: unknown): string {
  if (error instanceof Error) return error.name;
  return typeof error;
}
