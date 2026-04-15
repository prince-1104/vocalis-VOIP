import { Router, type IRouter } from "express";
import twilio from "twilio";
import { db, agentConfigsTable, callLogsTable, trainingDataTable, callingScriptsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";

const router: IRouter = Router();

function getBaseUrl(req: any): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    const first = domains.split(",")[0].trim();
    return `https://${first}`;
  }
  const host = req.headers.host || "localhost";
  return `https://${host}`;
}

const KB_ENTRY_MAX_CHARS = 300;
const KB_MAX_ENTRIES = 6;

async function buildSystemPrompt(userId: number, agentConfig: any): Promise<string> {
  const [trainingData, scripts] = await Promise.all([
    db.select().from(trainingDataTable).where(eq(trainingDataTable.userId, userId)).limit(KB_MAX_ENTRIES),
    db.select().from(callingScriptsTable).where(and(eq(callingScriptsTable.userId, userId), eq(callingScriptsTable.isDefault, true))).limit(1),
  ]);

  let system = `You are ${agentConfig.agentName || "SalesBot"}, an AI sales representative`;
  if (agentConfig.personality) system += ` with a ${agentConfig.personality} personality`;
  system += `. You are on a live phone call. Keep ALL responses under 2 sentences — be direct and conversational. Never mention you are an AI unless directly asked.\n\n`;

  if (trainingData.length > 0) {
    system += `KNOWLEDGE BASE (use this to answer questions):\n`;
    for (const td of trainingData) {
      const snippet = td.content.length > KB_ENTRY_MAX_CHARS
        ? td.content.slice(0, KB_ENTRY_MAX_CHARS).trimEnd() + "…"
        : td.content;
      system += `• [${td.type.replace(/_/g, " ").toUpperCase()}] ${td.title}: ${snippet}\n`;
    }
    system += "\n";
  }

  if (scripts.length > 0) {
    const script = scripts[0];
    system += `CALL SCRIPT:\n`;
    system += `Opening: "${script.openingLine}"\n`;
    if (script.pitchPoints && Array.isArray(script.pitchPoints) && (script.pitchPoints as string[]).length > 0) {
      system += `Key points: ${(script.pitchPoints as string[]).slice(0, 3).join(" | ")}\n`;
    }
    if (script.closingLine) system += `Closing: "${script.closingLine}"\n`;
    system += "\n";
  }

  system += `After each response, ask one concise follow-up question to keep the conversation moving forward.`;
  return system;
}

async function generateAIResponse(systemPrompt: string, history: {role: string, content: string}[], userMessage: string, model = "gpt-4o-mini"): Promise<string> {
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const response = await openai.chat.completions.create({
    model,
    max_completion_tokens: 150,
    messages,
  });

  return response.choices[0]?.message?.content || "I'm sorry, I didn't catch that. Could you repeat that?";
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.60 },
  "gpt-4o":      { input: 2.50, output: 10.00 },
  "gpt-5.2":     { input: 15.00, output: 60.00 },
};

function computeCallCost(durationSeconds: number, direction: string, model: string) {
  const minutes = Math.max(1, Math.ceil(durationSeconds / 60));
  const twilioBaseRate = direction === "outbound" ? 0.013 : 0.022;
  const twilioSpeechRate = 0.04;
  const twilioCost = minutes * (twilioBaseRate + twilioSpeechRate);

  const estimatedTurns = Math.max(1, Math.round(durationSeconds / 25));
  const inputTokens = estimatedTurns * 400;
  const outputTokens = estimatedTurns * 50;
  const pricing = MODEL_PRICING[model] || MODEL_PRICING["gpt-4o-mini"];
  const openaiCost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

  return {
    twilioCost: parseFloat(twilioCost.toFixed(6)),
    openaiCost: parseFloat(openaiCost.toFixed(6)),
    totalCost: parseFloat((twilioCost + openaiCost).toFixed(6)),
    twilioMinutes: minutes,
  };
}

async function resolveUserByPhone(toPhone: string): Promise<number | null> {
  if (toPhone) {
    const config = await db.select().from(agentConfigsTable).where(eq(agentConfigsTable.phoneNumber, toPhone)).limit(1);
    if (config.length > 0) return config[0].userId;
  }
  return null;
}

async function resolveUserFromCallLog(callLogId: string): Promise<number | null> {
  if (!callLogId) return null;
  const id = parseInt(callLogId, 10);
  if (isNaN(id)) return null;
  const log = await db.query.callLogsTable.findFirst({ where: eq(callLogsTable.id, id) });
  return log?.userId ?? null;
}

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

