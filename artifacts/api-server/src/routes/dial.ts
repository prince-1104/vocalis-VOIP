import { Router, type IRouter } from "express";
import twilio from "twilio";
import { db, agentConfigsTable, callLogsTable, contactsTable, campaignsTable, campaignContactsTable, callingScriptsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

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

  const campaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, parseInt(req.params.id)), eq(campaignsTable.userId, userId)),
  });

  if (!campaign) {
    res.status(404).json({ error: "Campaign not found" });
    return;
  }

  if (campaign.status !== "active") {
    res.status(400).json({ error: "Campaign is not active" });
    return;
  }

  const contactLinks = await db.select().from(campaignContactsTable)
    .where(eq(campaignContactsTable.campaignId, campaign.id));

  const pendingContacts = await Promise.all(
    contactLinks.map(async (link) => {
      return db.query.contactsTable.findFirst({
        where: and(eq(contactsTable.id, link.contactId), eq(contactsTable.status, "pending")),
      });
    })
  );

  const nextContact = pendingContacts.find(c => c != null);

  if (!nextContact) {
    await db.update(campaignsTable)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(campaignsTable.id, campaign.id));
    res.json({ done: true, message: "All contacts have been called. Campaign marked as completed." });
    return;
  }

  const agentConfig = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });

  if (!agentConfig?.twilioAccountSid || !agentConfig?.twilioAuthToken || !agentConfig?.phoneNumber) {
    res.status(400).json({ error: "Twilio not fully configured. Check AI Agent settings." });
    return;
  }

  const baseUrl = getBaseUrl(req);
  const client = getTwilioClient(agentConfig.twilioAccountSid, agentConfig.twilioAuthToken);

  const [callLog] = await db.insert(callLogsTable).values({
    userId,
    contactId: nextContact.id,
    campaignId: campaign.id,
    direction: "outbound",
    phone: nextContact.phone,
    outcome: "no_answer",
    aiModel: agentConfig.aiModel || "gpt-4o-mini",
    startedAt: new Date(),
  }).returning();

  await db.update(contactsTable)
    .set({ status: "called", lastCalledAt: new Date(), updatedAt: new Date() })
    .where(eq(contactsTable.id, nextContact.id));

  await db.update(campaignsTable)
    .set({ calledCount: campaign.calledCount + 1, updatedAt: new Date() })
    .where(eq(campaignsTable.id, campaign.id));

  const call = await client.calls.create({
    to: nextContact.phone,
    from: agentConfig.phoneNumber,
    url: `${baseUrl}/api/twilio/outbound-voice?callLogId=${callLog.id}&userId=${userId}`,
    statusCallback: `${baseUrl}/api/twilio/status?callLogId=${callLog.id}`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
    machineDetection: "Enable",
    asyncAmd: "true",
  });

  res.json({
    callSid: call.sid,
    callLogId: callLog.id,
    contact: { id: nextContact.id, phone: nextContact.phone, firstName: nextContact.firstName, lastName: nextContact.lastName },
    remaining: pendingContacts.filter(c => c != null).length - 1,
  });
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

export default router;
