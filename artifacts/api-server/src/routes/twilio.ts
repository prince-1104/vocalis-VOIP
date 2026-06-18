import { Router, type IRouter } from "express";
import twilio from "twilio";
import { db, agentConfigsTable, callLogsTable, trainingDataTable, callingScriptsTable, tenantsTable, intentTrainingTable, campaignsTable, campaignContactsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { randomUUID } from "crypto";
import { crmEventBus } from "../lib/crm-event-bus";
import { classifyIntent, shouldTransfer, detectHumanRequest, type TransferRules } from "../lib/intent-classifier";
import { findBestAgent } from "../lib/transfer-manager";
import { logLLMCost, logTTSCost, resolveTenantIdForOwner } from "../lib/cost-logger";
import { dialNextForCampaign, triggerDialingForCampaign } from "../lib/campaign-dialer";

const router: IRouter = Router();

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage = "Operation timed out"): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function fetchWithTimeout(url: string, options: RequestInit & { timeout?: number }): Promise<Response> {
  const { timeout = 4000, ...fetchOptions } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
    });
    clearTimeout(id);
    return response;
  } catch (error: any) {
    clearTimeout(id);
    if (error.name === "AbortError") {
      throw new Error(`Request to ${url} timed out after ${timeout}ms`);
    }
    throw error;
  }
}

const SARVAM_API_KEY = process.env.SARVAM_API_KEY ?? "";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? "";

const ttsAudioCache = new Map<string, Buffer>();
const TTS_CACHE_TTL_MS = 5 * 60 * 1000;

// ── Per-call in-memory caches — eliminates repeated DB queries per turn ─
const AGENT_CONFIG_CACHE_TTL = 60_000; // 1 minute
const SYSTEM_PROMPT_CACHE_TTL = 5 * 60_000; // 5 minutes

const agentConfigCache = new Map<number, { data: any; fetchedAt: number }>();
const systemPromptCache = new Map<string, { prompt: string; fetchedAt: number }>();

// Per-call metadata: populated once in /inbound, reused each turn.
// Key = callLogId string.
interface CallMeta {
  userId: number;
  callSid?: string;
  crmMetadata?: Record<string, unknown>;
  liveTranscript: Array<{ role: string; content: string; timestamp: string }>;
  scriptId?: number | null;
}
const callMetaCache = new Map<string, CallMeta>();

async function getCachedAgentConfig(userId: number): Promise<any> {
  const cached = agentConfigCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < AGENT_CONFIG_CACHE_TTL) return cached.data;
  const data = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });
  agentConfigCache.set(userId, { data, fetchedAt: Date.now() });
  return data;
}

async function getCachedSystemPrompt(userId: number, agentConfig: any, scriptId?: number | null): Promise<string> {
  // Cache key includes language and scriptId so prompt configurations don't collide
  const key = `${userId}:${agentConfig.language ?? "en-US"}:${scriptId ?? "default"}`;
  const cached = systemPromptCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SYSTEM_PROMPT_CACHE_TTL) return cached.prompt;
  const prompt = await buildSystemPrompt(userId, agentConfig, scriptId);
  systemPromptCache.set(key, { prompt, fetchedAt: Date.now() });
  return prompt;
}

// Invalidate prompt cache when training data changes (call this from training routes if needed)
export function invalidateSystemPromptCache(userId: number): void {
  for (const key of systemPromptCache.keys()) {
    if (key.startsWith(`${userId}:`)) systemPromptCache.delete(key);
  }
}

// Invalidate agent config cache when agent settings change
export function invalidateAgentConfigCache(userId: number): void {
  agentConfigCache.delete(userId);
}

