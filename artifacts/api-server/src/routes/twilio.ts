import { Router, type IRouter } from "express";
import twilio from "twilio";
import { db, agentConfigsTable, callLogsTable, trainingDataTable, callingScriptsTable, contactsTable, campaignsTable, campaignContactsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";

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

async function buildSystemPrompt(userId: number, agentConfig: any): Promise<string> {
  const trainingData = await db.select().from(trainingDataTable).where(eq(trainingDataTable.userId, userId));
  const scripts = await db.select().from(callingScriptsTable).where(and(eq(callingScriptsTable.userId, userId), eq(callingScriptsTable.isDefault, true))).limit(1);

  let system = `You are ${agentConfig.agentName || "SalesBot"}, an AI sales representative. `;
  system += `Your personality is ${agentConfig.personality || "professional"}. `;
  system += `You are on a phone call. Keep responses concise and conversational — maximum 2-3 sentences. `;
  system += `Never say you are an AI unless directly asked. Focus on helping the prospect.\n\n`;

  if (trainingData.length > 0) {
    system += `KNOWLEDGE BASE:\n`;
    for (const td of trainingData) {
      system += `[${td.type.toUpperCase()}] ${td.title}: ${td.content}\n\n`;
    }
  }

  if (scripts.length > 0) {
    const script = scripts[0];
    system += `CALLING SCRIPT:\nOpening: ${script.openingLine}\n`;
    if (script.pitchPoints && Array.isArray(script.pitchPoints)) {
      system += `Key points: ${(script.pitchPoints as string[]).join(", ")}\n`;
    }
    if (script.closingLine) {
      system += `Closing: ${script.closingLine}\n`;
    }
  }

  system += `\nAlways end your response naturally and, if appropriate, ask a follow-up question to keep the conversation going.`;
  return system;
}

async function generateAIResponse(systemPrompt: string, history: {role: string, content: string}[], userMessage: string): Promise<string> {
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const response = await openai.chat.completions.create({
    model: "gpt-5.2",
    max_completion_tokens: 200,
    messages,
  });

  return response.choices[0]?.message?.content || "I'm sorry, I didn't catch that. Could you repeat that?";
}

async function resolveUserByPhone(toPhone: string, fallbackUserId: number): Promise<number> {
  if (toPhone) {
    const config = await db.select().from(agentConfigsTable).where(eq(agentConfigsTable.phoneNumber, toPhone)).limit(1);
    if (config.length > 0) return config[0].userId;
  }
  return fallbackUserId;
}

router.post("/twilio/inbound", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const userId = await resolveUserByPhone(req.body.To, req.userId!);
  const agentConfig = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });

  const greeting = agentConfig?.greeting || "Hi, thank you for calling. How can I help you today?";
  const baseUrl = getBaseUrl(req);

  const [callLog] = await db.insert(callLogsTable).values({
    userId,
    direction: "inbound",
    phone: req.body.From || "unknown",
    outcome: "answered",
    startedAt: new Date(),
  }).returning();

  const gather = twiml.gather({
    input: ["speech"],
    action: `${baseUrl}/api/twilio/voice?callLogId=${callLog.id}&userId=${userId}&history=`,
    method: "POST",
    speechTimeout: "auto",
    timeout: 10,
    language: agentConfig?.language || "en-US",
    actionOnEmptyResult: true,
  });

  gather.say({ voice: mapVoice(agentConfig?.voice), language: agentConfig?.language || "en-US" }, greeting);

  twiml.redirect({ method: "POST" }, `${baseUrl}/api/twilio/voice?callLogId=${callLog.id}&userId=${userId}&history=&silent=1`);

  res.type("text/xml");
  res.send(twiml.toString());
});

