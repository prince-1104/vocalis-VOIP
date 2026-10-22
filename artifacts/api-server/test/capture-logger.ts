// Test replacement for the application logger module: the real Pino logger and
// redaction configuration, writing to memory so tests inspect emitted lines.
import { createLogger } from "../src/lib/logger";
export {
  createLogger,
  buildLoggerOptions,
  formatLogObject,
  sanitizeLogArgs,
  safeHttpSerializers,
} from "../src/lib/logger";

export const logs: Record<string, any>[] = [];
export const rawLines: string[] = [];

const destination = {
  write(chunk: string) {
    for (const line of String(chunk).split("\n")) {
      if (!line) continue;
      rawLines.push(line);
      logs.push(JSON.parse(line));
    }
  },
};

export const logger = createLogger(destination as any);

/** Exact emitted output since the last reset. */
export function emitted(): string {
  return rawLines.join("\n");
}

export function resetLogs() {
  logs.length = 0;
  rawLines.length = 0;
}
