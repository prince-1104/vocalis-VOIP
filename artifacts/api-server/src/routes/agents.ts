import { Router, type IRouter } from "express";
import { db, agentConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

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
    }).returning();
    config = newConfig;
  }

  res.json({
    ...config,
    twilioAccountSid: req.isSuperadmin ? config.twilioAccountSid : (config.twilioAccountSid ? "***configured***" : null),
    twilioAuthToken: req.isSuperadmin ? config.twilioAuthToken : (config.twilioAuthToken ? "***" : null),
    twilioConfigured: !!(config.twilioAccountSid && config.twilioAuthToken),
  });
});

router.put("/agents", async (req, res) => {
  const userId = req.userId!;
  const {
    agentName, voice, language, phoneNumber, twilioAccountSid, twilioAuthToken,
    greeting, personality, maxCallDuration, voicemailMessage, businessHoursOnly, aiModel
  } = req.body;

  const VALID_MODELS = ["gpt-4o-mini", "gpt-4o", "gpt-5.2"];

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

  if (req.isSuperadmin) {
    if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber;
    if (twilioAccountSid !== undefined) updateData.twilioAccountSid = twilioAccountSid;
    if (twilioAuthToken !== undefined && twilioAuthToken !== "***") updateData.twilioAuthToken = twilioAuthToken;
  } else if (phoneNumber !== undefined || twilioAccountSid !== undefined || twilioAuthToken !== undefined) {
    res.status(403).json({ error: "Only superadmin can configure telephony credentials" });
    return;
  }

  const [config] = await db.update(agentConfigsTable)
    .set(updateData)
    .where(eq(agentConfigsTable.userId, userId))
    .returning();

  if (!config) { res.status(404).json({ error: "Agent config not found" }); return; }

  res.json({
    ...config,
    twilioAccountSid: req.isSuperadmin ? config.twilioAccountSid : (config.twilioAccountSid ? "***configured***" : null),
    twilioAuthToken: req.isSuperadmin ? config.twilioAuthToken : (config.twilioAuthToken ? "***" : null),
    twilioConfigured: !!(config.twilioAccountSid && config.twilioAuthToken),
  });
});

export default router;
