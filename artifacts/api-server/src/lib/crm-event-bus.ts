import { EventEmitter } from "events";
import { logger } from "./logger";

// ── CRM Event Types ────────────────────────────────────────────────────
export interface CRMCallEvent {
  type:
    | "call.ringing"
    | "call.answered"
    | "call.turn"
    | "call.intent"
    | "call.transferring"
    | "call.transferred"
    | "call.ended"
    | "call.error";
  callId: number;
  callSid?: string;
  userId?: number;              // tenant owner — used to scope webhook delivery
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;   // opaque CRM metadata echoed back
  timestamp: string;
}

// ── In-Process Event Bus ───────────────────────────────────────────────
// All call lifecycle events flow through this bus. Consumers:
//   1. WebSocket server → streams events to connected CRM clients
//   2. Webhook dispatcher → POSTs events to CRM's webhook URL
//
// Using Node's EventEmitter instead of Redis/Kafka — sufficient for single-
// process deployments. If horizontal scaling is needed, swap to Redis pub/sub.

class CRMEventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }

  emitCallEvent(event: CRMCallEvent): void {
    logger.debug({ event: event.type, callId: event.callId }, "CRM event emitted");
    this.emit("call-event", event);
    this.emit(`call:${event.callId}`, event);
  }

  onCallEvent(handler: (event: CRMCallEvent) => void): void {
    this.on("call-event", handler);
  }

  onSpecificCall(callId: number, handler: (event: CRMCallEvent) => void): void {
    this.on(`call:${callId}`, handler);
  }

  offSpecificCall(callId: number, handler: (event: CRMCallEvent) => void): void {
    this.off(`call:${callId}`, handler);
  }
}

export const crmEventBus = new CRMEventBus();
