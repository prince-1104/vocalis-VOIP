import { logger } from "../logger";

/**
 * Exotel transfers are flow-based, not programmatic like Twilio.
 *
 * To transfer an in-progress Voicebot call to a human agent we must:
 *   1. Record the destination (number / SIP) for the call.
 *   2. Close the Voicebot WebSocket, which makes Exotel advance to the next
 *      applet in the flow (a Connect applet pointed at a Dynamic URL).
 *   3. Serve the recorded destination back to Exotel from that Dynamic URL
 *      (see routes/exotel.ts → /api/exotel/connect).
 *
 * This module keeps the small amount of in-memory state required to bridge the
 * live WebSocket handler and the REST endpoints that initiate transfers.
 */

export interface PendingExotelTransfer {
  /** Destination phone (E.164) or SIP URI to connect the caller to. */
  destination: string;
  reason: string;
  crmAgentId?: string;
  transferType: "cold" | "warm";
  createdAt: number;
}

interface ClosableStream {
  close: () => void;
}

const activeStreams = new Map<string, ClosableStream>();
const pendingTransfers = new Map<string, PendingExotelTransfer>();

/** Pending transfers expire so a stale destination is never dialed on a later call. */
const PENDING_TTL_MS = 2 * 60 * 1000;

export function registerExotelStream(callLogId: string, ws: ClosableStream): void {
  activeStreams.set(callLogId, ws);
}

export function unregisterExotelStream(callLogId: string): void {
  activeStreams.delete(callLogId);
}

export function setPendingExotelTransfer(callLogId: string, transfer: PendingExotelTransfer): void {
  pendingTransfers.set(callLogId, transfer);
}

/** Read-and-delete the pending transfer for a call (single-shot). */
export function consumePendingExotelTransfer(callLogId: string): PendingExotelTransfer | null {
  const entry = pendingTransfers.get(callLogId);
  if (!entry) return null;
  pendingTransfers.delete(callLogId);
  if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
    logger.warn({ callLogId }, "Pending Exotel transfer expired before Connect applet fired");
    return null;
  }
  return entry;
}

/**
 * Record the transfer destination and close the live Voicebot stream so Exotel
 * advances to the Connect applet. Returns true if a live stream was closed.
 */
export function requestExotelTransfer(callLogId: string, transfer: PendingExotelTransfer): boolean {
  setPendingExotelTransfer(callLogId, transfer);
  const ws = activeStreams.get(callLogId);
  if (!ws) {
    logger.warn({ callLogId }, "No active Exotel stream to close for transfer (call may already be in flow)");
    return false;
  }
  try {
    ws.close();
  } catch (err) {
    logger.error({ err, callLogId }, "Failed to close Exotel stream for transfer");
  }
  activeStreams.delete(callLogId);
  return true;
}
