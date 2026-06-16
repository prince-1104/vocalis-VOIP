import { Router, type IRouter } from "express";
import twilio from "twilio";
import { db, agentConfigsTable, callLogsTable, contactsTable, campaignsTable, campaignContactsTable, callingScriptsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { dialNextForCampaign } from "../lib/campaign-dialer";

const router: IRouter = Router();

function getTwilioClient(accountSid: string, authToken: string) {
  return twilio(accountSid, authToken);
}

function getBaseUrl(req: any): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    const first = domains.split(",")[0].trim();
    return `https://${first}`;
  }
  const host = req.headers.host || "localhost";
  return `https://${host}`;
}

router.post("/contacts/:id/dial", async (req, res) => {
  const userId = req.userId!;

  const contact = await db.query.contactsTable.findFirst({
    where: and(eq(contactsTable.id, parseInt(req.params.id)), eq(contactsTable.userId, userId)),
  });

  if (!contact) {
    res.status(404).json({ error: "Contact not found" });
    return;
  }

  const agentConfig = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });

  if (!agentConfig?.twilioAccountSid || !agentConfig?.twilioAuthToken) {
    res.status(400).json({ error: "Twilio credentials not configured. Please set them in AI Agent settings." });
    return;
  }

  if (!agentConfig.phoneNumber) {
    res.status(400).json({ error: "Twilio phone number not configured. Please set it in AI Agent settings." });
    return;
  }

  const baseUrl = getBaseUrl(req);
  const client = getTwilioClient(agentConfig.twilioAccountSid, agentConfig.twilioAuthToken);

  const [callLog] = await db.insert(callLogsTable).values({
    userId,
    contactId: contact.id,
    campaignId: req.body.campaignId || null,
    direction: "outbound",
    phone: contact.phone,
    outcome: "no_answer",
    aiModel: agentConfig.aiModel || "gpt-4o-mini",
    startedAt: new Date(),
  }).returning();

  await db.update(contactsTable)
    .set({ status: "called", lastCalledAt: new Date(), updatedAt: new Date() })
    .where(eq(contactsTable.id, contact.id));

  const call = await client.calls.create({
    to: contact.phone,
    from: agentConfig.phoneNumber,
    url: `${baseUrl}/api/twilio/outbound-voice?callLogId=${callLog.id}&userId=${userId}`,
    statusCallback: `${baseUrl}/api/twilio/status?callLogId=${callLog.id}`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
    machineDetection: "Enable",
    asyncAmd: "true",
  });

  // Store Twilio Call SID for CRM tracking/control
  await db.update(callLogsTable)
    .set({ callSid: call.sid })
    .where(eq(callLogsTable.id, callLog.id));

  res.json({ callSid: call.sid, callLogId: callLog.id, status: "dialing" });
});

router.post("/campaigns/:id/dial-next", async (req, res) => {
  const userId = req.userId!;
  const campaignId = parseInt(req.params.id);

  if (isNaN(campaignId)) {
    res.status(400).json({ error: "Invalid campaign ID" });
    return;
  }

  try {
    const baseUrl = getBaseUrl(req);
    const result = await dialNextForCampaign(campaignId, userId, baseUrl);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Failed to dial next contact" });
  }
});

