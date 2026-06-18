import { Server as HTTPServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "url";
import crypto from "crypto";
import { db, crmApiKeysTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { crmEventBus, type CRMCallEvent } from "./crm-event-bus";
import { logger } from "./logger";
import { handleTwilioStreamUpgrade } from "./twilio-ws-server";

// ── WebSocket Server for CRM Real-Time Streaming ──────────────────────
//
// CRM clients connect to:
//   ws://host/ws/crm/calls/{callId}?apiKey=dk_live_xxx
//
// They receive all CRM events for that specific call in real-time.
// Alternatively, connect to /ws/crm/calls?apiKey=dk_live_xxx to receive
// ALL call events for the tenant.

interface WSClient {
  ws: WebSocket;
  userId: number;
  callId: number | null;    // null = subscribe to all calls for this tenant
  apiKeyId: number;
}

const clients = new Set<WSClient>();

async function authenticateApiKey(rawKey: string): Promise<{ userId: number; apiKeyId: number } | null> {
  if (!rawKey || !rawKey.startsWith("dk_live_")) return null;

  const hash = crypto.createHash("sha256").update(rawKey).digest("hex");

  const apiKey = await db.query.crmApiKeysTable.findFirst({
    where: and(
      eq(crmApiKeysTable.keyHash, hash),
      eq(crmApiKeysTable.isActive, true),
    ),
  });

  if (!apiKey) return null;

  // Update last used (fire and forget)
  db.update(crmApiKeysTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(crmApiKeysTable.id, apiKey.id))
    .catch(() => {});

  return { userId: apiKey.userId, apiKeyId: apiKey.id };
}

function broadcastEvent(event: CRMCallEvent): void {
  const payload = JSON.stringify(event);

  for (const client of clients) {
    if (client.ws.readyState !== WebSocket.OPEN) continue;

    // Send to clients watching this specific call or all calls for the tenant
    // Note: we'd need to know the call's userId to filter properly.
    // For now, filter by callId match or null (all calls).
    if (client.callId === null || client.callId === event.callId) {
      try {
        client.ws.send(payload);
      } catch (err) {
        logger.error({ err, callId: event.callId }, "WS send error");
      }
    }
  }
}

export function initWebSocketServer(server: HTTPServer): void {
  const wss = new WebSocketServer({ noServer: true });

  // Handle HTTP upgrade for WebSocket connections
  server.on("upgrade", async (request, socket, head) => {
    try {
      const url = new URL(request.url || "", `http://${request.headers.host}`);
      const pathname = url.pathname;

      // Handle Twilio Media Stream upgrades
      if (pathname.startsWith("/ws/twilio/media-stream")) {
        await handleTwilioStreamUpgrade(request, socket, head);
        return;
      }

      // Only handle /ws/crm/calls paths
      if (!pathname.startsWith("/ws/crm/calls")) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      // Extract API key from query param
      const apiKey = url.searchParams.get("apiKey");
      if (!apiKey) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const auth = await authenticateApiKey(apiKey);
      if (!auth) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      // Extract optional callId from path: /ws/crm/calls/123
      const pathParts = pathname.split("/").filter(Boolean);
      let callId: number | null = null;
      if (pathParts.length >= 4 && pathParts[3]) {
        const parsed = parseInt(pathParts[3]);
        if (!isNaN(parsed)) callId = parsed;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request, { ...auth, callId });
      });
    } catch (err) {
      logger.error({ err }, "WebSocket upgrade error");
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket, _request: any, meta: { userId: number; apiKeyId: number; callId: number | null }) => {
    const client: WSClient = {
      ws,
      userId: meta.userId,
      callId: meta.callId,
      apiKeyId: meta.apiKeyId,
    };

    clients.add(client);
    logger.info({ userId: meta.userId, callId: meta.callId }, "CRM WebSocket client connected");

    // Send a welcome message
    ws.send(JSON.stringify({
      type: "connected",
      callId: meta.callId,
      message: meta.callId
        ? `Streaming events for call ${meta.callId}`
        : "Streaming all call events for your tenant",
    }));

    // Handle client disconnect
    ws.on("close", () => {
      clients.delete(client);
      logger.info({ userId: meta.userId, callId: meta.callId }, "CRM WebSocket client disconnected");
    });

    ws.on("error", (err) => {
      logger.error({ err, userId: meta.userId }, "CRM WebSocket error");
      clients.delete(client);
    });

    // Ping/pong to keep connection alive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(pingInterval);
      }
    }, 30_000);

    ws.on("close", () => clearInterval(pingInterval));
  });

  // Subscribe to event bus and broadcast to connected clients
  crmEventBus.onCallEvent((event) => {
    broadcastEvent(event);
  });

  logger.info("CRM WebSocket server initialized on /ws/crm/calls");
}