router.post("/twilio/inbound", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const userId = await resolveUserByPhone(req.body.To);
  if (!userId) {
    twiml.say("We're sorry, this number is not configured. Goodbye.");
    res.type("text/xml");
    res.send(twiml.toString());
    return;
  }

  const agentConfig = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });

  const greeting = agentConfig?.greeting || "Hi, thank you for calling. How can I help you today?";
  const baseUrl = getBaseUrl(req);

  const [callLog] = await db.insert(callLogsTable).values({
    userId,
    direction: "inbound",
    phone: req.body.From || "unknown",
    outcome: "answered",
    aiModel: agentConfig?.aiModel || "gpt-4o-mini",
    startedAt: new Date(),
  }).returning();

  const gather = twiml.gather({
    input: ["speech"],
    action: `${baseUrl}/api/twilio/voice?callLogId=${callLog.id}&history=`,
    method: "POST",
    speechTimeout: "auto",
    timeout: 10,
    language: agentConfig?.language || "en-US",
    actionOnEmptyResult: true,
  });

  gather.say({ voice: mapVoice(agentConfig?.voice), language: agentConfig?.language || "en-US" }, greeting);

  twiml.redirect({ method: "POST" }, `${baseUrl}/api/twilio/voice?callLogId=${callLog.id}&history=&silent=1`);

  res.type("text/xml");
  res.send(twiml.toString());
});

router.post("/twilio/voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callLogId = req.query.callLogId as string;

  const userId = await resolveUserFromCallLog(callLogId);
  if (!userId) {
    twiml.say("This call session is no longer active. Goodbye.");
    res.type("text/xml");
    res.send(twiml.toString());
    return;
  }

  const speechResult = req.body.SpeechResult || req.body.Digits || "";
  const rawHistory = req.query.history as string || "";
  const isSilent = req.query.silent === "1";

  const history: {role: string, content: string}[] = [];
  if (rawHistory) {
    try {
      const decoded = decodeURIComponent(rawHistory);
      const parsed = JSON.parse(decoded);
      if (Array.isArray(parsed)) history.push(...parsed);
    } catch { }
  }

  const agentConfig = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });
  const baseUrl = getBaseUrl(req);
  const voice = mapVoice(agentConfig?.voice);
  const lang = agentConfig?.language || "en-US";
  const aiModel = agentConfig?.aiModel || "gpt-4o-mini";

  let aiResponse: string;

  if (isSilent || !speechResult.trim()) {
    aiResponse = "I didn't quite catch that. Are you still there? Please go ahead and speak.";
  } else {
    const systemPrompt = await buildSystemPrompt(userId, agentConfig || {});
    try {
      aiResponse = await generateAIResponse(systemPrompt, history, speechResult, aiModel);
    } catch (err) {
      console.error("AI response error:", err);
      aiResponse = "I'm sorry, I had a technical issue. Could you please repeat that?";
    }
  }

  const newHistory = isSilent
    ? history
    : [...history, { role: "user", content: speechResult }, { role: "assistant", content: aiResponse }];
  const encodedHistory = encodeURIComponent(JSON.stringify(newHistory.slice(-4)));

  const gather = twiml.gather({
    input: ["speech"],
    action: `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&history=${encodedHistory}`,
    method: "POST",
    speechTimeout: "auto",
    timeout: 10,
    language: lang,
    actionOnEmptyResult: true,
  });

  gather.say({ voice, language: lang }, aiResponse);

  twiml.redirect({ method: "POST" }, `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&history=${encodedHistory}&silent=1`);

  res.type("text/xml");
  res.send(twiml.toString());
});

router.post("/twilio/outbound-voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callLogId = req.query.callLogId as string;

  const userId = await resolveUserFromCallLog(callLogId);
  if (!userId) {
    twiml.say("This call session is no longer active. Goodbye.");
    res.type("text/xml");
    res.send(twiml.toString());
    return;
  }

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
    action: `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&history=`,
    method: "POST",
    speechTimeout: "auto",
    timeout: 10,
    language: lang,
    actionOnEmptyResult: true,
  });

  gather.say({ voice, language: lang }, openingLine);

  twiml.redirect({ method: "POST" }, `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&history=&silent=1`);

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
    const existingLog = await db.query.callLogsTable.findFirst({
      where: eq(callLogsTable.id, parseInt(callLogId)),
    });

    const direction = existingLog?.direction || "outbound";
    const model = existingLog?.aiModel || "gpt-4o-mini";
    const costData = callDuration > 0 ? computeCallCost(callDuration, direction, model) : null;

    await db.update(callLogsTable)
      .set({
        outcome: outcomeMap[callStatus] || "no_answer",
        duration: callDuration,
        endedAt: new Date(),
        ...(costData ? {
          estimatedCostUsd: costData.totalCost.toString(),
          twilioCostUsd: costData.twilioCost.toString(),
          openaiCostUsd: costData.openaiCost.toString(),
          twilioMinutes: costData.twilioMinutes,
        } : {}),
      })
      .where(eq(callLogsTable.id, parseInt(callLogId)));
  }

  res.status(200).send("OK");
});

export default router;