router.post("/twilio/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const userId = req.query.userId ? parseInt(req.query.userId as string) : req.userId!;

  const speechResult = req.body.SpeechResult || req.body.Digits || "";
  const callLogId = req.query.callLogId as string;
  const rawHistory = req.query.history as string || "";
  const isSilent = req.query.silent === "1";

  const history: {role: string, content: string}[] = [];
  if (rawHistory) {
    try {
      const decoded = decodeURIComponent(rawHistory);
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed)) history.push(...parsed);
    } catch { /* ignore */ }
  }

  const agentConfig = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });
  const baseUrl = getBaseUrl(req);
  const voice = mapVoice(agentConfig?.voice);
  const lang = agentConfig?.language || "en-US";

  let aiResponse: string;

  if (isSilent || !speechResult.trim()) {
    aiResponse = "I didn't quite catch that. Are you still there? Please go ahead and speak.";
  } else {
    const systemPrompt = await buildSystemPrompt(userId, agentConfig || {});
    try {
      aiResponse = await generateAIResponse(systemPrompt, history, speechResult);
    } catch (err) {
      console.error("AI response error:", err);
      aiResponse = "I'm sorry, I had a technical issue. Could you please repeat that?";
    }
  }

  const newHistory = isSilent
    ? history
    : [...history, { role: "user", content: speechResult }, { role: "assistant", content: aiResponse }];
  const encodedHistory = encodeURIComponent(JSON.stringify(newHistory.slice(-10)));

  const gather = twiml.gather({
    input: ["speech"],
    action: `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&userId=${userId}&history=${encodedHistory}`,
    method: "POST",
    speechTimeout: "auto",
    timeout: 10,
    language: lang,
    actionOnEmptyResult: true,
  });

  gather.say({ voice, language: lang }, aiResponse);

  twiml.redirect({ method: "POST" }, `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&userId=${userId}&history=${encodedHistory}&silent=1`);

  res.type("text/xml");
  res.send(twiml.toString());
});

router.post("/twilio/outbound-voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const userId = req.userId!;

  const callLogId = req.query.callLogId as string;
  const agentConfig = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });

  const scripts = await db.select().from(callingScriptsTable).where(and(eq(callingScriptsTable.userId, userId), eq(callingScriptsTable.isDefault, true))).limit(1);

  const openingLine = scripts.length > 0
    ? scripts[0].openingLine
    : agentConfig?.greeting || "Hi, I'm calling on behalf of our company. Is this a good time to speak?";

  const baseUrl = getBaseUrl(req);

  const voice = mapVoice(agentConfig?.voice);
  const lang = agentConfig?.language || "en-US";

  const gather = twiml.gather({
    input: ["speech"],
    action: `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&userId=${userId}&history=`,
    method: "POST",
    speechTimeout: "auto",
    timeout: 10,
    language: lang,
    actionOnEmptyResult: true,
  });

  gather.say({ voice, language: lang }, openingLine);

  twiml.redirect({ method: "POST" }, `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&userId=${userId}&history=&silent=1`);

  res.type("text/xml");
  res.send(twiml.toString());
});

router.post("/twilio/status", async (req, res) => {
  const callLogId = req.query.callLogId as string;
  const callStatus = req.body.CallStatus;
  const callDuration = parseInt(req.body.CallDuration || "0");

  const outcomeMap: Record<string, string> = {
    completed: "answered",
    "no-answer": "no_answer",
    busy: "busy",
    failed: "no_answer",
    canceled: "no_answer",
  };

  if (callLogId) {
    await db.update(callLogsTable)
      .set({
        outcome: outcomeMap[callStatus] || "no_answer",
        duration: callDuration,
        endedAt: new Date(),
      })
      .where(eq(callLogsTable.id, parseInt(callLogId)));
  }

  res.status(200).send("OK");
});

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
    startedAt: new Date(),
  }).returning();

  await db.update(contactsTable)
    .set({ status: "called", lastCalledAt: new Date(), updatedAt: new Date() })
    .where(eq(contactsTable.id, contact.id));

  const call = await client.calls.create({
    to: contact.phone,
    from: agentConfig.phoneNumber,
    url: `${baseUrl}/api/twilio/outbound-voice?callLogId=${callLog.id}`,
    statusCallback: `${baseUrl}/api/twilio/status?callLogId=${callLog.id}`,
    statusCallbackMethod: "POST",
    statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
    machineDetection: "Enable",
    asyncAmd: "true",
  });

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
    url: `${baseUrl}/api/twilio/outbound-voice?callLogId=${callLog.id}`,
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

function mapVoice(voice?: string | null): string {
  const voiceMap: Record<string, string> = {
    alloy: "Polly.Joanna",
    echo: "Polly.Matthew",
    fable: "Polly.Brian",
    onyx: "Polly.Joey",
    nova: "Polly.Salli",
    shimmer: "Polly.Kimberly",
  };
  return voiceMap[voice || "nova"] || "Polly.Salli";
}

export default router;
