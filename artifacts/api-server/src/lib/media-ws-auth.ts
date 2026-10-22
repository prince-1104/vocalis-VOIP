import { WebSocket, WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { logger } from "./logger";
import { metrics } from "./operational-metrics";
import {
  mediaSessions,
  verifyTwilioUpgrade,
  type MediaSession,
} from "./media-session";

export interface ActiveMediaContext extends Readonly<MediaSession> {
  readonly streamSid: string;
  isActive(): boolean;
  shutdown(): Promise<void>;
  onShutdown(cleanup: () => void): void;
}
type Activate = (
  ws: WebSocket,
  context: ActiveMediaContext,
  start: any,
) => Promise<void>;
const defaults = {
  sessions: mediaSessions,
  verifyUpgrade: verifyTwilioUpgrade,
  handshakeMs: 5_000,
};

export function rejectMediaUpgrade(socket: Duplex): void {
  socket.end(
    "HTTP/1.1 403 Access denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
  );
}

// Pre-auth sockets never enter the conversation handler, including its close
// handlers. A failed handshake therefore cannot finalize a customer call.
export function createMediaUpgrade(
  activate: Activate,
  finalize: (callId: number) => Promise<void>,
  dependencies: Partial<typeof defaults> = {},
) {
  const deps = { ...defaults, ...dependencies };
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const upgrade = async (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    try {
      const url = new URL(request.url || "", "http://media.invalid");
      const match =
        /^\/ws\/crm\/calls\/twilio-media-stream\/([1-9][0-9]*)$/.exec(
          url.pathname,
        );
      if (!match || url.search || !Number.isSafeInteger(Number(match[1]))) {
        rejectMediaUpgrade(socket);
        return;
      }
      const callId = Number(match[1]);
      await deps.verifyUpgrade(
        callId,
        url.pathname,
        request.headers["x-twilio-signature"],
      );
      if (socket.destroyed) return;
      wss.handleUpgrade(request, socket, head, (ws) => {
        let phase:
          | "connected"
          | "start"
          | "authenticating"
          | "active"
          | "closed" = "connected";
        let context: ActiveMediaContext | undefined;
        let endSession: (() => void) | undefined;
        const cleanups = new Set<() => void>();
        let shutdownPromise: Promise<void> | undefined;
        const deny = () => {
          phase = "closed";
          ws.close(1008, "Media access denied");
        };
        const timer = setTimeout(deny, deps.handshakeMs);
        timer.unref();
        const shutdown = () => {
          if (shutdownPromise) return shutdownPromise;
          phase = "closed";
          clearTimeout(timer);
          endSession?.();
          for (const cleanup of cleanups) {
            try {
              cleanup();
            } catch {
              /* continue cleanup */
            }
          }
          cleanups.clear();
          shutdownPromise = (async () => {
            const active = context;
            if (active) await metrics.measure("finalization", async () => {
              if (await deps.sessions.close(active.id)) await finalize(callId);
            }, "twilio");
          })();
          // No error objects: they may embed provider request URLs/credentials.
          shutdownPromise.catch(() => {
            logger.error("Media session finalization unavailable");
            ws.close(1011, "Media session unavailable");
          });
          return shutdownPromise;
        };
        ws.once("close", () => {
          clearTimeout(timer);
          void shutdown();
        });
        ws.on("error", () => {
          void shutdown();
          ws.terminate();
        });
        const handshake = async (raw: any, binary: boolean) => {
          try {
            if (binary || raw.length > 16 * 1024) {
              deny();
              return;
            }
            const message = JSON.parse(raw.toString());
            if (phase === "connected" && message.event === "connected") {
              phase = "start";
              return;
            }
            if (phase !== "start" || message.event !== "start") {
              deny();
              return;
            }
            phase = "authenticating";
            const session = await deps.sessions.authenticate(
              callId,
              message.start,
            );
            // A racing close/timeout must consume the claim but never activate.
            if (
              (phase as string) !== "authenticating" ||
              ws.readyState !== WebSocket.OPEN
            ) {
              await deps.sessions.close(session.id);
              return;
            }
            clearTimeout(timer);
            phase = "active";
            const activeContext: ActiveMediaContext = Object.freeze({
              ...session,
              streamSid: session.streamSid!,
              isActive: () =>
                phase === "active" && ws.readyState === WebSocket.OPEN,
              shutdown,
              onShutdown: (cleanup: () => void) => {
                if (phase === "active") cleanups.add(cleanup);
                else cleanup();
              },
            });
            context = activeContext;
            endSession = metrics.mediaSession();
            ws.off("message", handshake);
            // Authenticated providers can send frames while config loads. Bound
            // this initialization queue; never feed frames into an unready pipeline.
            const queued: [any, boolean][] = [];
            let bytes = 0;
            const initializing = (data: any, binary: boolean) => {
              bytes += data.length;
              if (binary || bytes > 64 * 1024) {
                void shutdown();
                ws.close(1008, "Media access denied");
                return;
              }
              queued.push([data, binary]);
            };
            ws.on("message", initializing);
            await activate(ws, activeContext, message.start);
            ws.off("message", initializing);
            if (activeContext.isActive())
              for (const args of queued) ws.emit("message", ...args);
          } catch {
            deny();
            if (context) void shutdown();
          }
        };
        ws.on("message", handshake);
      });
    } catch {
      rejectMediaUpgrade(socket);
    }
  };
  return {
    upgrade,
    close: () => {
      for (const ws of wss.clients) ws.terminate();
      wss.close();
    },
  };
}
