import { Router, type IRouter } from "express";
import twilio from "twilio";
import { db, agentConfigsTable, callLogsTable, trainingDataTable, callingScriptsTable, tenantsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { randomUUID } from "crypto";

const router: IRouter = Router();

const SARVAM_API_KEY = process.env.SARVAM_API_KEY ?? "";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? "";

const ttsAudioCache = new Map<string, Buffer>();
const TTS_CACHE_TTL_MS = 5 * 60 * 1000;

function storeTtsAudio(audioBase64: string): string {
  const id = randomUUID();
  const buf = Buffer.from(audioBase64, "base64");
  ttsAudioCache.set(id, buf);
  setTimeout(() => ttsAudioCache.delete(id), TTS_CACHE_TTL_MS);
  return id;
}

router.get("/twilio/tts-audio/:id", (req, res) => {
  const buf = ttsAudioCache.get(req.params.id);
  if (!buf) {
    res.status(404).send("Not found");
    return;
  }
  ttsAudioCache.delete(req.params.id);
  res.set("Content-Type", "audio/wav");
  res.set("Content-Length", String(buf.length));
  res.send(buf);
});

router.get("/twilio/tts-audio-mp3/:id", (req, res) => {
  const buf = ttsAudioCache.get(req.params.id);
  if (!buf) {
    res.status(404).send("Not found");
    return;
  }
  ttsAudioCache.delete(req.params.id);
  res.set("Content-Type", "audio/mpeg");
  res.set("Content-Length", String(buf.length));
  res.send(buf);
});

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

const SUPPORTED_LANGUAGES_LINE =
  "You support these languages and MUST be able to converse in any of them: English (en-US), Hindi (hi-IN), Kannada (kn-IN), Tamil (ta-IN), Telugu (te-IN), and Marathi (mr-IN). NEVER tell the caller you only speak English or Hindi. If the caller asks for Kannada / Tamil / Telugu / Marathi, switch to that language immediately and continue the entire conversation in it.";

function buildRomanizedScriptInstruction(language?: string | null): string {
  if (language === "hi-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Hindi using only English letters (romanized Hindi / Hinglish). Never use Devanagari or Urdu script.";
  }
  if (language === "kn-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Kannada using only English letters (romanized Kannada). Never use Kannada script.";
  }
  if (language === "ta-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Tamil using only English letters (romanized Tamil). Never use Tamil script.";
  }
  if (language === "te-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Telugu using only English letters (romanized Telugu). Never use Telugu script.";
  }
  if (language === "mr-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Marathi using only English letters (romanized Marathi). Never use Devanagari script.";
  }
  if (language === "auto") {
    return "CRITICAL SCRIPT RULE: Detect the user's language. If they use Hindi / Kannada / Tamil / Telugu / Marathi, reply in that language but ONLY in English letters (romanized). Never use Devanagari, Kannada, Tamil, Telugu, or Urdu script.";
  }
  return "";
}

async function buildSystemPrompt(userId: number, agentConfig: any): Promise<string> {
  const [trainingData, scripts] = await Promise.all([
    db.select().from(trainingDataTable).where(eq(trainingDataTable.userId, userId)).limit(KB_MAX_ENTRIES),
    db.select().from(callingScriptsTable).where(and(eq(callingScriptsTable.userId, userId), eq(callingScriptsTable.isDefault, true))).limit(1),
  ]);

  let system = `You are ${agentConfig.agentName || "SalesBot"}, an AI sales representative`;
  if (agentConfig.personality) system += ` with a ${agentConfig.personality} personality`;
  system += `. You are on a live phone call. Keep ALL responses under 2 sentences — be direct and conversational. Never mention you are an AI unless directly asked.\n\n`;

  system += `${SUPPORTED_LANGUAGES_LINE}\n\n`;

  if (agentConfig.language === "auto") {
    system += `CRITICAL INSTRUCTION: Automatically detect the language the user is speaking. You MUST reply in the exact same language they used. Do NOT default to English if they speak another language.\n\n`;
  }

  const scriptRule = buildRomanizedScriptInstruction(agentConfig.language);
  if (scriptRule) {
    system += `${scriptRule}\n\n`;
  }

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

async function generateOpenAITTS(text: string, voice: string = "nova"): Promise<string> {
  const mp3 = await openai.audio.speech.create({
    model: "tts-1",
    voice: voice as any,
    input: text,
  });
  const arrayBuffer = await mp3.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  return buffer.toString("base64");
}

const INDIAN_LANGUAGES = new Set(["kn-IN", "hi-IN", "ta-IN", "te-IN", "mr-IN"]);

function isIndianLanguage(lang?: string | null): boolean {
  return INDIAN_LANGUAGES.has(lang ?? "");
}

function getTwilioLang(lang?: string | null): string {
  if (lang === "auto") return "en-IN";
  return lang || "en-US";
}

function resolveSplitModelLLM(lang: string): "deepseek-chat" | "sarvam-m" {
  if (lang === "hi-IN") return "deepseek-chat";
  return "sarvam-m";
}

async function callSarvamSTT(audioBuffer: Buffer, mimeType: string, lang: string): Promise<string> {
  const formData = new FormData();
  const blob = new Blob([new Uint8Array(audioBuffer)], { type: mimeType });
  formData.append("file", blob, "audio.wav");
  formData.append("model", "saaras:v3");
  formData.append("language_code", lang);
  formData.append("mode", "transcribe");

  const res = await fetch("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: {
      "api-subscription-key": SARVAM_API_KEY,
    },
    body: formData,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sarvam STT error ${res.status}: ${errText}`);
  }

  const data = await res.json() as any;
  return data.transcript ?? "";
}

async function callDeepSeekLLM(
  systemPrompt: string,
  history: {role: string, content: string}[],
  userMessage: string,
): Promise<string> {
  if (!DEEPSEEK_API_KEY) throw new Error("DEEPSEEK_API_KEY not configured — Hindi calls require DeepSeek V3.2");

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages,
      max_tokens: 150,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DeepSeek V3.2 API error ${res.status}: ${text}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content ?? "मुझे समझ नहीं आया, क्या आप दोबारा बोल सकते हैं?";
}

async function callSarvamLLM(
  systemPrompt: string,
  history: {role: string, content: string}[],
  userMessage: string,
): Promise<string> {
  if (!SARVAM_API_KEY) throw new Error("SARVAM_API_KEY not configured");

  const messages = [
    { role: "system", content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SARVAM_API_KEY}`,
    },
    body: JSON.stringify({
      model: "sarvam-m",
      messages,
      max_completion_tokens: 150,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sarvam-M (Sarvam-1 2B family) API error ${res.status}: ${text}`);
  }

  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content ?? "ಮತ್ತೊಮ್ಮೆ ಹೇಳುತ್ತೀರಾ?";
}

const BULBUL_VOICE_FOR_LANG: Record<string, string> = {
  "hi-IN": "kavya",
  "kn-IN": "kavya",
  "ta-IN": "priya",
  "te-IN": "pooja",
  "mr-IN": "simran",
};

async function callSarvamTTS(text: string, lang: string): Promise<string | null> {
  if (!SARVAM_API_KEY) return null;

  const speaker = BULBUL_VOICE_FOR_LANG[lang] ?? "kavya";

  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": SARVAM_API_KEY,
    },
    body: JSON.stringify({
      inputs: [text],
      target_language_code: lang,
      speaker,
      model: "bulbul:v3",
      pace: 1.0,
      speech_sample_rate: 8000,
      enable_preprocessing: true,
      output_audio_codec: "wav",
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Sarvam Bulbul v3 TTS error ${res.status}: ${errText}`);
  }

  const data = await res.json() as any;
  const audioBase64: string | undefined = data.audios?.[0];
  if (!audioBase64) return null;
  return storeTtsAudio(audioBase64);
}

async function generateAIResponseIndic(
  systemPrompt: string,
  history: {role: string, content: string}[],
  userMessage: string,
  lang: string,
  baseUrl: string,
): Promise<{ text: string; ttsAudioId: string | null }> {
  const llm = resolveSplitModelLLM(lang);

  console.log(`[split-model] STT=saaras:v3 (via Twilio <Gather> transcript) lang=${lang} LLM=${llm} TTS=bulbul:v3`);

  let text: string;
  if (lang === "hi-IN") {
    text = await callDeepSeekLLM(systemPrompt, history, userMessage);
  } else {
    text = await callSarvamLLM(systemPrompt, history, userMessage);
  }

  let ttsAudioId: string | null = null;
  try {
    ttsAudioId = await callSarvamTTS(text, lang);
  } catch (ttsErr) {
    console.error("[split-model] Sarvam Bulbul TTS failed, falling back to Twilio <Say>:", ttsErr);
  }

  return { text, ttsAudioId };
}

async function renderPromptAudioForCall(
  text: string,
  lang: string,
  voice: string,
): Promise<{ ttsAudioId: string | null; useMp3: boolean }> {
  if (isIndianLanguage(lang)) {
    try {
      const sarvamTtsId = await callSarvamTTS(text, lang);
      if (sarvamTtsId) {
        return { ttsAudioId: sarvamTtsId, useMp3: false };
      }
    } catch (err) {
      console.error("[call-audio] Sarvam greeting TTS failed:", err);
    }
  }

  if (lang === "auto") {
    try {
      const b64 = await generateOpenAITTS(text, voice || "nova");
      const ttsId = storeTtsAudio(b64);
      return { ttsAudioId: ttsId, useMp3: true };
    } catch (err) {
      console.error("[call-audio] OpenAI greeting TTS failed:", err);
    }
  }

  return { ttsAudioId: null, useMp3: false };
}

const OPENAI_MODEL_MAP: Record<string, string> = {
  "gpt-4o-mini":          "gpt-4o-mini",
  "gpt-4o":               "gpt-4o",
  "gpt-5.2":              "gpt-4o",
  "gemini-1.5-pro":       "gpt-4o-mini",
  "llama-3.3-8b-private": "gpt-4o-mini",
  "bharatgpt":            "gpt-4o-mini",
  "bolna-ai":             "gpt-4o-mini",
};

const INDIC_UI_MODEL_MAP: Record<string, { provider: "deepseek" | "sarvam"; apiModel: string }> = {
  "deepseek-v3":  { provider: "deepseek", apiModel: "deepseek-chat" },
  "sarvam-1-2b":  { provider: "sarvam",   apiModel: "sarvam-m" },
};

function resolveOpenAIModel(model?: string | null): string {
  return OPENAI_MODEL_MAP[model ?? ""] ?? "gpt-4o-mini";
}

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini":   { input: 0.15,  output: 0.60 },
  "gpt-4o":        { input: 2.50,  output: 10.00 },
  "gpt-5.2":       { input: 15.00, output: 60.00 },
  "deepseek-chat": { input: 0.27,  output: 1.10 },
  "sarvam-m":      { input: 0.10,  output: 0.30 },
};

