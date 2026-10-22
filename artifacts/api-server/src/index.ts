import app, { startBackgroundWorkers } from "./app";
import { logger } from "./lib/logger";
import { createServer } from "http";
import { pool } from "@workspace/db";
import { initWebSocketServer } from "./lib/crm-ws-server";
import { closeMediaWebSockets } from "./lib/twilio-ws-server";
import { installProcessErrorHandlers } from "./lib/error-handler";
import { credentialCodec } from "./lib/credential-crypto";
import { probeRateLimitStore, rateLimitSettings } from "./lib/rate-limit";
import { createReadiness, runStartup, StartupBlockedError, waitForCompatibleSchema } from "./lib/schema-readiness";
import { setReadinessCheck } from "./routes/health";

installProcessErrorHandlers();

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Stored tenant credentials cannot be read or written without a valid key;
// refuse to start rather than fail per request. Messages contain no key data.
credentialCodec();
// Rate-limit store and key configuration; the memory store is refused in production.
rateLimitSettings();

const startupTimeoutMs = Number(process.env["DB_STARTUP_TIMEOUT_MS"] ?? 60_000);
const readiness = createReadiness(pool);
setReadinessCheck(() => readiness.check());

runStartup({
  // The schema is changed only by the migrate command, never at startup.
  checkSchema: () =>
    waitForCompatibleSchema(pool, {
      timeoutMs: Number.isFinite(startupTimeoutMs) && startupTimeoutMs >= 0 ? startupTimeoutMs : 60_000,
      onRetry: (attempt, error) =>
        logger.warn({ event: "database_unavailable", attempt, error }, "Database unavailable at startup; retrying"),
    }).then((report) => {
      if (report.newerThanCode > 0)
        logger.warn({ event: "schema_newer_than_code", migrations: report.newerThanCode }, "Database has migrations newer than this build");
      logger.info({ event: "schema_ready" }, "Database schema compatible");
    }),
  // Fail-closed limits (login, verification, billed operations) answer 503
  // while the shared store is unreachable; surface that at startup.
  prepare: async () => { await probeRateLimitStore(); },
  listen: () =>
    new Promise<void>((resolve, reject) => {
      // Create HTTP server wrapping Express so WebSocket can share the same port
      const server = createServer(app);

      // Initialize CRM WebSocket server on the same HTTP server
      const disposeWebSockets = initWebSocketServer(server);
      server.once("close", () => { disposeWebSockets(); closeMediaWebSockets(); });

      server.once("error", reject);
      server.listen(port, () => {
        server.off("error", reject);
        server.on("error", (err) => {
          logger.error({ err }, "HTTP server error");
        });
        logger.info({ port }, "Server listening (HTTP + WebSocket)");
        resolve();
      });
    }),
  startWorkers: startBackgroundWorkers,
  markReady: () => readiness.markReady(),
}).catch((err) => {
  readiness.markBlocked();
  if (err instanceof StartupBlockedError) {
    logger.fatal({ event: "startup_blocked", reason: err.reason, details: err.details }, err.message);
  } else {
    const e = err as { name?: string; code?: string };
    logger.fatal({ event: "startup_failed", errorName: e?.name, code: e?.code }, "Server failed to start");
  }
  // Exit so a supervisor or deploy check sees the failure; nothing was served.
  setTimeout(() => process.exit(1), 5_000).unref();
  void pool.end().catch(() => {}).finally(() => process.exit(1));
});
