import app from "./app";
import { logger } from "./lib/logger";
import { syncDatabase } from "./lib/db-sync";
import { createServer } from "http";
import { initWebSocketServer } from "./lib/crm-ws-server";

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

syncDatabase().then(() => {
  // Create HTTP server wrapping Express so WebSocket can share the same port
  const server = createServer(app);

  // Initialize CRM WebSocket server on the same HTTP server
  initWebSocketServer(server);

  server.listen(port, () => {
    logger.info({ port }, "Server listening (HTTP + WebSocket)");
  });

  server.on("error", (err) => {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  });
});