// Dynamically resolves the active calling script for a user with hierarchical fallback:
// 1. Specified scriptId (if valid)
// 2. Explicit default script (isDefault = true)
// 3. Most recently updated script
async function resolveActiveScript(userId: number, scriptId?: number | null): Promise<any> {
  if (scriptId) {
    const s = await db.select().from(callingScriptsTable).where(and(eq(callingScriptsTable.userId, userId), eq(callingScriptsTable.id, scriptId))).limit(1);
    if (s.length > 0) return s[0];
  }
  const defaults = await db.select().from(callingScriptsTable).where(and(eq(callingScriptsTable.userId, userId), eq(callingScriptsTable.isDefault, true))).limit(1);
  if (defaults.length > 0) return defaults[0];
  const all = await db.select().from(callingScriptsTable).where(eq(callingScriptsTable.userId, userId)).orderBy(desc(callingScriptsTable.updatedAt)).limit(1);
  if (all.length > 0) return all[0];
  return null;
}

async function getCallMeta(callLogId: string): Promise<CallMeta | null> {
  const cached = callMetaCache.get(callLogId);
  if (cached) return cached;
  const id = parseInt(callLogId, 10);
  if (isNaN(id)) return null;
  const log = await db.query.callLogsTable.findFirst({ where: eq(callLogsTable.id, id) });
  if (!log?.userId) return null;

  // Resolve scriptId if call is part of a campaign
  let scriptId = null;
  if (log.campaignId) {
    const campaign = await db.query.campaignsTable.findFirst({ where: eq(campaignsTable.id, log.campaignId) });
    if (campaign?.scriptId) {
      scriptId = campaign.scriptId;
    }
  }

  const meta: CallMeta = {
    userId: log.userId,
    callSid: log.callSid ?? undefined,
    crmMetadata: log.crmMetadata as Record<string, unknown> | undefined,
    liveTranscript: (log.liveTranscript as any) || [],
    scriptId,
  };
  callMetaCache.set(callLogId, meta);
  return meta;
}

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
  const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
  return `${proto}://${host}`;
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