// ── Dial by raw phone number (Dialer UI) ──
router.post("/dial/phone", async (req, res) => {
  const userId = req.userId!;
  const { phone } = req.body;

  if (!phone) {
    res.status(400).json({ error: "phone is required" });
    return;
  }

  const agentConfig = await db.query.agentConfigsTable.findFirst({
    where: eq(agentConfigsTable.userId, userId),
  });

  if (!agentConfig?.twilioAccountSid || !agentConfig?.twilioAuthToken) {
    res.status(400).json({ error: "Twilio credentials not configured. Go to AI Agent → Twilio Settings to add your Account SID, Auth Token, and Phone Number." });
    return;
  }

  if (!agentConfig.phoneNumber) {
    res.status(400).json({ error: "Twilio phone number not configured. Go to AI Agent → Twilio Settings to add your phone number." });
    return;
  }

  const baseUrl = getBaseUrl(req);
  const client = getTwilioClient(agentConfig.twilioAccountSid, agentConfig.twilioAuthToken);

  const [callLog] = await db.insert(callLogsTable).values({
    userId,
    direction: "outbound",
    phone,
    outcome: "no_answer",
    aiModel: agentConfig.aiModel || "gpt-4o-mini",
    startedAt: new Date(),
  }).returning();

  try {
    const call = await client.calls.create({
      to: phone,
      from: agentConfig.phoneNumber,
      url: `${baseUrl}/api/twilio/outbound-voice?callLogId=${callLog.id}&userId=${userId}`,
      statusCallback: `${baseUrl}/api/twilio/status?callLogId=${callLog.id}`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
      machineDetection: "Enable",
      asyncAmd: "true",
    });

    // Store the Call SID
    await db.update(callLogsTable)
      .set({ callSid: call.sid })
      .where(eq(callLogsTable.id, callLog.id));

    res.json({ callSid: call.sid, callLogId: callLog.id, status: "dialing" });
  } catch (err: any) {
    await db.update(callLogsTable)
      .set({ outcome: "no_answer", endedAt: new Date() })
      .where(eq(callLogsTable.id, callLog.id));

    res.status(500).json({
      error: `Twilio error: ${err.message}`,
      callLogId: callLog.id,
    });
  }
});


// ── Internal: End an active call (JWT auth — used by the Dialer UI) ──
router.post("/dial/calls/:id/end", async (req, res) => {
  const userId = req.userId!;
  const callId = parseInt(req.params.id);

  if (isNaN(callId)) {
    res.status(400).json({ error: "Invalid call ID" });
    return;
  }

  const call = await db.query.callLogsTable.findFirst({
    where: and(eq(callLogsTable.id, callId), eq(callLogsTable.userId, userId)),
  });

  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }

  if (call.endedAt) {
    // Already ended — treat as success so the UI can proceed
    res.json({ success: true, message: "Call already ended" });
    return;
  }

  const agentConfig = await db.query.agentConfigsTable.findFirst({
    where: eq(agentConfigsTable.userId, userId),
  });

  try {
    if (call.callSid && agentConfig?.twilioAccountSid && agentConfig?.twilioAuthToken) {
      const client = getTwilioClient(agentConfig.twilioAccountSid, agentConfig.twilioAuthToken);
      await client.calls(call.callSid).update({ status: "completed" });
    }

    const formattedTranscript = (call?.liveTranscript && Array.isArray(call.liveTranscript))
      ? call.liveTranscript
          .map((turn: any) => `${turn.role === "user" ? "Caller" : "Agent"}: ${turn.content}`)
          .join("\n\n")
      : null;

    await db.update(callLogsTable)
      .set({
        endedAt: new Date(),
        outcome: "answered",
        ...(formattedTranscript ? { transcript: formattedTranscript } : {}),
      })
      .where(eq(callLogsTable.id, callId));

    res.json({ success: true, message: `Call ${callId} ended` });
  } catch (err: any) {
    res.status(500).json({ error: err.message || "Failed to end call" });
  }
});

// ── Internal: Poll call status + live transcript (JWT auth — used by Dialer UI) ──
router.get("/calls/:id", async (req, res) => {
  const userId = req.userId!;
  const callId = parseInt(req.params.id);

  if (isNaN(callId)) {
    res.status(400).json({ error: "Invalid call ID" });
    return;
  }

  const call = await db.query.callLogsTable.findFirst({
    where: and(eq(callLogsTable.id, callId), eq(callLogsTable.userId, userId)),
  });

  if (!call) {
    res.status(404).json({ error: "Call not found" });
    return;
  }

  res.json({
    callId: call.id,
    callSid: call.callSid,
    phone: call.phone,
    status: call.endedAt ? "completed" : "active",
    liveTranscript: call.liveTranscript || [],
    transcript: call.transcript,
    transferredTo: call.transferredTo,
    endedAt: call.endedAt,
    startedAt: call.startedAt,
    duration: call.duration,
  });
});

export default router;