const SARVAM_TTS_COST_PER_1K_CHARS = 0.006;
const SARVAM_TTS_ESTIMATED_CHARS_PER_TURN = 200;

function computeCallCost(durationSeconds: number, direction: string, model: string, language?: string | null) {
  const minutes = Math.max(1, Math.ceil(durationSeconds / 60));
  const twilioBaseRate = direction === "outbound" ? 0.013 : 0.022;
  const twilioSpeechRate = 0.04;
  const twilioCost = minutes * (twilioBaseRate + twilioSpeechRate);

  const estimatedTurns = Math.max(1, Math.round(durationSeconds / 25));
  const inputTokens = estimatedTurns * 400;
  const outputTokens = estimatedTurns * 50;

  let llmCost: number;
  const isIndic = isIndianLanguage(language);

  if (isIndic && language === "hi-IN") {
    // Hindi: DeepSeek LLM + Sarvam Bulbul TTS (both are invoked at runtime)
    const pricing = MODEL_PRICING["deepseek-chat"];
    const deepseekCost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
    const ttsCost = (estimatedTurns * SARVAM_TTS_ESTIMATED_CHARS_PER_TURN * SARVAM_TTS_COST_PER_1K_CHARS) / 1_000;
    llmCost = deepseekCost + ttsCost;
  } else if (isIndic) {
    // Other Indian languages: Sarvam LLM + Sarvam Bulbul TTS
    const pricing = MODEL_PRICING["sarvam-m"];
    const llmOnlyCost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
    const ttsCost = (estimatedTurns * SARVAM_TTS_ESTIMATED_CHARS_PER_TURN * SARVAM_TTS_COST_PER_1K_CHARS) / 1_000;
    llmCost = llmOnlyCost + ttsCost;
  } else {
    const pricing = MODEL_PRICING[model] || MODEL_PRICING["gpt-4o-mini"];
    llmCost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  }

  return {
    twilioCost: parseFloat(twilioCost.toFixed(6)),
    llmCost: parseFloat(llmCost.toFixed(6)),
    totalCost: parseFloat((twilioCost + llmCost).toFixed(6)),
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
    language: getTwilioLang(agentConfig?.language) as any,
    actionOnEmptyResult: true,
  });

  const initialLang = agentConfig?.language || "en-US";
  const initialVoice = agentConfig?.voice || "nova";
  const initialAudio = await renderPromptAudioForCall(greeting, initialLang, initialVoice);
  if (initialAudio.ttsAudioId) {
    gather.play(`${baseUrl}/api/twilio/${initialAudio.useMp3 ? "tts-audio-mp3" : "tts-audio"}/${initialAudio.ttsAudioId}`);
  } else {
    gather.say({ voice: mapVoice(initialVoice) as any, language: getTwilioLang(initialLang) as any }, greeting);
  }

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
  let ttsAudioId: string | null = null;

  if (isSilent || !speechResult.trim()) {
    aiResponse = "I didn't quite catch that. Are you still there? Please go ahead and speak.";
  } else if (isIndianLanguage(lang)) {
    const encodedSpeech = encodeURIComponent(speechResult);
    const encodedHistory = encodeURIComponent(JSON.stringify(history.slice(-4)));
    twiml.say({ language: "en-US", voice: "Polly.Raveena" }, "One moment please.");
    twiml.redirect({ method: "POST" }, `${baseUrl}/api/twilio/voice-indic?callLogId=${callLogId}&history=${encodedHistory}&speech=${encodedSpeech}`);
    res.type("text/xml");
    res.send(twiml.toString());
    return;
  } else {
    const systemPrompt = await buildSystemPrompt(userId, agentConfig || {});
    try {
      aiResponse = await generateAIResponse(systemPrompt, history, speechResult, resolveOpenAIModel(aiModel));
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
    language: getTwilioLang(lang) as any,
    actionOnEmptyResult: true,
  });

  if (!ttsAudioId && lang === "auto") {
    try {
      const b64 = await generateOpenAITTS(aiResponse, agentConfig?.voice || "nova");
      ttsAudioId = storeTtsAudio(b64);
    } catch (e) {
      console.error("OpenAI TTS err:", e);
    }
  }

  if (ttsAudioId) {
    gather.play(`${baseUrl}/api/twilio/${lang === "auto" ? "tts-audio-mp3" : "tts-audio"}/${ttsAudioId}`);
  } else {
    gather.say({ voice: voice as any, language: getTwilioLang(lang) as any }, aiResponse);
  }

  twiml.redirect({ method: "POST" }, `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&history=${encodedHistory}&silent=1`);

  res.type("text/xml");
  res.send(twiml.toString());
});

