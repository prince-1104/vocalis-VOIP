import pinoHttp from "pino-http";
import { logger, safeHttpSerializers } from "./logger";
import { safeError } from "./log-redaction";

/** Request logging: method, path without query, status, timing and request ID only. */
export function createHttpLogger() {
  return pinoHttp({
    logger,
    serializers: {
      ...safeHttpSerializers,
      err: (err: unknown) => safeError(err),
    },
  });
}
