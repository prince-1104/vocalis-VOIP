import { Router, type IRouter } from "express";
import twilio from "twilio";
import { db, agentConfigsTable, callLogsTable, contactsTable, campaignsTable, campaignContactsTable, callingScriptsTable, tenantsTable, sipTrunkConfigsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { dialNextForCampaign } from "../lib/campaign-dialer";
import { decrypt } from "../lib/encryption";

const router: IRouter = Router();

function getTwilioClient(accountSid: string, authToken: string) {
  return twilio(accountSid, authToken);
}

/** Map Twilio CallStatus to dialer UI states */
function mapTwilioCallStatus(twilioStatus: string, endedAt: Date | null): string {
  if (endedAt) return "ended";
  switch (twilioStatus) {
    case "queued":
    case "initiated":
      return "dialing";
    case "ringing":
      return "ringing";
    case "in-progress":
      return "active";
    case "completed":
    case "busy":
    case "failed":
    case "no-answer":
    case "canceled":
      return "ended";
    default:
      return "dialing";
  }
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

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.ownerId, userId),
  });

  if (!tenant) {
    res.status(400).json({ error: "Tenant not found for user." });
    return;
  }

  let toPhone = contact.phone;
  let fromPhone: string;
  let sipAuthUsername: string | undefined;
  let sipAuthPassword: string | undefined;

  if (tenant.telephonyType === "SIP_TRUNK") {
    const sipConfig = await db.query.sipTrunkConfigsTable.findFirst({
      where: eq(sipTrunkConfigsTable.tenantId, tenant.id),
    });

    if (!sipConfig || !sipConfig.isEnabled) {
      res.status(400).json({ error: "SIP Trunk configuration is disabled or not found." });
      return;
    }

    toPhone = `sip:${contact.phone}@${sipConfig.sipDomain}`;
    fromPhone = sipConfig.phoneNumber;
    sipAuthUsername = sipConfig.sipUsername;
    try {
      sipAuthPassword = decrypt(sipConfig.sipPassword);
    } catch (err) {
      res.status(500).json({ error: "Failed to decrypt SIP password." });
      return;
    }
  } else {
    if (!agentConfig.phoneNumber) {
      res.status(400).json({ error: "Twilio phone number not configured. Please set it in AI Agent settings." });
      return;
    }
    fromPhone = agentConfig.phoneNumber;
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
    to: toPhone,
    from: fromPhone,
    url: `${baseUrl}/api/twilio/outbound-voice?callLogId=${callLog.id}&userId=${userId}`,
    statusCallback: `${baseUrl}/api/twilio/status?callLogId=${callLog.id}`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
    machineDetection: "Enable",
    asyncAmd: "true",
    ...(sipAuthUsername && sipAuthPassword ? { sipAuthUsername, sipAuthPassword } : {}),
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

  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.ownerId, userId),
  });

  if (!tenant) {
    res.status(400).json({ error: "Tenant not found for user." });
    return;
  }

  let toPhone = phone;
  let fromPhone: string;
  let sipAuthUsername: string | undefined;
  let sipAuthPassword: string | undefined;

  if (tenant.telephonyType === "SIP_TRUNK") {
    const sipConfig = await db.query.sipTrunkConfigsTable.findFirst({
      where: eq(sipTrunkConfigsTable.tenantId, tenant.id),
    });

    if (!sipConfig || !sipConfig.isEnabled) {
      res.status(400).json({ error: "SIP Trunk configuration is disabled or not found." });
      return;
    }

    toPhone = `sip:${phone}@${sipConfig.sipDomain}`;
    fromPhone = sipConfig.phoneNumber;
    sipAuthUsername = sipConfig.sipUsername;
    try {
      sipAuthPassword = decrypt(sipConfig.sipPassword);
    } catch (err) {
      res.status(500).json({ error: "Failed to decrypt SIP password." });
      return;
    }
  } else {
    if (!agentConfig.phoneNumber) {
      res.status(400).json({ error: "Twilio phone number not configured. Go to AI Agent → Twilio Settings to add your phone number." });
      return;
    }
    fromPhone = agentConfig.phoneNumber;
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
      to: toPhone,
      from: fromPhone,
      url: `${baseUrl}/api/twilio/outbound-voice?callLogId=${callLog.id}&userId=${userId}`,
      statusCallback: `${baseUrl}/api/twilio/status?callLogId=${callLog.id}`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
      machineDetection: "Enable",
      asyncAmd: "true",
      ...(sipAuthUsername && sipAuthPassword ? { sipAuthUsername, sipAuthPassword } : {}),
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
router.get("/dial/calls/:id/live", async (req, res) => {
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

  let status = call.endedAt ? "ended" : "dialing";

  if (!call.endedAt && call.callSid) {
    const agentConfig = await db.query.agentConfigsTable.findFirst({
      where: eq(agentConfigsTable.userId, userId),
    });

    if (agentConfig?.twilioAccountSid && agentConfig?.twilioAuthToken) {
      try {
        const client = getTwilioClient(agentConfig.twilioAccountSid, agentConfig.twilioAuthToken);
        const twilioCall = await client.calls(call.callSid).fetch();
        status = mapTwilioCallStatus(twilioCall.status, call.endedAt);
      } catch {
        // Keep last known status if Twilio fetch fails
      }
    }
  }

  res.json({
    callId: call.id,
    callSid: call.callSid,
    phone: call.phone,
    status,
    liveTranscript: call.liveTranscript || [],
    transcript: call.transcript,
    transferredTo: call.transferredTo,
    endedAt: call.endedAt,
    startedAt: call.startedAt,
    duration: call.duration,
  });
});

export default router;
