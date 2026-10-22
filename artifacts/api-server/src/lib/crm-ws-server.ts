import { Server as HTTPServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { crmEventBus, type CRMCallEvent } from "./crm-event-bus";
import { logger } from "./logger";
import {
  handleTwilioStreamUpgrade,
  handleExotelStreamUpgrade,
} from "./twilio-ws-server";
import {
  resolveCrmCredential,
  revalidateCrmIdentity,
  requireCrmRead,
  authorizeCrmCall,
  resolveCallOwner,
  AuthorizationError,
  type CrmIdentity,
} from "./crm-authorization";

const defaults = {
  resolveCrmCredential,
  revalidateCrmIdentity,
  authorizeCrmCall,
  resolveCallOwner,
  handleTwilioStreamUpgrade,
  handleExotelStreamUpgrade,
  bus: crmEventBus,
  intervalMs: 30_000,
};

export function initWebSocketServer(
  server: HTTPServer,
  dependencies: Partial<typeof defaults> = {},
): () => void {
  const deps = { ...defaults, ...dependencies };
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<{
    ws: WebSocket;
    identity: CrmIdentity;
    callId: number | null;
    alive: boolean;
  }>();
  let disposed = false;
  let delivery = Promise.resolve();
  const deny = (socket: any, status: number) => {
    socket.end(
      `HTTP/1.1 ${status} Access denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  };
  const validate = async (
    client: typeof clients extends Set<infer T> ? T : never,
  ) => {
    const identity = await deps.revalidateCrmIdentity(client.identity);
    requireCrmRead(identity);
    if (client.callId !== null)
      await deps.authorizeCrmCall(identity, client.callId);
    return identity;
  };
  const closeInvalid = (client: { ws: WebSocket }, error: unknown) => {
    client.ws.close(
      error instanceof AuthorizationError ? 1008 : 1011,
      "Access denied",
    );
  };
  const upgrade = async (request: any, socket: any, head: Buffer) => {
    if (disposed) {
      deny(socket, 503);
      return;
    }
    try {
      const url = new URL(request.url || "", "http://websocket.invalid");
      if (url.pathname.startsWith("/ws/exotel/media-stream")) {
        await deps.handleExotelStreamUpgrade(request, socket, head);
        return;
      }
      if (url.pathname.startsWith("/ws/crm/calls/twilio-media-stream")) {
        await deps.handleTwilioStreamUpgrade(request, socket, head);
        return;
      }
      const match = /^\/ws\/crm\/calls(?:\/([1-9][0-9]*))?$/.exec(url.pathname);
      if (!match || (match[1] && !Number.isSafeInteger(Number(match[1])))) {
        deny(socket, 404);
        return;
      }
      const callId = match[1] ? Number(match[1]) : null;
      const identity = await deps.resolveCrmCredential(
        url.searchParams.get("apiKey") || "",
      );
      requireCrmRead(identity);
      if (callId !== null) await deps.authorizeCrmCall(identity, callId);
      if (disposed || socket.destroyed) {
        deny(socket, 503);
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        const client = { ws, identity, callId, alive: true };
        clients.add(client);
        const cleanup = () => {
          clients.delete(client);
        };
        ws.once("close", cleanup);
        ws.on("error", () => {
          cleanup();
          ws.terminate();
        });
        ws.on("pong", () => {
          client.alive = true;
        });
        ws.send(
          JSON.stringify({
            type: "connected",
            callId,
            message: callId
              ? `Streaming events for call ${callId}`
              : "Streaming all call events for your tenant",
          }),
        );
      });
    } catch (error) {
      deny(socket, error instanceof AuthorizationError ? error.status : 503);
    }
  };
  server.on("upgrade", upgrade);

  const onEvent = (event: CRMCallEvent) => {
    delivery = delivery
      .then(async () => {
        if (
          disposed ||
          !Number.isSafeInteger(event.callId) ||
          event.callId <= 0
        )
          return;
        const owner = await deps.resolveCallOwner(event.callId);
        if (!owner) return;
        for (const client of clients) {
          if (
            client.ws.readyState !== WebSocket.OPEN ||
            (client.callId !== null && client.callId !== event.callId)
          )
            continue;
          try {
            const identity = await validate(client);
            if (
              !disposed &&
              clients.has(client) &&
              client.ws.readyState === WebSocket.OPEN &&
              identity.userId === owner.userId &&
              identity.tenantId === owner.tenantId
            ) {
              // The persisted call, not an optional publisher assertion, supplies identity.
              client.ws.send(
                JSON.stringify({ ...event, userId: owner.userId }),
              );
            }
          } catch (error) {
            closeInvalid(client, error);
          }
        }
      })
      .catch(() => {
        logger.error("CRM event authorization unavailable");
        for (const client of clients) client.ws.close(1011, "Access denied");
      });
  };
  deps.bus.onCallEvent(onEvent);
  let checking = false;
  const timer = setInterval(async () => {
    if (checking || disposed) return;
    checking = true;
    try {
      for (const client of clients) {
        try {
          await validate(client);
          if (!client.alive) {
            client.ws.terminate();
            continue;
          }
          client.alive = false;
          if (client.ws.readyState === WebSocket.OPEN) client.ws.ping();
        } catch (error) {
          closeInvalid(client, error);
        }
      }
    } finally {
      checking = false;
    }
  }, deps.intervalMs);
  timer.unref();
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    server.off("upgrade", upgrade);
    server.off("close", dispose);
    deps.bus.off("call-event", onEvent);
    for (const client of clients) client.ws.terminate();
    clients.clear();
    wss.close();
  };
  server.once("close", dispose);
  return dispose;
}
