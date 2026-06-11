import { Router, type IRouter } from "express";
import twilio from "twilio";
import { db, agentConfigsTable, callLogsTable, trainingDataTable, callingScriptsTable, tenantsTable, intentTrainingTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { randomUUID } from "crypto";
import { crmEventBus } from "../lib/crm-event-bus";
import { classifyIntent, shouldTransfer, detectHumanRequest, type TransferRules } from "../lib/intent-classifier";
import { findBestAgent } from "../lib/transfer-manager";
import { logLLMCost, logTTSCost, resolveTenantIdForOwner } from "../lib/cost-logger";

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

const KB_ENTRY_MAX_CHARS = 500;
const KB_MAX_ENTRIES = 20;

const SUPPORTED_LANGUAGES_LINE =
  "You support these languages and MUST be able to converse in any of them: English (en-US), Hindi (hi-IN), Kannada (kn-IN), Tamil (ta-IN), Telugu (te-IN), and Marathi (mr-IN). NEVER tell the caller you only speak English or Hindi. If the caller asks for Kannada / Tamil / Telugu / Marathi, switch to that language immediately and continue the entire conversation in it.";

// IMPORTANT: Indian replies MUST be in NATIVE SCRIPT for correct Bulbul v3 TTS pronunciation.
// Romanized Kannada / Hindi etc. is read as English by the TTS engine and sounds wrong.
function buildScriptInstruction(language?: string | null): string {
  if (language === "hi-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Hindi using NATIVE Devanagari script (देवनागरी). Do NOT use romanized/Hinglish letters. Example: 'नमस्ते! मैं आपकी कैसे मदद कर सकता हूं?'";
  }
  if (language === "kn-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Kannada using NATIVE Kannada script (ಕನ್ನಡ ಲಿಪಿ). Do NOT romanize. Example: 'ನಮಸ್ಕಾರ! ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?'";
  }
  if (language === "ta-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Tamil using NATIVE Tamil script (தமிழ்). Do NOT romanize.";
  }
  if (language === "te-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Telugu using NATIVE Telugu script (తెలుగు). Do NOT romanize.";
  }
  if (language === "mr-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Marathi using NATIVE Devanagari script (मराठी). Do NOT romanize.";
  }
  if (language === "auto") {
    return "CRITICAL SCRIPT RULE: Detect the caller's language. Reply in their NATIVE script — Hindi → Devanagari, Kannada → ಕನ್ನಡ, Tamil → தமிழ், Telugu → తెలుగు, Marathi → मराठी. Never romanize Indian languages.";
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

  const scriptRule = buildScriptInstruction(agentConfig.language);
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

// Detect caller's language from their last utterance (used in auto mode).
// Twilio <Gather> returns transcripts in the requested language code, so we
// also accept native script in case the caller speaks Kannada/Hindi etc.
function detectCallLanguage(text: string): "en-US" | "hi-IN" | "kn-IN" | "ta-IN" | "te-IN" | "mr-IN" {
  if (!text) return "en-US";
  if (/[\u0C80-\u0CFF]/.test(text)) return "kn-IN";
  if (/[\u0B80-\u0BFF]/.test(text)) return "ta-IN";
  if (/[\u0C00-\u0C7F]/.test(text)) return "te-IN";
  if (/[\u0900-\u097F]/.test(text)) {
    if (/(आहे|नाही|पाहिजे|तुम्ही|मला)/.test(text)) return "mr-IN";
    return "hi-IN";
  }
  const lower = text.toLowerCase();
  if (/\b(namaskara|hege|maadi|maadu|nanage|nanu|beku|swalpa|thumba|kannada|kanada)\b/.test(lower)) return "kn-IN";
  if (/\b(kya|kaise|nahi|chahiye|mujhe|aap|hai|hain|hindi|bataao|samjhao)\b/.test(lower)) return "hi-IN";
  if (/\b(enna|naan|naangal|konjam|venum|irukku|tamil|tamizh)\b/.test(lower)) return "ta-IN";
  if (/\b(nenu|meeru|enti|kavali|chestunna|telugu)\b/.test(lower)) return "te-IN";
  if (/\b(mala|tula|tumhi|kasa|ahe|pahije|marathi)\b/.test(lower)) return "mr-IN";
  return "en-US";
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

// Sarvam Bulbul v3 voices, language-tuned for natural prosody.
// Kannada → "manan" is Sarvam's recommended showcase voice for clarity & accuracy.
const BULBUL_VOICE_FOR_LANG: Record<string, string> = {
  "hi-IN": "kavya",
  "kn-IN": "manan",
  "ta-IN": "priya",
  "te-IN": "pooja",
  "mr-IN": "simran",
};

// ── TTS pronunciation normalization ─────────────────────────────────────
// Sarvam Bulbul v3 reads Latin "e-Khata" as "ee-kkata". Rewrite brand
// terms to phonetically correct native-script forms per language.
const TTS_PRONUNCIATION_MAP: Record<string, Array<{ pattern: RegExp; replacement: string }>> = {
  "hi-IN": [
    { pattern: /\be[- ]?[Kk]hata\b/gi, replacement: "ई-खाता" },
    { pattern: /\be[- ]?[Kk]hataa?\b/gi, replacement: "ई-खाता" },
  ],
  "kn-IN": [
    { pattern: /\be[- ]?[Kk]hata\b/gi, replacement: "ಈ-ಖಾತಾ" },
    { pattern: /\be[- ]?[Kk]hataa?\b/gi, replacement: "ಈ-ಖಾತಾ" },
  ],
  "ta-IN": [
    { pattern: /\be[- ]?[Kk]hata\b/gi, replacement: "ஈ-காட்டா" },
  ],
  "te-IN": [
    { pattern: /\be[- ]?[Kk]hata\b/gi, replacement: "ఈ-ఖాతా" },
  ],
  "mr-IN": [
    { pattern: /\be[- ]?[Kk]hata\b/gi, replacement: "ई-खाता" },
  ],
};

function normalizeTTSPronunciation(text: string, lang: string): string {
  const rules = TTS_PRONUNCIATION_MAP[lang];
  if (!rules) return text;
  let out = text;
  for (const { pattern, replacement } of rules) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

async function callSarvamTTS(text: string, lang: string): Promise<string | null> {
  if (!SARVAM_API_KEY) return null;

  const ttsText = normalizeTTSPronunciation(text, lang);
  const speaker = BULBUL_VOICE_FOR_LANG[lang] ?? "manan";

  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": SARVAM_API_KEY,
    },
    body: JSON.stringify({
      inputs: [ttsText],
      target_language_code: lang,
      speaker,
      model: "bulbul:v3",
      // Lower temperature → deterministic, cleaner pronunciation. Bulbul v3 ignores pitch/loudness.
      temperature: 0.4,
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
  userId?: number,
): Promise<{ text: string; ttsAudioId: string | null }> {
  const llm = resolveSplitModelLLM(lang);

  console.log(`[split-model] STT=saaras:v3 (via Twilio <Gather> transcript) lang=${lang} LLM=${llm} TTS=bulbul:v3`);

  let text: string;
  if (lang === "hi-IN") {
    text = await callDeepSeekLLM(systemPrompt, history, userMessage);
  } else {
    text = await callSarvamLLM(systemPrompt, history, userMessage);
  }

  // Fire-and-forget: log LLM cost for Indic model
  if (userId) {
    resolveTenantIdForOwner(userId).then(tenantId => {
      if (!tenantId) return;
      const charsPerToken = 2; // Indic scripts are denser
      const inputChars = userMessage.length + (systemPrompt?.length ?? 0);
      const outputChars = text.length;
      return logLLMCost({
        tenantId,
        userId,
        provider: llm,
        inputTokens: Math.ceil(inputChars / charsPerToken),
        outputTokens: Math.ceil(outputChars / charsPerToken),
        context: "twilio-voice-indic",
      });
    }).catch(e => console.error("[twilio] Indic LLM cost logging error:", e));
  }

  let ttsAudioId: string | null = null;
  try {
    ttsAudioId = await callSarvamTTS(text, lang);

    // Fire-and-forget: log Sarvam TTS cost
    if (userId && ttsAudioId) {
      resolveTenantIdForOwner(userId).then(tenantId => {
        if (!tenantId) return;
        return logTTSCost({
          tenantId,
          userId,
          provider: "sarvam",
          characters: text.length,
          context: "twilio-tts-sarvam",
        });
      }).catch(e => console.error("[twilio] Sarvam TTS cost logging error:", e));
    }
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

// ── Hold Music Endpoint (zero TTS cost) ────────────────────────────────
// Twilio calls this while the caller waits in a conference for an agent.
// Uses Twilio's built-in Polly voices — included in per-minute call cost.
// The message loops automatically until the agent joins.
router.post("/twilio/hold-music", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const lang = (req.query.lang as string) || "en-IN";
  const baseUrl = getBaseUrl(req);

  // Multi-language hold messages using Twilio's Polly voices (no TTS API cost)
  const holdMessages: Record<string, { voice: string; messages: string[] }> = {
    "hi-IN": {
      voice: "Polly.Aditi",
      messages: [
        "कृपया प्रतीक्षा करें, हम आपको एक विशेषज्ञ से जोड़ रहे हैं। आपका कॉल हमारे लिए महत्वपूर्ण है।",
        "धन्यवाद आपकी प्रतीक्षा के लिए। एक प्रतिनिधि शीघ्र ही आपसे बात करेंगे।",
      ],
    },
    "kn-IN": {
      voice: "Polly.Aditi",
      messages: [
        "ದಯವಿಟ್ಟು ನಿರೀಕ್ಷಿಸಿ, ನಾವು ನಿಮ್ಮನ್ನು ತಜ್ಞರೊಂದಿಗೆ ಸಂಪರ್ಕಿಸುತ್ತಿದ್ದೇವೆ.",
        "ನಿಮ್ಮ ತಾಳ್ಮೆಗೆ ಧನ್ಯವಾದಗಳು. ಪ್ರತಿನಿಧಿ ಶೀಘ್ರದಲ್ಲಿ ನಿಮ್ಮೊಂದಿಗೆ ಮಾತನಾಡುತ್ತಾರೆ.",
      ],
    },
    "ta-IN": {
      voice: "Polly.Aditi",
      messages: [
        "தயவுசெய்து காத்திருங்கள், நாங்கள் உங்களை ஒரு நிபுணருடன் இணைக்கிறோம்.",
        "உங்கள் பொறுமைக்கு நன்றி. ஒரு பிரதிநிதி விரைவில் உங்களுடன் பேசுவார்.",
      ],
    },
    "te-IN": {
      voice: "Polly.Aditi",
      messages: [
        "దయచేసి వేచి ఉండండి, మేము మిమ్మల్ని ఒక నిపుణుడితో అనుసంధానం చేస్తున్నాము.",
        "మీ ఓపికకు ధన్యవాదాలు. ప్రతినిధి త్వరలో మీతో మాట్లాడతారు.",
      ],
    },
    "mr-IN": {
      voice: "Polly.Aditi",
      messages: [
        "कृपया प्रतीक्षा करा, आम्ही तुम्हाला तज्ञांशी जोडत आहोत.",
        "तुमच्या संयमाबद्दल धन्यवाद. प्रतिनिधी लवकरच तुमच्याशी बोलतील.",
      ],
    },
  };

  // Default English hold messages
  const config = holdMessages[lang] || {
    voice: "Polly.Raveena",
    messages: [
      "Please wait while we connect you with a specialist. Your call is in queue and will be answered shortly.",
      "Thank you for your patience. An agent will be with you shortly.",
    ],
  };

  twiml.say({ voice: config.voice as any, language: lang as any }, config.messages[0]);
  twiml.pause({ length: 8 });
  twiml.say({ voice: config.voice as any, language: lang as any }, config.messages[1]);
  twiml.pause({ length: 8 });
  // Loop: Twilio re-fetches this URL when TwiML completes
  twiml.redirect(`${baseUrl}/api/twilio/hold-music?lang=${encodeURIComponent(lang)}`);

  res.type("text/xml");
  res.send(twiml.toString());
});

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

  // ── Per-intent turn counters & human request tracking ──
  let intentTurnCounts: Record<string, number> = {};
  try {
    const raw = req.query.intentCounts as string;
    if (raw) intentTurnCounts = JSON.parse(decodeURIComponent(raw));
  } catch { }
  let humanReqCount = parseInt(req.query.humanReqCount as string) || 0;

  const agentConfig = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });
  const baseUrl = getBaseUrl(req);
  const voice = mapVoice(agentConfig?.voice);
  const configuredLang = agentConfig?.language || "en-US";
  const aiModel = agentConfig?.aiModel || "gpt-4o-mini";

  // Auto-detect language from caller speech when configured language is "auto".
  let lang = configuredLang;
  if (configuredLang === "auto" && speechResult) {
    lang = detectCallLanguage(speechResult);
    console.log(`[twilio/voice] auto-detected lang=${lang} from utterance`);
  }

  let intentResult = { intent: "general_question", confidence: 1.0, needsHuman: false };
  let intentTraining = null;

  if (!isSilent && speechResult.trim()) {
    // 1. Detect explicit "talk to human" request
    if (detectHumanRequest(speechResult)) {
      humanReqCount++;
      console.log(`[twilio/voice] Human request detected (count: ${humanReqCount})`);
    }

    // 2. Classify intent and look up intent-specific training config
    try {
      intentResult = await classifyIntent(history, speechResult);
      if (intentResult.confidence >= 0.6) {
        intentTurnCounts[intentResult.intent] = (intentTurnCounts[intentResult.intent] || 0) + 1;
      }
      
      intentTraining = await db.query.intentTrainingTable.findFirst({
        where: and(
          eq(intentTrainingTable.userId, userId),
          eq(intentTrainingTable.intent, intentResult.intent),
        ),
      });
    } catch (classifyErr) {
      console.error("[twilio/voice] Intent classification error:", classifyErr);
    }

    // 3. Check transfer rules & execute transfer if needed
    const numId = parseInt(callLogId, 10);
    if (!isNaN(numId)) {
      const logForTransfer = await db.query.callLogsTable.findFirst({ where: eq(callLogsTable.id, numId) });
      const meta = logForTransfer?.crmMetadata as Record<string, unknown> | undefined;
      const transferRules = meta?.__transferRules as TransferRules | undefined;

      // Emit intent event
      crmEventBus.emitCallEvent({
        type: "call.intent",
        callId: numId,
        callSid: logForTransfer?.callSid || undefined,
        data: {
          intent: intentResult.intent,
          confidence: intentResult.confidence,
          needsHuman: intentResult.needsHuman,
          turnCount: Math.floor((history.length + 2) / 2),
          intentTurnCounts,
          humanRequestCount: humanReqCount,
        },
        metadata: meta,
        timestamp: new Date().toISOString(),
      });

      if (transferRules) {
        const mergedRules: TransferRules = {
          ...transferRules,
          perIntentMaxTurns: {
            ...(transferRules.perIntentMaxTurns || {}),
            ...(intentTraining ? { [intentResult.intent]: intentTraining.maxTurns } : {}),
          },
        };

        const decision = shouldTransfer(
          intentResult, mergedRules, Math.floor((history.length + 2) / 2),
          intentTurnCounts, humanReqCount,
        );

        if (decision.transfer) {
          let targetPhone = intentTraining?.transferTo || transferRules.transferTo;
          let agentId = intentTraining?.crmAgentId || transferRules.crmAgentId;

          if (!targetPhone && userId) {
            const bestAgent = await findBestAgent(userId, intentResult.intent);
            if (bestAgent) {
              targetPhone = bestAgent.phone;
              agentId = bestAgent.agentId;
            }
          }

          if (targetPhone) {
            console.log(`[twilio/voice] Auto-transfer triggered: intent=${intentResult.intent} reason="${decision.reason}" target=${targetPhone}`);

            crmEventBus.emitCallEvent({
              type: "call.transferring",
              callId: numId,
              callSid: logForTransfer?.callSid || undefined,
              data: {
                transferTo: targetPhone,
                reason: decision.reason,
                intent: intentResult.intent,
                crmAgentId: agentId,
              },
              metadata: meta,
              timestamp: new Date().toISOString(),
            });

            const conferenceName = `auto-transfer-${numId}-${Date.now()}`;
            twiml.say("Let me connect you with a specialist who can help you further.");
            const dial = twiml.dial();
            dial.conference(
              {
                statusCallback: `${baseUrl}/api/crm/conference-status?callId=${numId}`,
                statusCallbackEvent: "join leave end" as any,
                startConferenceOnEnter: false,
                endConferenceOnExit: true,
                beep: "false",
                waitUrl: `${baseUrl}/api/twilio/hold-music?lang=${encodeURIComponent(lang)}`,
                waitMethod: "POST" as any,
              },
              conferenceName,
            );

            await db.update(callLogsTable)
              .set({
                conferenceSid: conferenceName,
                transferredTo: targetPhone,
                transferReason: decision.reason,
                transferredAt: new Date(),
              })
              .where(eq(callLogsTable.id, numId));

            const agentConfig2 = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId!) });
            if (agentConfig2?.twilioAccountSid && agentConfig2?.twilioAuthToken && agentConfig2?.phoneNumber) {
              const client = twilio(agentConfig2.twilioAccountSid, agentConfig2.twilioAuthToken);
              client.calls.create({
                to: targetPhone,
                from: agentConfig2.phoneNumber,
                twiml: `<Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="false" beep="false">${conferenceName}</Conference></Dial></Response>`,
                statusCallback: `${baseUrl}/api/crm/agent-call-status?callId=${numId}`,
                statusCallbackMethod: "POST",
                statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
              }).then(agentCall => {
                crmEventBus.emitCallEvent({
                  type: "call.transferred",
                  callId: numId,
                  callSid: logForTransfer?.callSid || undefined,
                  data: { conferenceSid: conferenceName, agentCallSid: agentCall.sid, transferTo: targetPhone },
                  metadata: meta,
                  timestamp: new Date().toISOString(),
                });
              }).catch(err => console.error("[twilio/voice] Auto-transfer agent dial failed:", err));
            }

            res.type("text/xml");
            res.send(twiml.toString());
            return;
          }
        }
      }
    }
  }

  // 4. Branch to Indian languages if applicable (and no transfer was triggered)
  if (!isSilent && speechResult.trim() && isIndianLanguage(lang)) {
    const encodedSpeech = encodeURIComponent(speechResult);
    const encodedHistory = encodeURIComponent(JSON.stringify(history.slice(-4)));
    const encodedLang = encodeURIComponent(lang);
    const encodedIntentCounts = encodeURIComponent(JSON.stringify(intentTurnCounts));
    const encodedIntent = encodeURIComponent(intentResult.intent);
    twiml.say({ language: "en-US", voice: "Polly.Raveena" }, "One moment please.");
    twiml.redirect({ method: "POST" }, `${baseUrl}/api/twilio/voice-indic?callLogId=${callLogId}&history=${encodedHistory}&speech=${encodedSpeech}&lang=${encodedLang}&intentCounts=${encodedIntentCounts}&humanReqCount=${humanReqCount}&intent=${encodedIntent}`);
    res.type("text/xml");
    res.send(twiml.toString());
    return;
  }

  // 5. English / Standard response generation
  let aiResponse: string;
  let ttsAudioId: string | null = null;

  if (isSilent || !speechResult.trim()) {
    aiResponse = "I didn't quite catch that. Are you still there? Please go ahead and speak.";
  } else {
    const promptConfig = configuredLang === "auto"
      ? { ...(agentConfig || {}), language: lang }
      : (agentConfig || {});
    const basePrompt = await buildSystemPrompt(userId, promptConfig);

    let systemPrompt = basePrompt;
    if (intentTraining && intentTraining.trainingContent) {
      systemPrompt = basePrompt +
        `\n\nINTENT-SPECIFIC KNOWLEDGE (${intentResult.intent}):\n${intentTraining.trainingContent}\n\n` +
        `IMPORTANT: Use the above intent-specific knowledge to answer the caller's question thoroughly. ` +
        `You are an expert on this topic. Give detailed, helpful answers. ` +
        `Only suggest connecting to a human agent if you truly cannot answer after using this knowledge.`;
    }

    try {
      aiResponse = await generateAIResponse(systemPrompt, history, speechResult, resolveOpenAIModel(aiModel));

      // Fire-and-forget: log LLM cost for this turn
      resolveTenantIdForOwner(userId).then(tenantId => {
        if (!tenantId) return;
        const model = resolveOpenAIModel(aiModel);
        const charsPerToken = 4;
        const inputChars = speechResult.length + (systemPrompt?.length ?? 0);
        const outputChars = aiResponse.length;
        return logLLMCost({
          tenantId,
          userId,
          provider: model,
          inputTokens: Math.ceil(inputChars / charsPerToken),
          outputTokens: Math.ceil(outputChars / charsPerToken),
          context: "twilio-voice",
        });
      }).catch(e => console.error("[twilio] LLM cost logging error:", e));
    } catch (err) {
      console.error("AI response error:", err);
      aiResponse = "I'm sorry, I had a technical issue. Could you please repeat that?";
    }
  }

  const newHistory = isSilent
    ? history
    : [...history, { role: "user", content: speechResult }, { role: "assistant", content: aiResponse }];
  const encodedHistory = encodeURIComponent(JSON.stringify(newHistory.slice(-4)));

  // ── CRM Event Bus: emit conversation turn & Persist live transcript ──
  if (!isSilent && speechResult.trim()) {
    const numericCallLogId = parseInt(callLogId, 10);
    if (!isNaN(numericCallLogId)) {
      // Fetch CRM metadata for the event
      const callLogForEvent = await db.query.callLogsTable.findFirst({ where: eq(callLogsTable.id, numericCallLogId) });
      const crmMeta = callLogForEvent?.crmMetadata as Record<string, unknown> | undefined;

      crmEventBus.emitCallEvent({
        type: "call.turn",
        callId: numericCallLogId,
        callSid: callLogForEvent?.callSid || undefined,
        data: { role: "user", content: speechResult, turnIndex: newHistory.length - 2, language: lang },
        metadata: crmMeta,
        timestamp: new Date().toISOString(),
      });
      crmEventBus.emitCallEvent({
        type: "call.turn",
        callId: numericCallLogId,
        callSid: callLogForEvent?.callSid || undefined,
        data: { role: "assistant", content: aiResponse, turnIndex: newHistory.length - 1, language: lang },
        metadata: crmMeta,
        timestamp: new Date().toISOString(),
      });

      // Persist live transcript
      const existingTranscript = (callLogForEvent?.liveTranscript as Array<{ role: string; content: string; timestamp: string }>) || [];
      const updatedTranscript = [
        ...existingTranscript,
        { role: "user", content: speechResult, timestamp: new Date().toISOString() },
        { role: "assistant", content: aiResponse, timestamp: new Date().toISOString() },
      ];
      db.update(callLogsTable)
        .set({ liveTranscript: updatedTranscript })
        .where(eq(callLogsTable.id, numericCallLogId))
        .catch(err => console.error("Failed to update live transcript:", err));
    }
  }

  const encodedIntentCounts = encodeURIComponent(JSON.stringify(intentTurnCounts));

  const gather = twiml.gather({
    input: ["speech"],
    action: `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&history=${encodedHistory}&intentCounts=${encodedIntentCounts}&humanReqCount=${humanReqCount}`,
    method: "POST",
    speechTimeout: "auto",
    timeout: 10,
    language: getTwilioLang(lang) as any,
    actionOnEmptyResult: true,
  });

  // For non-Indian languages in auto/explicit English mode, use OpenAI TTS for natural English speech.
  let ttsUseMp3 = false;
  if (!ttsAudioId && (lang === "auto" || lang === "en-US" || lang === "en-IN")) {
    try {
      const b64 = await generateOpenAITTS(aiResponse, agentConfig?.voice || "nova");
      ttsAudioId = storeTtsAudio(b64);
      ttsUseMp3 = true;

      // Fire-and-forget: log OpenAI TTS cost
      resolveTenantIdForOwner(userId).then(tenantId => {
        if (!tenantId) return;
        return logTTSCost({
          tenantId,
          userId,
          provider: "openai",
          characters: aiResponse.length,
          context: "twilio-tts-openai",
        });
      }).catch(e => console.error("[twilio] OpenAI TTS cost logging error:", e));
    } catch (e) {
      console.error("OpenAI TTS err:", e);
    }
  }

  if (ttsAudioId) {
    gather.play(`${baseUrl}/api/twilio/${ttsUseMp3 ? "tts-audio-mp3" : "tts-audio"}/${ttsAudioId}`);
  } else {
    gather.say({ voice: voice as any, language: getTwilioLang(lang) as any }, aiResponse);
  }

  twiml.redirect({ method: "POST" }, `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&history=${encodedHistory}&intentCounts=${encodedIntentCounts}&humanReqCount=${humanReqCount}&silent=1`);

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

  // ── Per-intent turn counters & human request tracking ──
  let intentTurnCounts: Record<string, number> = {};
  try {
    const raw = req.query.intentCounts as string;
    if (raw) intentTurnCounts = JSON.parse(decodeURIComponent(raw));
  } catch { }
  let humanReqCount = parseInt(req.query.humanReqCount as string) || 0;
  const detectedIntent = req.query.intent as string || "general_question";

  const agentConfig = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });
  const baseUrl = getBaseUrl(req);
  const voice = mapVoice(agentConfig?.voice);
  const configuredLang = agentConfig?.language || "en-US";
  const queryLang = (req.query.lang as string) || "";
  const lang = (configuredLang === "auto" && queryLang) ? queryLang : configuredLang;

  let aiResponse: string;
  let ttsAudioId: string | null = null;

  if (!speechResult.trim()) {
    aiResponse = "I didn't quite catch that. Are you still there? Please go ahead and speak.";
  } else {
    const systemPrompt = await buildSystemPrompt(userId, { ...(agentConfig || {}), language: lang });
    let finalSystemPrompt = systemPrompt;

    // Look up intent training configuration to inject content
    let intentTraining = null;
    try {
      intentTraining = await db.query.intentTrainingTable.findFirst({
        where: and(
          eq(intentTrainingTable.userId, userId),
          eq(intentTrainingTable.intent, detectedIntent),
        ),
      });
      if (intentTraining && intentTraining.trainingContent) {
        finalSystemPrompt = systemPrompt +
          `\n\nINTENT-SPECIFIC KNOWLEDGE (${detectedIntent}):\n${intentTraining.trainingContent}\n\n` +
          `IMPORTANT: Use the above intent-specific knowledge to answer the caller's question thoroughly. ` +
          `You are an expert on this topic. Give detailed, helpful answers. ` +
          `Only suggest connecting to a human agent if you truly cannot answer after using this knowledge.`;
        console.log(`[voice-indic] Used intent training data for "${detectedIntent}"`);
      }
    } catch (intentErr) {
      console.error("[voice-indic] Intent training lookup failed:", intentErr);
    }

    try {
      const indicResult = await generateAIResponseIndic(finalSystemPrompt, history, speechResult, lang, baseUrl, userId);
      aiResponse = indicResult.text;
      ttsAudioId = indicResult.ttsAudioId;
    } catch (err) {
      console.error("[voice-indic] AI response error:", err);
      aiResponse = "I'm sorry, I had a technical issue. Could you please repeat that?";
    }
  }

  const newHistory = [...history, { role: "user", content: speechResult }, { role: "assistant", content: aiResponse }];
  const encodedHistory = encodeURIComponent(JSON.stringify(newHistory.slice(-4)));
  const encodedIntentCounts = encodeURIComponent(JSON.stringify(intentTurnCounts));

  // ── CRM Event Bus: emit conversation turn & Persist live transcript ──
  if (speechResult.trim()) {
    const numericCallLogId = parseInt(callLogId, 10);
    if (!isNaN(numericCallLogId)) {
      const callLogForEvent = await db.query.callLogsTable.findFirst({ where: eq(callLogsTable.id, numericCallLogId) });
      const crmMeta = callLogForEvent?.crmMetadata as Record<string, unknown> | undefined;

      crmEventBus.emitCallEvent({
        type: "call.turn",
        callId: numericCallLogId,
        callSid: callLogForEvent?.callSid || undefined,
        data: { role: "user", content: speechResult, turnIndex: newHistory.length - 2, language: lang },
        metadata: crmMeta,
        timestamp: new Date().toISOString(),
      });
      crmEventBus.emitCallEvent({
        type: "call.turn",
        callId: numericCallLogId,
        callSid: callLogForEvent?.callSid || undefined,
        data: { role: "assistant", content: aiResponse, turnIndex: newHistory.length - 1, language: lang },
        metadata: crmMeta,
        timestamp: new Date().toISOString(),
      });

      const existingTranscript = (callLogForEvent?.liveTranscript as Array<{ role: string; content: string; timestamp: string }>) || [];
      const updatedTranscript = [
        ...existingTranscript,
        { role: "user", content: speechResult, timestamp: new Date().toISOString() },
        { role: "assistant", content: aiResponse, timestamp: new Date().toISOString() },
      ];
      db.update(callLogsTable)
        .set({ liveTranscript: updatedTranscript })
        .where(eq(callLogsTable.id, numericCallLogId))
        .catch(err => console.error("Failed to update live transcript:", err));
    }
  }

  const gather = twiml.gather({
    input: ["speech"],
    action: `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&history=${encodedHistory}&intentCounts=${encodedIntentCounts}&humanReqCount=${humanReqCount}`,
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

  twiml.redirect({ method: "POST" }, `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&history=${encodedHistory}&intentCounts=${encodedIntentCounts}&humanReqCount=${humanReqCount}&silent=1`);

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

    // ── CRM Event Bus: emit call ended ──
    if (existingLog) {
      const finalLog = await db.query.callLogsTable.findFirst({ where: eq(callLogsTable.id, parseInt(callLogId)) });
      crmEventBus.emitCallEvent({
        type: "call.ended",
        callId: parseInt(callLogId),
        callSid: finalLog?.callSid || undefined,
        data: {
          outcome: outcomeMap[callStatus] || "no_answer",
          duration: callDuration,
          transcript: finalLog?.transcript || null,
          aiSummary: finalLog?.aiSummary || null,
          estimatedCostUsd: costData?.totalCost?.toString() || null,
          billedCostUsd: billedCost?.toString() || null,
          liveTranscript: finalLog?.liveTranscript || [],
        },
        metadata: finalLog?.crmMetadata as Record<string, unknown> | undefined,
        timestamp: new Date().toISOString(),
      });
    }
  }

  res.status(200).send("OK");
});

