import { Router, type IRouter } from "express";
import { db, agentConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { randomUUID } from "crypto";

const router: IRouter = Router();

const VALID_MODELS = [
  "gemini-1.5-pro",
  "llama-3.3-8b-private",
  "bharatgpt",
  "bolna-ai",
  "deepseek-v3",
  "sarvam-1-2b",
];

const VALID_PROVIDERS = ["twilio", "gupshup", "exotel", "plivo", "custom"];

function maskConfig(config: any, isSuperadmin: boolean) {
  return {
    ...config,
    twilioAccountSid: isSuperadmin ? config.twilioAccountSid : (config.twilioAccountSid ? "***configured***" : null),
    twilioAuthToken: isSuperadmin ? config.twilioAuthToken : (config.twilioAuthToken ? "***" : null),
    telephonyApiKey: isSuperadmin ? config.telephonyApiKey : (config.telephonyApiKey ? "***configured***" : null),
    telephonyApiSecret: isSuperadmin ? config.telephonyApiSecret : (config.telephonyApiSecret ? "***" : null),
    twilioConfigured: !!(config.twilioAccountSid && config.twilioAuthToken),
    byocConfigured: config.telephonyProvider !== "twilio" && !!(config.telephonyApiKey),
  };
}

router.get("/agents", async (req, res) => {
  const userId = req.userId!;
  let config = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });

  if (!config) {
    const [newConfig] = await db.insert(agentConfigsTable).values({
      userId,
      agentName: "SalesBot",
      voice: "nova",
      personality: "professional",
      greeting: "Hi, this is SalesBot calling on behalf of [Business Name]. Is this a good time to speak?",
      voicemailMessage: "Hi, this is a message for [Name]. Please call us back at your earliest convenience. Thank you!",
      telephonyProvider: "twilio",
      widgetEnabled: false,
      widgetApiKey: randomUUID(),
    }).returning();
    config = newConfig;
  } else if (!config.widgetApiKey) {
    const [updated] = await db.update(agentConfigsTable)
      .set({ widgetApiKey: randomUUID(), updatedAt: new Date() })
      .where(eq(agentConfigsTable.userId, userId))
      .returning();
    config = updated;
  }

  res.json(maskConfig(config, req.isSuperadmin!));
});

router.put("/agents", async (req, res) => {
  const userId = req.userId!;
  const {
    agentName, voice, language,
    phoneNumber, twilioAccountSid, twilioAuthToken,
    telephonyProvider, telephonyProviderName, telephonyApiKey, telephonyApiSecret, telephonyAppId,
    greeting, personality, maxCallDuration, voicemailMessage, businessHoursOnly, aiModel,
    widgetEnabled, widgetCampaignId,
  } = req.body;

  const updateData: any = { updatedAt: new Date() };

  if (agentName !== undefined) updateData.agentName = agentName;
  if (voice !== undefined) updateData.voice = voice;
  if (language !== undefined) updateData.language = language;
  if (greeting !== undefined) updateData.greeting = greeting;
  if (personality !== undefined) updateData.personality = personality;
  if (maxCallDuration !== undefined) updateData.maxCallDuration = maxCallDuration;
  if (voicemailMessage !== undefined) updateData.voicemailMessage = voicemailMessage;
  if (businessHoursOnly !== undefined) updateData.businessHoursOnly = businessHoursOnly;
  if (aiModel !== undefined && VALID_MODELS.includes(aiModel)) updateData.aiModel = aiModel;

  if (widgetEnabled !== undefined) updateData.widgetEnabled = widgetEnabled;
  if (widgetCampaignId !== undefined) updateData.widgetCampaignId = widgetCampaignId === null ? null : Number(widgetCampaignId);

  if (req.isSuperadmin) {
    if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber;
    if (twilioAccountSid !== undefined) updateData.twilioAccountSid = twilioAccountSid;
    if (twilioAuthToken !== undefined && twilioAuthToken !== "***") updateData.twilioAuthToken = twilioAuthToken;
    if (telephonyProvider !== undefined && VALID_PROVIDERS.includes(telephonyProvider)) updateData.telephonyProvider = telephonyProvider;
    if (telephonyProviderName !== undefined) updateData.telephonyProviderName = telephonyProviderName;
    if (telephonyApiKey !== undefined && telephonyApiKey !== "***configured***") updateData.telephonyApiKey = telephonyApiKey;
    if (telephonyApiSecret !== undefined && telephonyApiSecret !== "***") updateData.telephonyApiSecret = telephonyApiSecret;
    if (telephonyAppId !== undefined) updateData.telephonyAppId = telephonyAppId;
  } else if (phoneNumber !== undefined || twilioAccountSid !== undefined || twilioAuthToken !== undefined
    || telephonyProvider !== undefined || telephonyApiKey !== undefined || telephonyApiSecret !== undefined) {
    res.status(403).json({ error: "Only superadmin can configure telephony credentials" });
    return;
  }

  const [config] = await db.update(agentConfigsTable)
    .set(updateData)
    .where(eq(agentConfigsTable.userId, userId))
    .returning();

  if (!config) { res.status(404).json({ error: "Agent config not found" }); return; }

  res.json(maskConfig(config, req.isSuperadmin!));
});

router.post("/widget/generate-key", async (req, res) => {
  const userId = req.userId!;
  const newKey = randomUUID();
  const [updated] = await db.update(agentConfigsTable)
    .set({ widgetApiKey: newKey, updatedAt: new Date() })
    .where(eq(agentConfigsTable.userId, userId))
    .returning();
  if (!updated) { res.status(404).json({ error: "Agent config not found" }); return; }
  res.json({ widgetApiKey: updated.widgetApiKey });
});

export default router;