router.post("/twilio/voice-indic", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const callLogId = req.query.callLogId as string;

  const userId = await resolveUserFromCallLog(callLogId);
  if (!userId) {
    twiml.say("This call session is no longer active. Goodbye.");
    res.type("text/xml");
    res.send(twiml.toString());
    return;
  }

  const speechResult = decodeURIComponent((req.query.speech as string) || "");
  const rawHistory = req.query.history as string || "";

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

  let aiResponse: string;
  let ttsAudioId: string | null = null;

  if (!speechResult.trim()) {
    aiResponse = "I didn't quite catch that. Are you still there? Please go ahead and speak.";
  } else {
    const systemPrompt = await buildSystemPrompt(userId, agentConfig || {});
    try {
      const indicResult = await generateAIResponseIndic(systemPrompt, history, speechResult, lang, baseUrl);
      aiResponse = indicResult.text;
      ttsAudioId = indicResult.ttsAudioId;
    } catch (err) {
      console.error("[voice-indic] AI response error:", err);
      aiResponse = "I'm sorry, I had a technical issue. Could you please repeat that?";
    }
  }

  const newHistory = [...history, { role: "user", content: speechResult }, { role: "assistant", content: aiResponse }];
  const encodedHistory = encodeURIComponent(JSON.stringify(newHistory.slice(-4)));

  const gather = twiml.gather({
    input: ["speech"],
    action: `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&history=${encodedHistory}`,
    method: "POST",
    speechTimeout: "auto",
    timeout: 10,
    language: getTwilioLang(lang) as any,
    actionOnEmptyResult: true,
  });

  if (ttsAudioId) {
    gather.play(`${baseUrl}/api/twilio/tts-audio/${ttsAudioId}`);
  } else {
    gather.say({ voice: voice as any, language: getTwilioLang(lang) as any }, aiResponse);
  }

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
    language: getTwilioLang(lang) as any,
    actionOnEmptyResult: true,
  });

  const openingAudio = await renderPromptAudioForCall(openingLine, lang, agentConfig?.voice || "nova");
  if (openingAudio.ttsAudioId) {
    gather.play(`${baseUrl}/api/twilio/${openingAudio.useMp3 ? "tts-audio-mp3" : "tts-audio"}/${openingAudio.ttsAudioId}`);
  } else {
    gather.say({ voice: voice as any, language: getTwilioLang(lang) as any }, openingLine);
  }

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

    let language: string | null = null;
    let commissionPct = 0;
    if (existingLog) {
      const [agentConf, tenant] = await Promise.all([
        db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, existingLog.userId) }),
        db.query.tenantsTable.findFirst({ where: eq(tenantsTable.ownerId, existingLog.userId) }),
      ]);
      language = agentConf?.language ?? null;
      if (tenant) {
        commissionPct = parseFloat(tenant.commissionPct ?? "0");
      }
    }

    const costData = callDuration > 0 ? computeCallCost(callDuration, direction, model, language) : null;

    const billedCost = costData
      ? parseFloat((costData.totalCost * (1 + commissionPct / 100)).toFixed(6))
      : null;

    await db.update(callLogsTable)
      .set({
        outcome: outcomeMap[callStatus] || "no_answer",
        duration: callDuration,
        endedAt: new Date(),
        ...(costData ? {
          estimatedCostUsd: costData.totalCost.toString(),
          billedCostUsd: billedCost !== null ? billedCost.toString() : undefined,
          twilioCostUsd: costData.twilioCost.toString(),
          openaiCostUsd: costData.llmCost.toString(),
          twilioMinutes: costData.twilioMinutes,
        } : {}),
      })
      .where(eq(callLogsTable.id, parseInt(callLogId)));
  }

  res.status(200).send("OK");
});

export default router;
