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
    twilioAuthToken: config.twilioAuthToken ? "***" : undefined,
    twilioConfigured: !!(config.twilioAccountSid && config.twilioAuthToken),
  });
});

router.put("/agents", async (req, res) => {
  const userId = req.userId!;
  const {
    agentName, voice, language, phoneNumber, twilioAccountSid, twilioAuthToken,
    greeting, personality, maxCallDuration, voicemailMessage, businessHoursOnly
  } = req.body;

  const updateData: any = { updatedAt: new Date() };
  if (agentName !== undefined) updateData.agentName = agentName;
  if (voice !== undefined) updateData.voice = voice;
  if (language !== undefined) updateData.language = language;
  if (phoneNumber !== undefined) updateData.phoneNumber = phoneNumber;
  if (twilioAccountSid !== undefined) updateData.twilioAccountSid = twilioAccountSid;
  if (twilioAuthToken !== undefined) updateData.twilioAuthToken = twilioAuthToken;
  if (greeting !== undefined) updateData.greeting = greeting;
  if (personality !== undefined) updateData.personality = personality;
  if (maxCallDuration !== undefined) updateData.maxCallDuration = maxCallDuration;
  if (voicemailMessage !== undefined) updateData.voicemailMessage = voicemailMessage;
  if (businessHoursOnly !== undefined) updateData.businessHoursOnly = businessHoursOnly;

  const [config] = await db.update(agentConfigsTable)
    .set(updateData)
    .where(eq(agentConfigsTable.userId, userId))
    .returning();

  if (!config) { res.status(404).json({ error: "Agent config not found" }); return; }

  res.json({
    ...config,
    twilioAuthToken: config.twilioAuthToken ? "***" : undefined,
    twilioConfigured: !!(config.twilioAccountSid && config.twilioAuthToken),
  });
});

export default router;