// GET/POST /api/twilio/hold-music — Twilio calls this while caller waits in conference
router.post("/twilio/hold-music", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const queryLang = (req.query.lang as string || req.body.lang as string || "en-US").toLowerCase();

  let twilioLang = "en-IN";
  let voice: any = "Polly.Raveena";
  let msg1 = "Please wait while we connect you with a specialist. Your call is in queue and will be answered shortly.";
  let msg2 = "Thank you for your patience. An agent will be with you shortly.";

  if (queryLang.startsWith("hi")) {
    twilioLang = "hi-IN";
    voice = "Polly.Aditi";
    msg1 = "कृपया प्रतीक्षा करें, हम आपको हमारे विशेषज्ञ से जोड़ रहे हैं। आपकी कॉल कतार में है और जल्द ही इसका उत्तर दिया जाएगा।";
    msg2 = "धैर्य रखने के लिए धन्यवाद। हमारे प्रतिनिधि जल्द ही आपसे बात करेंगे।";
  } else if (queryLang.startsWith("kn")) {
    twilioLang = "kn-IN";
    voice = "Polly.Aditi";
    msg1 = "ದಯವಿಟ್ಟು ನಿರೀಕ್ಷಿಸಿ, ನಾವು ನಿಮ್ಮನ್ನು ನಮ್ಮ ತಜ್ಞರೊಂದಿಗೆ ಸಂಪರ್ಕಿಸುತ್ತಿದ್ದೇವೆ. ನಿಮ್ಮ ಕರೆ ಸರತಿಯಲ್ಲಿದೆ ಮತ್ತು ಶೀಘ್ರದಲ್ಲೇ ಉತ್ತರಿಸಲಾಗುವುದು.";
    msg2 = "ನಿಮ್ಮ ತಾಳ್ಮೆಗೆ ಧನ್ಯವಾದಗಳು. ನಮ್ಮ ಪ್ರತಿನಿಧಿ ಶೀಘ್ರದಲ್ಲೇ ನಿಮ್ಮೊಂದಿಗೆ ಮಾತನಾಡಲಿದ್ದಾರೆ.";
  } else if (queryLang.startsWith("ta")) {
    twilioLang = "ta-IN";
    voice = "Polly.Aditi";
    msg1 = "தயவுசெய்து காத்திருங்கள், நாங்கள் உங்களை எங்கள் நிபுணருடன் இணைக்கிறோம். உங்கள் அழைப்பு வரிசையில் உள்ளது, விரைவில் பதிலளிக்கப்படும்.";
    msg2 = "உங்கள் பொறுமைக்கு நன்றி. எங்கள் முகவர் விரைவில் உங்களுடன் இருப்பார்.";
  } else if (queryLang.startsWith("te")) {
    twilioLang = "te-IN";
    voice = "Polly.Aditi";
    msg1 = "దయచేసి వేచి ఉండండి, మేము మిమ్మల్ని మా నిపుణుడితో కనెక్ట్ చేస్తున్నాము. మీ కాల్ క్యూలో ఉంది మరియు త్వరలోనే సమాధానం ఇవ్వబడుతుంది.";
    msg2 = "మీ ఓర్పుకు ధన్యವಾದాలు. మా ప్రతినిధి త్వరలోనే మీతో మాట్లాడతారు.";
  } else if (queryLang.startsWith("mr")) {
    twilioLang = "mr-IN";
    voice = "Polly.Aditi";
    msg1 = "कृपया प्रतीक्षा करा, आम्ही तुम्हाला आमच्या तज्ज्ञांशी जोडत आहोत. तुमचा कॉल रांगेत आहे आणि लवकरच त्याचे उत्तर दिले जाईल।";
    msg2 = "तुमच्या संयमाबद्दल धन्यवाद। आमचे प्रतिनिधी लवकरच तुमच्याशी बोलतील।";
  }

  const sayOptions: any = { language: twilioLang };
  if (voice) {
    sayOptions.voice = voice;
  }

  twiml.say(sayOptions, msg1);
  twiml.pause({ length: 8 });
  twiml.say(sayOptions, msg2);
  twiml.pause({ length: 8 });
  twiml.redirect({ method: "POST" }, `${getBaseUrl(req)}/api/twilio/hold-music?lang=${encodeURIComponent(queryLang)}`);

  res.type("text/xml");
  res.send(twiml.toString());
});

export default router;
