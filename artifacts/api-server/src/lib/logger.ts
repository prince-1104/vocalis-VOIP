import { IncomingMessage, ServerResponse } from "node:http";
import pino, { type DestinationStream, type LoggerOptions } from "pino";
import { redactForLog, safeError, scrubText } from "./log-redaction";

const isProduction = process.env.NODE_ENV === "production";

const ERROR_KEYS = ["err", "error", "ttsErr", "classifyErr", "aggErr"] as const;

function isHttpMessage(value: unknown): boolean {
  return value instanceof IncomingMessage || value instanceof ServerResponse;
}

function errorMessageOf(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const safe = safeError(value) as { message?: unknown };
    if (typeof safe?.message === "string") return safe.message;
  }
  return undefined;
}

/** Scrub message strings/interpolation values before Pino derives `msg`. */
export function sanitizeLogArgs(args: unknown[]): unknown[] {
  try {
    const [first, ...rest] = args;
    const tail = rest.map((arg) => (typeof arg === "string" ? scrubText(arg) : redactForLog(arg)));
    if (typeof first === "string") return [scrubText(first), ...tail];
    if (first instanceof Error) {
      return typeof rest[0] === "string" ? [{ err: first }, ...tail] : [{ err: first }, errorMessageOf(first) ?? "Error"];
    }
    if (first && typeof first === "object" && typeof rest[0] !== "string") {
      const record = first as Record<string, unknown>;
      for (const key of ERROR_KEYS) {
        const message = errorMessageOf(record[key]);
        if (message !== undefined) return [first, message];
      }
    }
    return [first, ...tail];
  } catch {
    return [{}, "[Unserializable log arguments]"];
  }
}

/** Redact every merge-object field; raw HTTP objects are left to their safe serializers. */
export function formatLogObject(obj: Record<string, unknown>): Record<string, unknown> {
  try {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (isHttpMessage(value)) {
        out[key] = value;
        continue;
      }
      const wrapped = redactForLog({ [key]: value });
      out[key] = wrapped && typeof wrapped === "object" ? (wrapped as Record<string, unknown>)[key] : "[Unserializable]";
    }
    return out;
  } catch {
    return { logRedactionFailed: true };
  }
}

export const safeHttpSerializers = {
  req(req: any) {
    return {
      id: req?.id,
      method: req?.method,
      url: typeof req?.url === "string" ? scrubText(req.url.split("?")[0]) : undefined,
    };
  },
  res(res: any) {
    return { statusCode: res?.statusCode };
  },
};

export function buildLoggerOptions(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? "info",
    serializers: {
      ...Object.fromEntries(ERROR_KEYS.map((key) => [key, (value: unknown) => safeError(value)])),
      ...safeHttpSerializers,
    },
    formatters: { log: formatLogObject },
    hooks: {
      logMethod(args, method) {
        method.apply(this, sanitizeLogArgs(args) as Parameters<typeof method>);
      },
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers['set-cookie']",
        "*.headers.authorization",
        "*.headers.cookie",
        "*.headers['x-twilio-signature']",
      ],
      censor: "[REDACTED]",
    },
  };
}

export function createLogger(destination?: DestinationStream) {
  const options = buildLoggerOptions();
  if (destination) return pino(options, destination);
  return pino({
    ...options,
    ...(isProduction ? {} : { transport: { target: "pino-pretty", options: { colorize: true } } }),
  });
}

export const logger = createLogger();
