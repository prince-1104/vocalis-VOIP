import type { EventEmitter } from "node:events";
import type { ErrorRequestHandler } from "express";
import { STATUS_CODES } from "node:http";
import { logger } from "./logger";

/**
 * Final Express error handler. Replaces Express's default handler, which
 * prints raw stacks (including JSON parse snippets of request bodies) to stderr.
 */
export function safeErrorHandler(): ErrorRequestHandler {
  return (err, req, res, next) => {
    const rawStatus = Number(err?.status ?? err?.statusCode);
    const status = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
    logger.error(
      {
        event: "http_request_failed",
        err,
        reqId: (req as { id?: unknown }).id,
        method: req.method,
        path: req.path,
        status,
      },
      "Unhandled request error",
    );
    if (res.headersSent) {
      next(err);
      return;
    }
    res.status(status).type("text/plain").send(STATUS_CODES[status] ?? "Error");
  };
}

/**
 * Log process-level failures through the safe logger, then exit as Node would
 * have done for an unhandled rejection or uncaught exception.
 */
export function installProcessErrorHandlers(
  proc: EventEmitter = process,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  proc.on("unhandledRejection", (reason: unknown) => {
    logger.fatal({ event: "unhandled_rejection", err: reason }, "Unhandled promise rejection");
    exit(1);
  });
  proc.on("uncaughtException", (err: unknown) => {
    logger.fatal({ event: "uncaught_exception", err }, "Uncaught exception");
    exit(1);
  });
}
