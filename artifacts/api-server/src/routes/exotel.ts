import { Router, type IRouter } from "express";
import { db, callLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { completeCallLog, getBaseUrl } from "./twilio";
import { mapExotelStatusToOutcome } from "../lib/telephony/exotel-client";
import { consumePendingExotelTransfer } from "../lib/telephony/exotel-stream-registry";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** Resolve the Dialog callLogId from an Exotel webhook (CustomField, query, or CallSid lookup). */
async function resolveCallLogId(req: any): Promise<string | null> {
  const body = req.body || {};
  let callLogId =
    (req.query.callLogId as string | undefined) ||
    (body.CustomField as string | undefined) ||
    (body.custom_field as string | undefined);

  if (!callLogId) {
    const callSid = body.CallSid || body.call_sid || body.Sid || (req.query.CallSid as string | undefined);
    if (callSid) {
      const bySid = await db.query.callLogsTable.findFirst({
        where: eq(callLogsTable.callSid, callSid),
      });
      if (bySid) callLogId = String(bySid.id);
    }
  }

  return callLogId || null;
}

/**
 * Exotel StatusCallback — terminal call events.
 * Configure StatusCallback when placing outbound calls via Calls/connect.
 */
router.post("/exotel/status", async (req, res) => {
  let callLogId = req.query.callLogId as string | undefined;
  const body = req.body || {};

  const callSid = body.CallSid || body.call_sid || body.Sid;
  const status = body.Status || body.status || body.DialCallStatus;
  const duration =
    parseInt(body.ConversationDuration || body.Duration || body.duration || "0", 10) || 0;

  if (!callLogId && body.CustomField) {
    callLogId = String(body.CustomField);
  }

  if (!callLogId && callSid) {
    const bySid = await db.query.callLogsTable.findFirst({
      where: eq(callLogsTable.callSid, callSid),
    });
    if (bySid) callLogId = String(bySid.id);
  }

  if (callLogId) {
    const mappedStatus = mapExotelStatusToOutcome(status);
    const twilioEquivalent =
      mappedStatus === "answered" ? "completed"
      : mappedStatus === "busy" ? "busy"
      : "no-answer";

    logger.info({ callLogId, status, mappedStatus, duration }, "Exotel status callback");

    await completeCallLog(
      parseInt(callLogId, 10),
      twilioEquivalent,
      duration,
      getBaseUrl(req),
    );
  }

  res.status(200).send("OK");
});

/**
 * Dynamic Voicebot URL resolver for Exotel Passthru applet.
 * Returns JSON: { "url": "wss://host/ws/exotel/media-stream/{callLogId}" }
 */
router.get("/exotel/stream-url", (req, res) => {
  const callLogId = req.query.callLogId as string;
  if (!callLogId) {
    res.status(400).json({ error: "callLogId required" });
    return;
  }

  const baseUrl = getBaseUrl(req);
  const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
  const wsProto = isLocal ? "ws" : "wss";
  const wsUrl = `${baseUrl.replace(/^https?/, wsProto)}/ws/exotel/media-stream/${callLogId}`;

  res.json({ url: wsUrl });
});

/** Passthru applet can POST CustomField / call metadata */
router.post("/exotel/passthru", (req, res) => {
  const callLogId = req.query.callLogId as string || req.body?.CustomField || req.body?.custom_field;
  if (!callLogId) {
    res.status(400).json({ error: "callLogId required" });
    return;
  }

  const baseUrl = getBaseUrl(req);
  const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
  const wsProto = isLocal ? "ws" : "wss";
  const wsUrl = `${baseUrl.replace(/^https?/, wsProto)}/ws/exotel/media-stream/${callLogId}`;

  res.json({ url: wsUrl });
});

/**
 * Connect applet Dynamic URL — called by Exotel after the Voicebot WebSocket
 * closes. If a transfer is pending for the call we return the agent destination
 * so Exotel bridges the caller to the human agent. Otherwise we signal "no
 * connect" (HTTP 302) so Exotel falls through to the Hangup applet and ends the
 * call cleanly.
 *
 * Flow setup: Voicebot Applet → Connect Applet (Dial Whom = Dynamic URL → this).
 */
async function handleExotelConnect(req: any, res: any): Promise<void> {
  const callLogId = await resolveCallLogId(req);

  if (!callLogId) {
    logger.warn("Exotel connect: no callLogId resolved");
    res.status(302).json({ destination: null });
    return;
  }

  const pending = consumePendingExotelTransfer(callLogId);

  if (!pending) {
    logger.info({ callLogId }, "Exotel connect: no pending transfer — routing to hangup");
    res.status(302).json({ destination: null });
    return;
  }

  const dest = pending.destination.trim();
  const isSip = dest.toLowerCase().startsWith("sip:");

  logger.info({ callLogId, destination: dest, isSip }, "Exotel connect: bridging caller to agent");

  res.status(200).json({
    fetch_after_attempt: false,
    destination: isSip ? { sip: dest } : { numbers: [dest] },
    record: true,
    recording_channels: "dual",
  });
}

router.post("/exotel/connect", handleExotelConnect);
router.get("/exotel/connect", handleExotelConnect);

export default router;