async function buildSystemPrompt(userId: number, agentConfig: any, scriptId?: number | null): Promise<string> {
  const [trainingData, script] = await Promise.all([
    db.select().from(trainingDataTable).where(eq(trainingDataTable.userId, userId)).limit(KB_MAX_ENTRIES),
    resolveActiveScript(userId, scriptId),
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

  if (script) {
    system += `CALL SCRIPT FLOW:\n`;
    system += `1. Start with the Opening line: "${script.openingLine}" (already spoken as greeting).\n`;
    if (script.pitchPoints && Array.isArray(script.pitchPoints) && (script.pitchPoints as string[]).length > 0) {
      system += `2. If the user agrees/shows interest, pitch these key points: ${(script.pitchPoints as string[]).slice(0, 3).join(" | ")}\n`;
    }
    if (script.closingLine) {
      system += `3. Wrap up the call or end the conversation by using the exact Closing line: "${script.closingLine}". Do NOT deviate from this phrasing when concluding.\n`;
    }
    system += "\n";
  }

  system += `After each response, ask one concise follow-up question to keep the conversation moving forward.`;
  return system;
}

async function generateAIResponse(systemPrompt: string, history: {role: string, content: string}[], userMessage: string, model = "gpt-4o-mini"): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const completionPromise = openai.chat.completions.create({
    model,
    max_completion_tokens: 150,
    messages,
  });

  const response = await withTimeout(completionPromise, 4000, "OpenAI LLM timeout");

  return {
    text: response.choices[0]?.message?.content || "I'm sorry, I didn't catch that. Could you repeat that?",
    inputTokens: response.usage?.prompt_tokens ?? 0,
    outputTokens: response.usage?.completion_tokens ?? 0,
  };
}

async function generateResponseForModel(
  systemPrompt: string,
  history: { role: string; content: string }[],
  userMessage: string,
  aiModel: string,
  lang: string,
): Promise<{ text: string; provider: string; inputTokens: number; outputTokens: number }> {
  if (aiModel === "deepseek-chat" || aiModel === "deepseek-v3") {
    const text = await callDeepSeekLLM(systemPrompt, history, userMessage);
    const charsPerToken = 2.5;
    const inputChars = userMessage.length + (systemPrompt?.length ?? 0);
    const outputChars = text.length;
    return {
      text,
      provider: "deepseek-chat",
      inputTokens: Math.ceil(inputChars / charsPerToken),
      outputTokens: Math.ceil(outputChars / charsPerToken),
    };
  }

  if (aiModel === "sarvam-m" || aiModel === "sarvam-1-2b") {
    const text = await callSarvamLLM(systemPrompt, history, userMessage);
    const charsPerToken = 2.0;
    const inputChars = userMessage.length + (systemPrompt?.length ?? 0);
    const outputChars = text.length;
    return {
      text,
      provider: "sarvam-m",
      inputTokens: Math.ceil(inputChars / charsPerToken),
      outputTokens: Math.ceil(outputChars / charsPerToken),
    };
  }

  const resolved = resolveOpenAIModel(aiModel);
  const aiResult = await generateAIResponse(systemPrompt, history, userMessage, resolved);
  return {
    text: aiResult.text,
    provider: resolved,
    inputTokens: aiResult.inputTokens,
    outputTokens: aiResult.outputTokens,
  };
}

async function generateOpenAITTS(text: string, voice: string = "nova"): Promise<string> {
  const mp3Promise = openai.audio.speech.create({
    model: "tts-1",
    voice: voice as any,
    input: text,
  });
  const mp3 = await withTimeout(mp3Promise, 2500, "OpenAI TTS timeout");
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

  const res = await fetchWithTimeout("https://api.sarvam.ai/speech-to-text", {
    method: "POST",
    headers: {
      "api-subscription-key": SARVAM_API_KEY,
    },
    body: formData,
    timeout: 3000,
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

  const res = await fetchWithTimeout("https://api.deepseek.com/chat/completions", {
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
    timeout: 4000,
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

  const res = await fetchWithTimeout("https://api.sarvam.ai/v1/chat/completions", {
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
    timeout: 4000,
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

  const res = await fetchWithTimeout("https://api.sarvam.ai/text-to-speech", {
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
    timeout: 2500,
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
    ttsAudioId = await withTimeout(callSarvamTTS(text, lang), 2500, "Sarvam TTS timeout");

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
      const sarvamTtsId = await withTimeout(callSarvamTTS(text, lang), 2500, "Greeting Sarvam TTS timeout");
      if (sarvamTtsId) {
        return { ttsAudioId: sarvamTtsId, useMp3: false };
      }
    } catch (err) {
      console.error("[call-audio] Sarvam greeting TTS failed:", err);
    }
  }

  if (lang === "auto") {
    try {
      const b64 = await withTimeout(generateOpenAITTS(text, voice || "nova"), 2500, "Greeting OpenAI TTS timeout");
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
  // Widget-voice calls use Twilio Client SDK ($0.004/min) instead of PSTN
  const twilioBaseRate = direction === "outbound" ? 0.013 : direction === "widget-voice" ? 0.004 : 0.022;
  const twilioSpeechRate = direction === "widget-voice" ? 0 : 0.04;  // No speech recognition charge for Client SDK
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
  const meta = await getCallMeta(callLogId);
  return meta?.userId ?? null;
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

  const agentConfig = await getCachedAgentConfig(userId);

  const script = await resolveActiveScript(userId);

  const greeting = script?.openingLine || agentConfig?.greeting || "Hi, thank you for calling. How can I help you today?";
  const baseUrl = getBaseUrl(req);

  const [callLog] = await db.insert(callLogsTable).values({
    userId,
    direction: "inbound",
    phone: req.body.From || "unknown",
    outcome: "answered",
    aiModel: agentConfig?.aiModel || "gpt-4o-mini",
    startedAt: new Date(),
  }).returning();

  // ── Pre-warm caches for the first voice turn (fire-and-forget) ──────
  // By the time the caller finishes speaking (2–5s), these will be ready.
  const callLogIdStr = String(callLog.id);
  callMetaCache.set(callLogIdStr, {
    userId,
    callSid: req.body.CallSid ?? undefined,
    crmMetadata: undefined,
    liveTranscript: [],
    scriptId: script?.id || null,
  });
  getCachedSystemPrompt(userId, { ...(agentConfig || {}), language: agentConfig?.language || "en-US" }, script?.id || null).catch(() => {});

  const connect = twiml.connect();
  const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
  const wsProto = isLocal ? "ws" : "wss";
  const streamUrl = `${baseUrl.replace(/^https?/, wsProto)}/ws/crm/calls/twilio-media-stream?callLogId=${callLog.id}`;
  connect.stream({ url: streamUrl });

  res.type("text/xml");
  res.send(twiml.toString());
});

router.post("/twilio/voice", async (req, res) => {
  const requestStart = Date.now();
  let classifyDuration = 0;
  let llmDuration = 0;
  let ttsDuration = 0;

  const twiml = new twilio.twiml.VoiceResponse();
  const callLogId = req.query.callLogId as string;

  // ── Resolve userId from cache (avoids DB query per turn) ────────────
  const callMeta = await getCallMeta(callLogId);
  const userId = callMeta?.userId;
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

  // ── Fetch agent config from cache (avoids DB query per turn) ────────
  const agentConfig = await getCachedAgentConfig(userId);
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

  // Transfer rules come from cached CRM metadata — no extra DB query needed
  const transferRules = callMeta.crmMetadata?.__transferRules as TransferRules | undefined;
  const hasTransferRules = !!transferRules;

  if (!isSilent && speechResult.trim()) {
    // 1. Detect explicit "talk to human" request
    if (detectHumanRequest(speechResult)) {
      humanReqCount++;
      console.log(`[twilio/voice] Human request detected (count: ${humanReqCount})`);
    }

    // 2. Classify intent (fast regex, LLM fallback only if transfer rules exist)
    //    Run in parallel with intentTraining DB lookup
    try {
      const classifyStart = Date.now();
      const [classifyResult, intentTrainingRow] = await Promise.all([
        classifyIntent(history, speechResult, hasTransferRules),
        db.query.intentTrainingTable.findFirst({
          where: and(
            eq(intentTrainingTable.userId, userId),
            eq(intentTrainingTable.intent, "general_question"), // placeholder — updated after classify
          ),
        }).catch(() => null), // non-critical
      ]);
      classifyDuration = Date.now() - classifyStart;
      intentResult = classifyResult;
      if (intentResult.confidence >= 0.6) {
        intentTurnCounts[intentResult.intent] = (intentTurnCounts[intentResult.intent] || 0) + 1;
      }
      // Fetch the correct intent training row now that we know the intent
      if (intentResult.intent !== "general_question") {
        intentTraining = await db.query.intentTrainingTable.findFirst({
          where: and(
            eq(intentTrainingTable.userId, userId),
            eq(intentTrainingTable.intent, intentResult.intent),
          ),
        }).catch(() => null);
      } else {
        intentTraining = intentTrainingRow ?? null;
      }
    } catch (classifyErr) {
      console.error("[twilio/voice] Intent classification error:", classifyErr);
    }

    // 3. Check transfer rules & execute transfer if needed
    const numId = parseInt(callLogId, 10);
    if (!isNaN(numId)) {
      const meta = callMeta.crmMetadata;

      // Emit intent event
      crmEventBus.emitCallEvent({
        type: "call.intent",
        callId: numId,
        callSid: callMeta.callSid || undefined,
        userId: userId || undefined,
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
              callSid: callMeta.callSid || undefined,
              userId: userId || undefined,
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
            twiml.say("Please wait, your call is being transferred to our specialist. Please stay on the line.");
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
                  callSid: callMeta.callSid || undefined,
                  userId: userId || undefined,
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
  // Only auto-switch AIs in auto mode. If a specific AI is chosen (configuredLang !== "auto"), stay in the standard pipeline.
  if (!isSilent && speechResult.trim() && isIndianLanguage(lang) && configuredLang === "auto") {
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
    // ── Cached system prompt — no DB queries on warm turns ───────────
    const basePrompt = await getCachedSystemPrompt(userId, promptConfig, callMeta?.scriptId);

    let systemPrompt = basePrompt;
    if (intentTraining && intentTraining.trainingContent) {
      systemPrompt = basePrompt +
        `\n\nINTENT-SPECIFIC KNOWLEDGE (${intentResult.intent}):\n${intentTraining.trainingContent}\n\n` +
        `IMPORTANT: Use the above intent-specific knowledge to answer the caller's question thoroughly. ` +
        `You are an expert on this topic. Give detailed, helpful answers. ` +
        `Only suggest connecting to a human agent if you truly cannot answer after using this knowledge.`;
    }

    try {
      // ── LLM call — TTS is started immediately after it resolves ─────
      const llmStart = Date.now();
      const aiResult = await generateResponseForModel(systemPrompt, history, speechResult, aiModel, lang);
      aiResponse = aiResult.text;
      llmDuration = Date.now() - llmStart;

      // Start TTS generation immediately (fire-and-forget race with DB writes below)
      const useSarvamTts = isIndianLanguage(lang);
      const ttsStart = Date.now();
      const ttsPromise = withTimeout(
        useSarvamTts
          ? callSarvamTTS(aiResponse, lang)
          : generateOpenAITTS(aiResponse, agentConfig?.voice || "nova").then(b64 => storeTtsAudio(b64)),
        2500,
        "TTS generation timeout"
      ).catch(e => { console.error("TTS generation err:", e); return null; });

      // Fire-and-forget: log LLM cost
      resolveTenantIdForOwner(userId).then(tenantId => {
        if (!tenantId) return;
        return logLLMCost({
          tenantId,
          userId,
          provider: aiResult.provider,
          inputTokens: aiResult.inputTokens,
          outputTokens: aiResult.outputTokens,
          context: "twilio-voice",
        });
      }).catch(e => console.error("[twilio] LLM cost logging error:", e));

      // Await TTS (started in parallel with cost logging above)
      const ttsResult = await ttsPromise;
      ttsDuration = Date.now() - ttsStart;
      if (ttsResult) {
        ttsAudioId = ttsResult;
        // Fire-and-forget: log TTS cost
        resolveTenantIdForOwner(userId).then(tenantId => {
          if (!tenantId) return;
          if (useSarvamTts) {
            return logTTSCost({ tenantId, userId, provider: "sarvam", characters: aiResponse.length, context: "twilio-tts-sarvam" });
          } else {
            return logTTSCost({ tenantId, userId, provider: "openai", characters: aiResponse.length, context: "twilio-tts-openai" });
          }
        }).catch(e => console.error("[twilio] TTS cost logging error:", e));
      }
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
  // Use cached callMeta — no DB fetch needed per turn.
  if (!isSilent && speechResult.trim()) {
    const numericCallLogId = parseInt(callLogId, 10);
    if (!isNaN(numericCallLogId)) {
      const crmMeta = callMeta.crmMetadata;

      crmEventBus.emitCallEvent({
        type: "call.turn",
        callId: numericCallLogId,
        callSid: callMeta.callSid || undefined,
        userId: userId || undefined,
        data: { role: "user", content: speechResult, turnIndex: newHistory.length - 2, language: lang },
        metadata: crmMeta,
        timestamp: new Date().toISOString(),
      });
      crmEventBus.emitCallEvent({
        type: "call.turn",
        callId: numericCallLogId,
        callSid: callMeta.callSid || undefined,
        userId: userId || undefined,
        data: { role: "assistant", content: aiResponse, turnIndex: newHistory.length - 1, language: lang },
        metadata: crmMeta,
        timestamp: new Date().toISOString(),
      });

      // Append to cached transcript, then persist to DB (fire-and-forget)
      const updatedTranscript = [
        ...callMeta.liveTranscript,
        { role: "user", content: speechResult, timestamp: new Date().toISOString() },
        { role: "assistant", content: aiResponse, timestamp: new Date().toISOString() },
      ];
      callMeta.liveTranscript = updatedTranscript; // keep cache in sync
      const formattedTranscript = updatedTranscript
        .map((turn: any) => `${turn.role === "user" ? "Caller" : "Agent"}: ${turn.content}`)
        .join("\n\n");
      db.update(callLogsTable)
        .set({
          liveTranscript: updatedTranscript,
          transcript: formattedTranscript,
        })
        .where(eq(callLogsTable.id, numericCallLogId))
        .catch(err => console.error("Failed to update live transcript/transcript:", err));
    }
  }

  const encodedIntentCounts = encodeURIComponent(JSON.stringify(intentTurnCounts));

  const gather = twiml.gather({
    input: ["speech"],
    action: `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&history=${encodedHistory}&intentCounts=${encodedIntentCounts}&humanReqCount=${humanReqCount}`,
    method: "POST",
    speechTimeout: "1.5",
    speechModel: "phone_call",
    enhanced: true,
    timeout: 10,
    language: getTwilioLang(lang) as any,
    actionOnEmptyResult: true,
  });

  // TTS was already generated in parallel inside the AI response block above.
  // ttsAudioId is set if OpenAI TTS or Sarvam TTS succeeded.
  const useSarvamTts = isIndianLanguage(lang);
  const ttsUseMp3 = ttsAudioId !== null && !useSarvamTts;

  if (ttsAudioId) {
    gather.play(`${baseUrl}/api/twilio/${ttsUseMp3 ? "tts-audio-mp3" : "tts-audio"}/${ttsAudioId}`);
  } else {
    gather.say({ voice: voice as any, language: getTwilioLang(lang) as any }, aiResponse);
  }

  twiml.redirect({ method: "POST" }, `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&history=${encodedHistory}&intentCounts=${encodedIntentCounts}&humanReqCount=${humanReqCount}&silent=1`);

  res.type("text/xml");
  const totalDuration = Date.now() - requestStart;
  console.log(`[twilio/voice] CallLogId=${callLogId} Turn latency: Classify=${classifyDuration}ms, LLM=${llmDuration}ms, TTS=${ttsDuration}ms, Total=${totalDuration}ms`);
  res.send(twiml.toString());
});

router.post("/twilio/voice-indic", async (req, res) => {
  const requestStart = Date.now();
  const twiml = new twilio.twiml.VoiceResponse();
  const callLogId = req.query.callLogId as string;

  // ── Use cached callMeta (avoids DB query per turn) ──────────────────
  const callMeta = await getCallMeta(callLogId);
  const userId = callMeta?.userId;
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

  // ── Use cached agent config ──────────────────────────────────────────
  const agentConfig = await getCachedAgentConfig(userId);
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
    // ── Cached system prompt + intent training lookup in parallel ───────
    const [systemPrompt, intentTraining] = await Promise.all([
      getCachedSystemPrompt(userId, { ...(agentConfig || {}), language: lang }, callMeta?.scriptId),
      detectedIntent !== "general_question"
        ? db.query.intentTrainingTable.findFirst({
            where: and(
              eq(intentTrainingTable.userId, userId),
              eq(intentTrainingTable.intent, detectedIntent),
            ),
          }).catch(() => null)
        : Promise.resolve(null),
    ]);

    let finalSystemPrompt = systemPrompt;
    try {
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
  // Uses cached callMeta — no DB query needed per turn.
  if (speechResult.trim()) {
    const numericCallLogId = parseInt(callLogId, 10);
    if (!isNaN(numericCallLogId)) {
      const crmMeta = callMeta.crmMetadata;

      crmEventBus.emitCallEvent({
        type: "call.turn",
        callId: numericCallLogId,
        callSid: callMeta.callSid || undefined,
        data: { role: "user", content: speechResult, turnIndex: newHistory.length - 2, language: lang },
        metadata: crmMeta,
        timestamp: new Date().toISOString(),
      });
      crmEventBus.emitCallEvent({
        type: "call.turn",
        callId: numericCallLogId,
        callSid: callMeta.callSid || undefined,
        data: { role: "assistant", content: aiResponse, turnIndex: newHistory.length - 1, language: lang },
        metadata: crmMeta,
        timestamp: new Date().toISOString(),
      });

      const updatedTranscript = [
        ...callMeta.liveTranscript,
        { role: "user", content: speechResult, timestamp: new Date().toISOString() },
        { role: "assistant", content: aiResponse, timestamp: new Date().toISOString() },
      ];
      callMeta.liveTranscript = updatedTranscript;
      const formattedTranscript = updatedTranscript
        .map((turn: any) => `${turn.role === "user" ? "Caller" : "Agent"}: ${turn.content}`)
        .join("\n\n");
      db.update(callLogsTable)
        .set({
          liveTranscript: updatedTranscript,
          transcript: formattedTranscript,
        })
        .where(eq(callLogsTable.id, numericCallLogId))
        .catch(err => console.error("Failed to update live transcript/transcript:", err));
    }
  }

  const gather = twiml.gather({
    input: ["speech"],
    action: `${baseUrl}/api/twilio/voice?callLogId=${callLogId}&history=${encodedHistory}&intentCounts=${encodedIntentCounts}&humanReqCount=${humanReqCount}`,
    method: "POST",
    speechTimeout: "1.5",
    speechModel: "phone_call",
    enhanced: true,
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
  const totalDuration = Date.now() - requestStart;
  console.log(`[twilio/voice-indic] CallLogId=${callLogId} Turn latency: Total=${totalDuration}ms`);
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

  // Use cached config (avoids DB queries per turn)
  const agentConfig = await getCachedAgentConfig(userId);
  const lang = agentConfig?.language || "en-US";

  const callMeta = await getCallMeta(callLogId);
  const script = await resolveActiveScript(userId, callMeta?.scriptId);

  // Pre-warm system prompt cache while TTS is being generated
  getCachedSystemPrompt(userId, { ...(agentConfig || {}), language: lang }, script?.id || null).catch(() => {});

  const openingLine = script
    ? script.openingLine
    : agentConfig?.greeting || "Hi, I'm calling on behalf of our company. Is this a good time to speak?";

  const baseUrl = getBaseUrl(req);
  const voice = mapVoice(agentConfig?.voice);

  const connect = twiml.connect();
  const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
  const wsProto = isLocal ? "ws" : "wss";
  const streamUrl = `${baseUrl.replace(/^https?/, wsProto)}/ws/crm/calls/twilio-media-stream?callLogId=${callLogId}`;
  connect.stream({ url: streamUrl });

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

      const formattedTranscript = (existingLog?.liveTranscript && Array.isArray(existingLog.liveTranscript))
      ? existingLog.liveTranscript
          .map((turn: any) => `${turn.role === "user" ? "Caller" : "Agent"}: ${turn.content}`)
          .join("\n\n")
      : null;

    await db.update(callLogsTable)
      .set({
        outcome: outcomeMap[callStatus] || "no_answer",
        duration: callDuration,
        endedAt: new Date(),
        ...(formattedTranscript ? { transcript: formattedTranscript } : {}),
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

      if (existingLog.campaignId && existingLog.contactId) {
        const campaign = await db.query.campaignsTable.findFirst({
          where: eq(campaignsTable.id, existingLog.campaignId),
        });

        if (campaign) {
          const resolvedOutcome = outcomeMap[callStatus] || "no_answer";

          const campaignContact = await db.query.campaignContactsTable.findFirst({
            where: and(
              eq(campaignContactsTable.campaignId, existingLog.campaignId),
              eq(campaignContactsTable.contactId, existingLog.contactId)
            )
          });

          if (campaignContact) {
            if (resolvedOutcome === "answered") {
              await db.update(campaignContactsTable)
                .set({ status: "answered" })
                .where(eq(campaignContactsTable.id, campaignContact.id));

              await db.update(campaignsTable)
                .set({ answeredCount: sql`${campaignsTable.answeredCount} + 1` })
                .where(eq(campaignsTable.id, campaign.id));
            } else {
              if (campaignContact.attempts >= 1 + campaign.maxRetries) {
                await db.update(campaignContactsTable)
                  .set({ status: "failed" })
                  .where(eq(campaignContactsTable.id, campaignContact.id));
              } else {
                const nextTime = new Date(Date.now() + campaign.retryIntervalMinutes * 60 * 1000);
                await db.update(campaignContactsTable)
                  .set({ status: "retrying", nextAttemptAt: nextTime })
                  .where(eq(campaignContactsTable.id, campaignContact.id));
              }
            }
          }

          if (campaign.status === "active" && campaign.isAutomatic) {
            const baseUrl = getBaseUrl(req);
            triggerDialingForCampaign(campaign.id, existingLog.userId, baseUrl).catch((err) => {
              console.error(`[twilio/status] Auto dialing next contact failed for campaign ${campaign.id}:`, err);
            });
          }
        }
      }
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

// ── Widget Voice: Browser-to-AI voice calls via Twilio Client SDK ──────
// When a website visitor clicks the call button in the widget, the Twilio
// Client JS SDK connects via WebRTC. Twilio hits this webhook to get the
// initial TwiML. After that, the call flows through the existing /twilio/voice
// turn loop — identical to regular phone calls.
router.post("/twilio/widget-voice", async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = getBaseUrl(req);

  // The Twilio Client SDK passes the TwiML Application SID in ApplicationSid.
  // We also look for userId in the connect params (passed by the widget).
  const applicationSid = req.body.ApplicationSid;
  const callerIdentity = req.body.From || req.body.Caller || "widget-caller";

  // Resolve the tenant: find the agent config with this TwiML App SID
  let userId: number | null = null;
  if (applicationSid) {
    const agent = await db.query.agentConfigsTable.findFirst({
      where: eq(agentConfigsTable.twilioTwimlAppSid as any, applicationSid),
    });
    if (agent) userId = agent.userId;
  }

  // Fallback: try userId from connect params
  if (!userId) {
    const paramUserId = req.body.userId || req.query.userId;
    if (paramUserId) userId = parseInt(paramUserId as string, 10) || null;
  }

  if (!userId) {
    twiml.say("We're sorry, this voice widget is not configured. Goodbye.");
    twiml.hangup();
    res.type("text/xml");
    res.send(twiml.toString());
    return;
  }

  const agentConfig = await db.query.agentConfigsTable.findFirst({
    where: eq(agentConfigsTable.userId, userId),
  });

  // Resolve scriptId if widget has a campaign
  let scriptId: number | null = null;
  if (agentConfig?.widgetCampaignId) {
    const campaign = await db.query.campaignsTable.findFirst({
      where: eq(campaignsTable.id, agentConfig.widgetCampaignId),
    });
    if (campaign?.scriptId) {
      scriptId = campaign.scriptId;
    }
  }

  const script = await resolveActiveScript(userId, scriptId);

  const greeting = script?.openingLine || agentConfig?.greeting || "Hi, thank you for calling. How can I help you today?";
  const voice = mapVoice(agentConfig?.voice);
  const configuredLang = agentConfig?.language || "en-US";

  // Create call log for this widget voice session
  const [callLog] = await db.insert(callLogsTable).values({
    userId,
    direction: "widget-voice" as any,
    phone: callerIdentity,
    outcome: "answered",
    aiModel: agentConfig?.aiModel || "gpt-4o-mini",
    startedAt: new Date(),
  }).returning();

  const callLogIdStr = String(callLog.id);
  callMetaCache.set(callLogIdStr, {
    userId,
    callSid: req.body.CallSid ?? undefined,
    crmMetadata: undefined,
    liveTranscript: [],
    scriptId: script?.id || null,
  });
  getCachedSystemPrompt(userId, { ...(agentConfig || {}), language: configuredLang }, script?.id || null).catch(() => {});

  // Set up <Gather> to collect the visitor's speech — identical to /twilio/inbound
  const connect = twiml.connect();
  const isLocal = baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1");
  const wsProto = isLocal ? "ws" : "wss";
  const streamUrl = `${baseUrl.replace(/^https?/, wsProto)}/ws/crm/calls/twilio-media-stream?callLogId=${callLog.id}`;
  connect.stream({ url: streamUrl });

  console.log(`[twilio/widget-voice] New widget call for user ${userId}, callLogId=${callLog.id}, caller=${callerIdentity}`);

  res.type("text/xml");
  res.send(twiml.toString());
});

export {
  callMetaCache,
  getCachedAgentConfig,
  getCachedSystemPrompt,
  resolveActiveScript,
  getCallMeta,
  isIndianLanguage,
  getTwilioLang,
  detectCallLanguage,
  callSarvamSTT,
  BULBUL_VOICE_FOR_LANG
};

export default router;
