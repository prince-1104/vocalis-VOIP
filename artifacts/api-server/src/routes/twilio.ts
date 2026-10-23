import { BULBUL_VOICE_FOR_LANG } from "../lib/voice-models";
import { Router, type IRouter } from "express";
import twilio from "twilio";
import { db, agentConfigsTable, callLogsTable, trainingDataTable, callingScriptsTable, tenantsTable, intentTrainingTable, campaignsTable, campaignContactsTable } from "@workspace/db";
import { eq, and, desc, sql } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { randomUUID } from "crypto";
import { crmEventBus } from "../lib/crm-event-bus";
import { classifyIntent, shouldTransfer, detectHumanRequest, type TransferRules } from "../lib/intent-classifier";
import { findBestAgent, buildTransferEventData } from "../lib/transfer-manager";
import { classifyProviderFailure, createUsageScope, estimateTokens, recordUsage, syncCallLogCosts, type UsageScope } from "../lib/billing/usage-ledger";
import { recordLlmCall, reportedUsage, type LlmUsage } from "../lib/billing/llm-usage";
import {
  outboundTelephonyProvider,
  recordCallTelephony,
  releaseTurnBudget,
  reserveCallBudget,
  reserveTurnBudget,
  settleCall,
  type CallLeg,
} from "../lib/billing/call-usage";
import { SpendLimitError } from "../lib/billing/spend-budget";
import { applyCampaignCallOutcome, dialNextForCampaign, triggerDialingForCampaign, tryMarkCampaignCompleted } from "../lib/campaign-dialer";
import { loadCampaignTransferRulesForCall } from "../lib/campaign-transfer";
import { fetchExternalCrmData, getExternalCrmCallFlow, type ExternalCrmContext, type ExternalCrmCallFlowConfig } from "../lib/external-crm-lookup";

import { twilioMediaIssuer, getOrCreateVerifiedCall } from "../lib/twilio-media-auth";
import { verifyTwilioCallWebhook } from "../lib/twilio-webhook-auth";
import { claimCallFinalization, releaseTransferSlot, reserveTransferSlot, transferCallbackUrls } from "../lib/transfer-slots";
import { mediaSessions, mediaPublicUrl } from "../lib/media-session";
import { logger } from "../lib/logger";
import { twilioAuthTokenFor } from "../lib/tenant-credentials";
import { providerHttpError } from "../lib/log-redaction";
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
  externalCrmContext?: ExternalCrmContext | null;
  externalCrmCallFlow?: ExternalCrmCallFlowConfig | null;
}
const callMetaCache = new Map<string, CallMeta>();

async function getCachedAgentConfig(userId: number): Promise<any> {
  const cached = agentConfigCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < AGENT_CONFIG_CACHE_TTL) return cached.data;
  const data = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });
  agentConfigCache.set(userId, { data, fetchedAt: Date.now() });
  return data;
}

async function getCachedSystemPrompt(
  userId: number,
  agentConfig: any,
  scriptId?: number | null,
  externalCrmContext?: ExternalCrmContext | null,
  externalCrmCallFlow?: ExternalCrmCallFlowConfig | null,
): Promise<string> {
  const crmSuffix = externalCrmContext ? `:crm:${externalCrmContext.fetchedAt}` : "";
  const flowSuffix = externalCrmCallFlow ? `:flow:${externalCrmCallFlow.maxAiInteractionSeconds}` : "";
  const key = `${userId}:${agentConfig.language ?? "en-US"}:${scriptId ?? "default"}${crmSuffix}${flowSuffix}`;
  const cached = systemPromptCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SYSTEM_PROMPT_CACHE_TTL) return cached.prompt;
  const prompt = await buildSystemPrompt(userId, agentConfig, scriptId, externalCrmContext, externalCrmCallFlow);
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

  let crmMetadata = log.crmMetadata as Record<string, unknown> | undefined;
  if (log.campaignId && !crmMetadata?.__transferRules) {
    const rules = await loadCampaignTransferRulesForCall(log.campaignId, log.userId);
    if (rules) {
      crmMetadata = {
        ...(crmMetadata || {}),
        __transferRules: rules,
        __campaignId: log.campaignId,
      };
    }
  }

  let externalCrmContext: ExternalCrmContext | null = null;
  let externalCrmCallFlow: ExternalCrmCallFlowConfig | null = null;
  if (log.phone) {
    const [crmCtx, callFlow] = await Promise.all([
      fetchExternalCrmData(log.userId, log.phone).catch(() => null),
      getExternalCrmCallFlow(log.userId).catch(() => null),
    ]);
    externalCrmContext = crmCtx;
    externalCrmCallFlow = callFlow;
  } else {
    externalCrmCallFlow = await getExternalCrmCallFlow(log.userId).catch(() => null);
  }

  const meta: CallMeta = {
    userId: log.userId,
    callSid: log.callSid ?? undefined,
    crmMetadata,
    liveTranscript: (log.liveTranscript as any) || [],
    scriptId,
    externalCrmContext,
    externalCrmCallFlow,
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

export function getBaseUrl(req: any): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    const first = domains.split(",")[0].trim();
    return `https://${first}`;
  }
  const host = req.headers.host || "localhost";
  const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
  return `${proto}://${host}`;
}

function getDefaultBaseUrl(): string {
  const domains = process.env.REPLIT_DOMAINS;
  if (domains) {
    return `https://${domains.split(",")[0].trim()}`;
  }
  return process.env.PUBLIC_BASE_URL || "https://dialog.noeticminds.com";
}

function attachCallStatusCallback(twiml: twilio.twiml.VoiceResponse, baseUrl: string, callLogId: number) {
  twiml.response.att("statusCallback", `${baseUrl}/api/twilio/status?callLogId=${callLogId}`);
  twiml.response.att("statusCallbackMethod", "POST");
  twiml.response.att("statusCallbackEvent", "completed");
}

const KB_ENTRY_MAX_CHARS = 500;
const KB_MAX_ENTRIES = 20;

const SUPPORTED_LANGUAGES_LINE =
  "You support these languages and MUST be able to converse in any of them: English (en-US), Hindi (hi-IN), Kannada (kn-IN), Tamil (ta-IN), Telugu (te-IN), and Marathi (mr-IN). NEVER tell the caller you only speak English or Hindi. If the caller asks for Kannada / Tamil / Telugu / Marathi, switch to that language immediately and continue the entire conversation in it.";

// IMPORTANT: Indian replies MUST be in NATIVE SCRIPT for correct Bulbul v3 TTS pronunciation.
// Romanized Kannada / Hindi etc. is read as English by the TTS engine and sounds wrong.
function buildScriptInstruction(language?: string | null): string {
  if (language === "hi-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Hindi using NATIVE Devanagari script (देवनागरी). Do NOT use romanized/Hinglish letters. Example: 'नमस्ते! मैं आपकी कैसे मदद कर सकती हूँ?'";
  }
  if (language === "kn-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Kannada using NATIVE Kannada script (ಕನ್ನಡ ಲಿಪಿ). Do NOT romanize. Example: 'ನಮಸ್ಕಾರ! ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಲ್ಲೆ?'";
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
    return "CRITICAL SCRIPT RULE: Detect the caller's language. Reply in their NATIVE script — Hindi → Devanagari, Kannada → ಕನ್ನಡ, Tamil → தமிழ், Telugu → తెలుగు, Marathi → मराठी. Never romanize Indian languages. Always use feminine verb forms.";
  }
  return "";
}

async function buildSystemPrompt(
  userId: number,
  agentConfig: any,
  scriptId?: number | null,
  externalCrmContext?: ExternalCrmContext | null,
  externalCrmCallFlow?: ExternalCrmCallFlowConfig | null,
): Promise<string> {
  const [trainingData, script] = await Promise.all([
    db.select().from(trainingDataTable).where(eq(trainingDataTable.userId, userId)).limit(KB_MAX_ENTRIES),
    resolveActiveScript(userId, scriptId),
  ]);

  let system = `You are ${agentConfig.agentName || "SalesBot"}, a female AI sales representative`;
  if (agentConfig.personality) system += ` with a ${agentConfig.personality} personality`;
  system += `. You are on a live phone call. Keep ALL responses under 2 sentences — be direct and conversational. Never mention you are an AI unless directly asked.\n\n`;

  // All Indian-language TTS voices (kavya, priya, pooja, simran) are female.
  // Instruct the LLM to use feminine grammar so verb conjugations match the voice.
  const feminineVoiceLangs = ["hi-IN", "kn-IN", "ta-IN", "te-IN", "mr-IN"];
  const effectiveLang = agentConfig.language ?? "en-US";
  if (feminineVoiceLangs.includes(effectiveLang) || effectiveLang === "auto") {
    system += `GENDER RULE: You are a FEMALE assistant. In Hindi use feminine verb forms — e.g. "मैं कर सकती हूँ" (sakti), NOT "मैं कर सकता हूँ" (sakta). Similarly use feminine forms in all Indian languages. This is critical for matching your voice.\n\n`;
  }

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

  if (externalCrmContext) {
    system += `CUSTOMER CONTEXT (fetched from CRM for the current caller):\n`;
    if (externalCrmContext.customerName) {
      system += `• Customer Name: ${externalCrmContext.customerName}\n`;
    }
    if (externalCrmContext.email) {
      system += `• Email: ${externalCrmContext.email}\n`;
    }
    if (externalCrmContext.accountId) {
      system += `• Account ID: ${externalCrmContext.accountId}\n`;
    }
    if (externalCrmContext.recentOrders) {
      system += `• Recent Orders/Activity: ${externalCrmContext.recentOrders}\n`;
    }
    if (externalCrmContext.rawData && Object.keys(externalCrmContext.rawData).length > 0) {
      for (const [key, val] of Object.entries(externalCrmContext.rawData)) {
        const display = typeof val === "object" ? JSON.stringify(val) : String(val);
        system += `• ${key}: ${display}\n`;
      }
    }
    system += `\nIMPORTANT: Use the above customer context to personalize the conversation. ` +
      `Address the customer by name if available. Reference their orders or account details when relevant. ` +
      `Do NOT read out raw IDs or technical fields unless the customer asks.\n`;
    system += `DATA ACCURACY: ONLY reference orders, statuses, and details EXPLICITLY listed above. ` +
      `Match order IDs EXACTLY — if the caller asks about an order ID not in your context, say you don't have it and list the IDs you do have. ` +
      `NEVER invent or guess order information.\n`;

    if (externalCrmContext.customerFound === false) {
      system += `The caller was NOT found in the CRM. Treat them as a new or unknown customer. ` +
        `Do not invent order history or account details.\n`;
    }

    system += "\n";
  }

  if (externalCrmCallFlow?.verifyIdentity && externalCrmContext?.customerFound) {
    system += `The caller has been identified by their phone number via CRM lookup. ` +
      `You already have their details — do NOT ask them to confirm their name or email. ` +
      `Use the CRM data directly to help them.\n\n`;
  } else if (externalCrmCallFlow?.verifyIdentity && !externalCrmContext?.customerFound) {
    system += `The caller was NOT found in the CRM by phone number. ` +
      `You may ask for their name to try to help, but do not demand email or account verification.\n\n`;
  }

  if (externalCrmCallFlow?.callInstructions?.trim()) {
    system += `CRM CALL INSTRUCTIONS:\n${externalCrmCallFlow.callInstructions.trim()}\n\n`;
  }

  const crmEndingPitch = externalCrmCallFlow?.endingPitch?.trim();
  if (script) {
    system += `CALL SCRIPT FLOW:\n`;
    const openingLine = externalCrmCallFlow?.openingPitch?.trim() || script.openingLine;
    system += `1. Start with the Opening line: "${openingLine}" (already spoken as greeting).\n`;
    if (script.pitchPoints && Array.isArray(script.pitchPoints) && (script.pitchPoints as string[]).length > 0) {
      system += `2. If the user agrees/shows interest, pitch these key points: ${(script.pitchPoints as string[]).slice(0, 3).join(" | ")}\n`;
    }
    const closingLine = crmEndingPitch || script.closingLine;
    if (closingLine) {
      system += `3. Wrap up the call or end the conversation by using the exact Closing line: "${closingLine}". Do NOT deviate from this phrasing when concluding.\n`;
    }
    system += "\n";
  } else if (crmEndingPitch) {
    system += `CALL CLOSING:\nWhen wrapping up, use this exact closing line: "${crmEndingPitch}".\n\n`;
  } else if (externalCrmCallFlow?.openingPitch?.trim()) {
    system += `CALL OPENING:\nThe opening line was already spoken as the greeting. Continue from there.\n\n`;
  }

  if (externalCrmCallFlow?.maxAiInteractionSeconds && externalCrmCallFlow.maxAiInteractionSeconds > 0) {
    const mins = Math.ceil(externalCrmCallFlow.maxAiInteractionSeconds / 60);
    system += `TIME LIMIT: This AI portion of the call is limited to about ${mins} minute(s). ` +
      `Keep answers concise and guide the caller toward resolution.\n\n`;
  }

  system += `After each response, ask one concise follow-up question to keep the conversation moving forward.`;
  return system;
}

interface LlmReply {
  text: string;
  provider: "openai" | "deepseek" | "sarvam";
  model: string;
  usage: LlmUsage | null;
}

type LlmPrompt = { system: string; history: { content: string }[]; user: string };

/** Allowance for the system prompt (agent instructions, script, training) when sizing a turn hold. */
const SPEECH_LOOP_PROMPT_TOKENS = 4000;

const promptTexts = (prompt: LlmPrompt) => [prompt.system, prompt.user, ...prompt.history.map((h) => h.content)];

function recordLlmUsage(scope: UsageScope, reply: Pick<LlmReply, "provider" | "model" | "usage">, prompt: LlmPrompt, outputText: string) {
  return recordLlmCall(scope, { ...reply, promptTexts: promptTexts(prompt), outputText });
}

/** Exact provider model a speech-loop turn is sent to (mirrors generateResponseForModel). */
function speechLoopModel(aiModel: string): { provider: LlmReply["provider"]; model: string } {
  if (aiModel === "deepseek-chat" || aiModel === "deepseek-v3") return { provider: "deepseek", model: "deepseek-chat" };
  if (aiModel === "sarvam-m" || aiModel === "sarvam-1-2b") return { provider: "sarvam", model: "sarvam-m" };
  return { provider: "openai", model: resolveOpenAIModel(aiModel) };
}

/** Records a failed LLM request that the provider may still have billed. */
function recordLlmFailure(scope: UsageScope, target: { provider: string; model: string }, prompt: LlmPrompt, err: unknown) {
  return recordLlmCall(scope, { ...target, usage: null, promptTexts: promptTexts(prompt), maxOutputTokens: 200, failure: err });
}

async function generateAIResponse(systemPrompt: string, history: {role: string, content: string}[], userMessage: string, model = "gpt-4o-mini"): Promise<LlmReply> {
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const completionPromise = openai.chat.completions.create({
    model,
    max_completion_tokens: 200,
    messages,
  });

  const response = await withTimeout(completionPromise, 4000, "OpenAI LLM timeout");

  return {
    text: response.choices[0]?.message?.content || "I'm sorry, I didn't catch that. Could you repeat that?",
    provider: "openai",
    model,
    usage: reportedUsage(response.usage),
  };
}

async function generateResponseForModel(
  systemPrompt: string,
  history: { role: string; content: string }[],
  userMessage: string,
  aiModel: string,
  lang: string,
): Promise<LlmReply> {
  if (aiModel === "deepseek-chat" || aiModel === "deepseek-v3") {
    return callDeepSeekLLM(systemPrompt, history, userMessage);
  }

  if (aiModel === "sarvam-m" || aiModel === "sarvam-1-2b") {
    return callSarvamLLM(systemPrompt, history, userMessage);
  }

  return generateAIResponse(systemPrompt, history, userMessage, resolveOpenAIModel(aiModel));
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
    throw providerHttpError("Sarvam STT", res.status, await res.text().catch(() => ""));
  }

  const data = await res.json() as any;
  return data.transcript ?? "";
}

async function callDeepSeekLLM(
  systemPrompt: string,
  history: {role: string, content: string}[],
  userMessage: string,
): Promise<LlmReply> {
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
    throw providerHttpError("DeepSeek", res.status, await res.text().catch(() => ""));
  }

  const data = await res.json() as any;
  return {
    text: data.choices?.[0]?.message?.content ?? "मुझे समझ नहीं आया, क्या आप दोबारा बोल सकते हैं?",
    provider: "deepseek",
    model: "deepseek-chat",
    usage: reportedUsage(data.usage),
  };
}

async function callSarvamLLM(
  systemPrompt: string,
  history: {role: string, content: string}[],
  userMessage: string,
): Promise<LlmReply> {
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
      max_completion_tokens: 200,
    }),
    timeout: 4000,
  });

  if (!res.ok) {
    throw providerHttpError("Sarvam-M", res.status, await res.text().catch(() => ""));
  }

  const data = await res.json() as any;
  return {
    text: data.choices?.[0]?.message?.content ?? "ಮತ್ತೊಮ್ಮೆ ಹೇಳುತ್ತೀರಾ?",
    provider: "sarvam",
    model: "sarvam-m",
    usage: reportedUsage(data.usage),
  };
}

// Sarvam Bulbul v3 voices, language-tuned for natural prosody.
// Kannada → "manan" is Sarvam's recommended showcase voice for clarity & accuracy.


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
    throw providerHttpError("Sarvam TTS", res.status, await res.text().catch(() => ""));
  }

  const data = await res.json() as any;
  const audioBase64: string | undefined = data.audios?.[0];
  if (!audioBase64) return null;
  return storeTtsAudio(audioBase64);
}

/** Records a TTS request by characters sent, the unit the TTS rates are quoted in. */
function recordTtsUsage(scope: UsageScope, provider: "openai" | "sarvam", text: string, failure?: unknown) {
  return scope.record({
    category: "tts",
    provider,
    model: provider === "sarvam" ? "bulbul:v3" : "tts-1",
    measurement: "actual",
    unit: "characters",
    quantity: text.length,
    outcome: failure === undefined ? "charged" : classifyProviderFailure(failure),
  });
}

/**
 * Sarvam TTS that records its own usage. Usage follows the provider request,
 * not the caller's timeout: a reply that arrives late was still billed.
 */
function sarvamTtsWithUsage(text: string, lang: string, scope: UsageScope, timeoutMs: number, label: string) {
  const request = callSarvamTTS(text, lang);
  const sent = normalizeTTSPronunciation(text, lang);
  request.then(
    (id) => { if (id) recordTtsUsage(scope, "sarvam", sent); },
    (err) => { recordTtsUsage(scope, "sarvam", sent, err); },
  );
  return withTimeout(request, timeoutMs, label);
}

async function openAiTtsWithUsage(text: string, voice: string, scope: UsageScope) {
  try {
    const b64 = await generateOpenAITTS(text, voice);
    recordTtsUsage(scope, "openai", text);
    return b64;
  } catch (err) {
    recordTtsUsage(scope, "openai", text, err);
    throw err;
  }
}

async function generateAIResponseIndic(
  systemPrompt: string,
  history: {role: string, content: string}[],
  userMessage: string,
  lang: string,
  usage: UsageScope,
): Promise<{ text: string; ttsAudioId: string | null }> {
  const llm = resolveSplitModelLLM(lang);

  logger.info({ event: "split_model_turn", lang, llm, tts: "bulbul:v3" }, "Split-model Indic turn");

  const prompt = { system: systemPrompt, history, user: userMessage };
  const reply = await (lang === "hi-IN"
    ? callDeepSeekLLM(systemPrompt, history, userMessage)
    : callSarvamLLM(systemPrompt, history, userMessage)
  ).catch((err: unknown) => {
    recordLlmFailure(usage, { provider: lang === "hi-IN" ? "deepseek" : "sarvam", model: llm }, prompt, err);
    throw err;
  });
  const text = reply.text;
  recordLlmUsage(usage, reply, prompt, text);

  let ttsAudioId: string | null = null;
  try {
    ttsAudioId = await sarvamTtsWithUsage(text, lang, usage, 2500, "Sarvam TTS timeout");
  } catch (ttsErr) {
    logger.error({ err: ttsErr, provider: "sarvam", lang }, "Sarvam TTS failed, falling back to Twilio <Say>");
  }

  return { text, ttsAudioId };
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

const CALL_OUTCOME_MAP: Record<string, string> = {
  completed: "answered",
  "no-answer": "no_answer",
  busy: "busy",
  failed: "no_answer",
  canceled: "no_answer",
};

/**
 * Where a call duration came from. Only signed Twilio callbacks are provider
 * evidence; unsigned Exotel callbacks and media-close wall time are estimates.
 */
export type CallDurationEvidence = "provider_callback" | "unverified_callback" | "media_close";

async function recordCompletionUsage(
  log: typeof callLogsTable.$inferSelect,
  callStatus: string,
  seconds: number,
  evidence: CallDurationEvidence,
) {
  const provider = log.direction === "outbound" ? await outboundTelephonyProvider(log.userId) : "twilio";
  const unanswered = seconds === 0 && callStatus !== "completed";
  // Twilio does not bill busy, failed, no-answer or canceled calls; an unsigned
  // callback or another provider's status is not evidence of a zero charge.
  const confirmedUnbilled = unanswered && evidence === "provider_callback" && (provider === "twilio" || provider === "twilio-sip");
  await recordCallTelephony(log, {
    provider,
    seconds,
    measurement: evidence === "provider_callback" ? "actual" : "estimated",
    outcome: confirmedUnbilled ? "not_charged" : unanswered ? "unknown" : "charged",
    reason: evidence,
  }).catch((err) => logger.error({ err, callLogId: log.id }, "Call telephony usage recording failed"));
}

export async function completeCallLog(
  callLogId: number,
  callStatus: string,
  callDuration: number,
  baseUrl?: string,
  evidence: CallDurationEvidence = "media_close",
) {
  if (!Object.hasOwn(CALL_OUTCOME_MAP, callStatus)) return;
  const existingLog = await db.query.callLogsTable.findFirst({
    where: eq(callLogsTable.id, callLogId),
  });
  if (!existingLog) return;

  // Rows finalized before finalized_at existed (and before the usage ledger).
  if (!existingLog.finalizedAt && existingLog.duration && existingLog.duration > 0 && existingLog.estimatedCostUsd) {
    return;
  }

  // Usage is recorded whether or not this callback wins finalization: a signed
  // callback arriving after a media-close estimate reconciles the estimate.
  await recordCompletionUsage(existingLog, callStatus, callDuration, evidence);
  if (existingLog.finalizedAt) {
    await syncCallLogCosts(callLogId).catch((err) => logger.error({ err, callLogId }, "Call cost sync failed"));
    return;
  }

  const formattedTranscript = (existingLog.liveTranscript && Array.isArray(existingLog.liveTranscript))
    ? existingLog.liveTranscript
        .map((turn: any) => `${turn.role === "user" ? "Caller" : "Agent"}: ${turn.content}`)
        .join("\n\n")
    : null;

  // Single conditional claim: duplicate or concurrent terminal callbacks lose
  // here and never re-emit call.ended or advance the campaign again.
  const won = await claimCallFinalization(callLogId, {
    outcome: CALL_OUTCOME_MAP[callStatus] || "no_answer",
    duration: callDuration,
    endedAt: existingLog.endedAt ?? new Date(),
    ...(formattedTranscript ? { transcript: formattedTranscript } : {}),
  });
  if (!won) {
    await syncCallLogCosts(callLogId).catch((err) => logger.error({ err, callLogId }, "Call cost sync failed"));
    return;
  }

  const costs = await settleCall(callLogId, "call_completed").catch((err) => {
    logger.error({ err, callLogId }, "Call budget settlement failed");
    return null;
  });
  const finalLog = await db.query.callLogsTable.findFirst({ where: eq(callLogsTable.id, callLogId) });
  crmEventBus.emitCallEvent({
    type: "call.ended",
    callId: callLogId,
    callSid: finalLog?.callSid || undefined,
    data: {
      outcome: CALL_OUTCOME_MAP[callStatus] || "no_answer",
      duration: callDuration,
      transcript: finalLog?.transcript || null,
      aiSummary: finalLog?.aiSummary || null,
      estimatedCostUsd: costs?.totalCost != null ? costs.totalCost.toString() : null,
      billedCostUsd: costs?.billedCost != null ? costs.billedCost.toString() : null,
      liveTranscript: finalLog?.liveTranscript || [],
    },
    metadata: finalLog?.crmMetadata as Record<string, unknown> | undefined,
    timestamp: new Date().toISOString(),
  });

  if (!existingLog.campaignId) return;
  await applyCampaignCallOutcome(existingLog, CALL_OUTCOME_MAP[callStatus] || "no_answer");
  if (!baseUrl) return;

  const campaign = await db.query.campaignsTable.findFirst({
    where: and(eq(campaignsTable.id, existingLog.campaignId), eq(campaignsTable.userId, existingLog.userId)),
  });
  if (!campaign) return;

  if (campaign.status === "active" && campaign.isAutomatic) {
    triggerDialingForCampaign(campaign.id, existingLog.userId, baseUrl).catch((err) => {
      logger.error({ err, campaignId: campaign.id }, "Auto dialing next contact failed");
    });
  } else if (campaign.status === "active") {
    tryMarkCampaignCompleted(campaign.id).catch((err) => {
      logger.error({ err, campaignId: campaign.id }, "Campaign completion check failed");
    });
  }
}

/**
 * Holds the expected telephony cost of an incoming (PSTN or widget) call before
 * it is answered. Over a hard limit, or when budget state is unavailable, the
 * call is rejected unanswered and its log is closed.
 */
async function holdIncomingCall(callLog: { id: number; userId: number }, leg: Extract<CallLeg, "inbound" | "client">): Promise<boolean> {
  try {
    await reserveCallBudget({
      userId: callLog.userId,
      provider: "twilio",
      leg,
      source: leg === "client" ? "widget-voice" : "inbound",
      key: `call:${callLog.id}`,
      callLogId: callLog.id,
    });
    return true;
  } catch (err) {
    if (!(err instanceof SpendLimitError)) throw err;
    logger.warn({ callLogId: callLog.id, code: err.code }, "Incoming call refused by spending limit");
    await claimCallFinalization(callLog.id, {
      outcome: "no_answer",
      duration: 0,
      endedAt: new Date(),
      transcript: "Call refused: usage limit reached.",
    }).catch((claimErr) => logger.error({ err: claimErr, callLogId: callLog.id }, "Refused call finalization failed"));
    return false;
  }
}

export async function finalizeCallLog(callLogId: number, startedAt?: Date | null) {
  const existingLog = await db.query.callLogsTable.findFirst({
    where: eq(callLogsTable.id, callLogId),
  });
  if (!existingLog || (existingLog.duration && existingLog.duration > 0)) return;

  const start = startedAt ?? existingLog.startedAt;
  const duration = start
    ? Math.max(1, Math.round((Date.now() - new Date(start).getTime()) / 1000))
    : 0;
  if (duration <= 0) return;

  await completeCallLog(callLogId, "completed", duration, getDefaultBaseUrl());
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
  const baseUrl = mediaPublicUrl("");

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

router.post("/twilio/inbound", twilioMediaIssuer("inbound"), async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const userId = req.verifiedMediaOwnerId!;
  if (!userId) {
    twiml.say("We're sorry, this number is not configured. Goodbye.");
    res.type("text/xml");
    res.send(twiml.toString());
    return;
  }

  const agentConfig = await getCachedAgentConfig(userId);

  const script = await resolveActiveScript(userId);

  const greeting = script?.openingLine || agentConfig?.greeting || "Hi, thank you for calling. How can I help you today?";
  const baseUrl = mediaPublicUrl("");

  const callLog = await getOrCreateVerifiedCall({
    userId,
    direction: "inbound",
    phone: req.body.From || "unknown",
    callSid: req.body.CallSid ?? null,
    outcome: "answered",
    aiModel: agentConfig?.aiModel || "gpt-4o-mini",
    startedAt: new Date(),
  });

  if (!await holdIncomingCall(callLog, "inbound")) {
    twiml.reject();
    res.type("text/xml");
    res.send(twiml.toString());
    return;
  }

  // ── Pre-warm caches for the first voice turn (fire-and-forget) ──────
  // By the time the caller finishes speaking (2–5s), these will be ready.
  const callLogIdStr = String(callLog.id);
  const callerPhone = req.body.From || "unknown";
  callMetaCache.set(callLogIdStr, {
    userId,
    callSid: req.body.CallSid ?? undefined,
    crmMetadata: undefined,
    liveTranscript: [],
    scriptId: script?.id || null,
    externalCrmContext: null,
    externalCrmCallFlow: null,
  });

  // Fire-and-forget: fetch external CRM data by caller phone number
  fetchExternalCrmData(userId, callerPhone).then(crmCtx => {
    const meta = callMetaCache.get(callLogIdStr);
    if (meta && crmCtx) {
      meta.externalCrmContext = crmCtx;
    }
  }).catch(() => {});

  getExternalCrmCallFlow(userId).then(flow => {
    const meta = callMetaCache.get(callLogIdStr);
    if (meta && flow) meta.externalCrmCallFlow = flow;
  }).catch(() => {});

  getCachedSystemPrompt(userId, { ...(agentConfig || {}), language: agentConfig?.language || "en-US" }, script?.id || null).catch(() => {});

  attachCallStatusCallback(twiml, baseUrl, callLog.id);

  const connect = twiml.connect();
  const streamUrl = mediaPublicUrl(`/ws/crm/calls/twilio-media-stream/${callLog.id}`, true);
  const stream = connect.stream({ url: streamUrl, dtmfDetection: 'inband' } as any);
  stream.parameter({ name: "mediaCredential", value: await mediaSessions.issue(callLog.id) });

  res.type("text/xml");
  res.send(twiml.toString());
});

router.post("/twilio/voice", verifyTwilioCallWebhook({ route: "voice", callIdParam: "callLogId", callSid: "match" }), async (req, res) => {
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
  const baseUrl = mediaPublicUrl("");
  const voice = mapVoice(agentConfig?.voice);
  const configuredLang = agentConfig?.language || "en-US";
  const aiModel = agentConfig?.aiModel || "gpt-4o-mini";

  // Auto-detect language from caller speech when configured language is "auto".
  let lang = configuredLang;
  if (configuredLang === "auto" && speechResult) {
    lang = detectCallLanguage(speechResult);
    logger.info({ callLogId, lang }, "Speech-loop language auto-detected");
  }

  let intentResult = { intent: "general_question", confidence: 1.0, needsHuman: false };
  let intentTraining = null;

  // Transfer rules come from cached CRM metadata — no extra DB query needed
  const transferRules = callMeta.crmMetadata?.__transferRules as TransferRules | undefined;
  const hasTransferRules = !!transferRules;

  const numericCallLogId = parseInt(callLogId, 10);
  const usage = createUsageScope({
    userId,
    callLogId: numericCallLogId,
    source: "speech-loop",
    keyPrefix: `call:${numericCallLogId}:gather:${randomUUID()}`,
  });
  if (!isSilent && req.body.SpeechResult) {
    usage.record({ category: "stt", provider: "twilio-gather", model: "gather-speech", measurement: "actual", unit: "requests", quantity: 1 });
  }

  if (!isSilent && speechResult.trim()) {
    const turnHold = await reserveTurnBudget({
      userId,
      callLogId: numericCallLogId,
      turnId: randomUUID(),
      estimate: {
        llmModels: [speechLoopModel(aiModel).model],
        inputTokens: SPEECH_LOOP_PROMPT_TOKENS + estimateTokens(speechResult, ...history.map((h) => h.content)),
        maxOutputTokens: 200,
        extraLlmCalls: hasTransferRules ? 1 : 0,
        ttsProviders: ["openai", "sarvam"],
      },
    }).catch((err: unknown) => {
      if (err instanceof SpendLimitError) return err;
      throw err;
    });
    if (turnHold instanceof SpendLimitError) {
      logger.warn({ callLogId, code: turnHold.code }, "Speech-loop turn refused by spending limit");
      twiml.say({ language: "en-US", voice: voice as any }, "We have to end this call now. Thank you for your time. Goodbye.");
      twiml.hangup();
      usage.flush().catch(() => {});
      res.type("text/xml");
      res.send(twiml.toString());
      return;
    }
    res.once("finish", () => {
      usage.flush().finally(() => releaseTurnBudget(turnHold));
    });

    // 1. Detect explicit "talk to human" request
    if (detectHumanRequest(speechResult)) {
      humanReqCount++;
      logger.info({ callLogId, humanReqCount }, "Speech-loop human request detected");
    }

    // 2. Classify intent (fast regex, LLM fallback only if transfer rules exist)
    //    Run in parallel with intentTraining DB lookup
    try {
      const classifyStart = Date.now();
      const [classifyResult, intentTrainingRow] = await Promise.all([
        classifyIntent(history, speechResult, hasTransferRules, usage),
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
      logger.error({ err: classifyErr, callLogId }, "Speech-loop intent classification failed");
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
            logger.info({ callLogId, intent: intentResult.intent }, "Speech-loop auto-transfer triggered");

            const callLogRow = await db.query.callLogsTable.findFirst({
              where: eq(callLogsTable.id, numId),
            });

            const transferringData = userId && callLogRow
              ? await buildTransferEventData(callLogRow, userId, {
                  transferTo: targetPhone,
                  reason: decision.reason,
                  intent: intentResult.intent,
                  crmAgentId: agentId,
                })
              : {
                  transferTo: targetPhone,
                  reason: decision.reason,
                  intent: intentResult.intent,
                  crmAgentId: agentId,
                };

            crmEventBus.emitCallEvent({
              type: "call.transferring",
              callId: numId,
              callSid: callMeta.callSid || undefined,
              userId: userId || undefined,
              data: transferringData,
              metadata: meta,
              timestamp: new Date().toISOString(),
            });

            const conferenceName = `auto-transfer-${numId}-${Date.now()}`;
            const callbacks = transferCallbackUrls(numId, conferenceName, lang);
            twiml.say("Please wait, your call is being transferred to our specialist. Please stay on the line.");
            const dial = twiml.dial();
            dial.conference(
              {
                statusCallback: callbacks.conferenceStatus,
                statusCallbackEvent: "join leave end" as any,
                startConferenceOnEnter: false,
                endConferenceOnExit: true,
                beep: "false",
                waitUrl: callbacks.holdMusic,
                waitMethod: "POST" as any,
              },
              conferenceName,
            );

            // The speech loop never reserved an agent slot; only bind the conference.
            await reserveTransferSlot(numId, userId, conferenceName);
            await db.update(callLogsTable)
              .set({
                transferredTo: targetPhone,
                transferReason: decision.reason,
                transferredAt: new Date(),
              })
              .where(eq(callLogsTable.id, numId));

            const agentConfig2 = await db.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId!) });
            const authToken2 = agentConfig2 ? twilioAuthTokenFor(agentConfig2) : null;
            if (agentConfig2?.twilioAccountSid && authToken2 && agentConfig2?.phoneNumber) {
              const client = twilio(agentConfig2.twilioAccountSid, authToken2);
              client.calls.create({
                to: targetPhone,
                from: agentConfig2.phoneNumber,
                twiml: `<Response><Dial><Conference startConferenceOnEnter="true" endConferenceOnExit="false" beep="false">${conferenceName}</Conference></Dial></Response>`,
                statusCallback: callbacks.agentCallStatus,
                statusCallbackMethod: "POST",
                statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
              }).then(async agentCall => {
                const transferredData = userId && callLogRow
                  ? await buildTransferEventData(callLogRow, userId, {
                      conferenceSid: conferenceName,
                      agentCallSid: agentCall.sid,
                      transferTo: targetPhone,
                      reason: decision.reason,
                      crmAgentId: agentId,
                    })
                  : {
                      conferenceSid: conferenceName,
                      agentCallSid: agentCall.sid,
                      transferTo: targetPhone,
                      reason: decision.reason,
                      crmAgentId: agentId,
                    };

                crmEventBus.emitCallEvent({
                  type: "call.transferred",
                  callId: numId,
                  callSid: callMeta.callSid || undefined,
                  userId: userId || undefined,
                  data: transferredData,
                  metadata: meta,
                  timestamp: new Date().toISOString(),
                });
              }).catch(err => logger.error({ err, callLogId }, "Speech-loop auto-transfer agent dial failed"));
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
    const basePrompt = await getCachedSystemPrompt(userId, promptConfig, callMeta?.scriptId, callMeta?.externalCrmContext, callMeta?.externalCrmCallFlow);

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
      const prompt = { system: systemPrompt, history, user: speechResult };
      const aiResult = await generateResponseForModel(systemPrompt, history, speechResult, aiModel, lang)
        .catch((err: unknown) => {
          recordLlmFailure(usage, speechLoopModel(aiModel), prompt, err);
          throw err;
        });
      aiResponse = aiResult.text;
      llmDuration = Date.now() - llmStart;
      recordLlmUsage(usage, aiResult, prompt, aiResponse);

      const useSarvamTts = isIndianLanguage(lang);
      const ttsStart = Date.now();
      const ttsResult = await (useSarvamTts
        ? sarvamTtsWithUsage(aiResponse, lang, usage, 2500, "TTS generation timeout")
        : withTimeout(openAiTtsWithUsage(aiResponse, agentConfig?.voice || "nova", usage), 2500, "TTS generation timeout")
          .then((b64) => storeTtsAudio(b64))
      ).catch(err => { logger.error({ err, callLogId }, "Speech-loop TTS generation failed"); return null; });
      ttsDuration = Date.now() - ttsStart;
      if (ttsResult) ttsAudioId = ttsResult;
    } catch (err) {
      logger.error({ err, callLogId }, "Speech-loop AI response failed");
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
        .catch(err => logger.error({ err, callLogId }, "Failed to update live transcript"));
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
  logger.info(
    { callLogId, classifyMs: classifyDuration, llmMs: llmDuration, ttsMs: ttsDuration, totalMs: totalDuration },
    "Speech-loop turn latency",
  );
  res.send(twiml.toString());
});

router.post("/twilio/voice-indic", verifyTwilioCallWebhook({ route: "voice-indic", callIdParam: "callLogId", callSid: "match" }), async (req, res) => {
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
  const baseUrl = mediaPublicUrl("");
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
      getCachedSystemPrompt(userId, { ...(agentConfig || {}), language: lang }, callMeta?.scriptId, callMeta?.externalCrmContext, callMeta?.externalCrmCallFlow),
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
        logger.info({ callLogId, intent: detectedIntent }, "Indic speech-loop used intent training data");
      }
    } catch (intentErr) {
      logger.error({ err: intentErr, callLogId }, "Indic speech-loop intent training lookup failed");
    }

    const callId = parseInt(callLogId, 10);
    const turnHold = await reserveTurnBudget({
      userId,
      callLogId: callId,
      turnId: randomUUID(),
      estimate: {
        llmModels: [resolveSplitModelLLM(lang)],
        inputTokens: SPEECH_LOOP_PROMPT_TOKENS + estimateTokens(speechResult, ...history.map((h) => h.content)),
        maxOutputTokens: 200,
        ttsProviders: ["sarvam"],
      },
    }).catch((err: unknown) => {
      if (err instanceof SpendLimitError) return err;
      throw err;
    });
    if (turnHold instanceof SpendLimitError) {
      logger.warn({ callLogId, code: turnHold.code }, "Indic speech-loop turn refused by spending limit");
      twiml.say({ language: "en-US", voice: "Polly.Raveena" }, "We have to end this call now. Thank you for your time. Goodbye.");
      twiml.hangup();
      res.type("text/xml");
      res.send(twiml.toString());
      return;
    }
    const usage = createUsageScope({
      userId,
      callLogId: callId,
      source: "speech-loop",
      keyPrefix: `call:${callId}:indic:${randomUUID()}`,
    });
    try {
      const indicResult = await generateAIResponseIndic(finalSystemPrompt, history, speechResult, lang, usage);
      aiResponse = indicResult.text;
      ttsAudioId = indicResult.ttsAudioId;
    } catch (err) {
      logger.error({ err, callLogId }, "Indic speech-loop AI response failed");
      aiResponse = "I'm sorry, I had a technical issue. Could you please repeat that?";
    } finally {
      usage.flush().finally(() => releaseTurnBudget(turnHold));
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
        .catch(err => logger.error({ err, callLogId }, "Failed to update live transcript"));
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
  logger.info({ callLogId, totalMs: totalDuration }, "Indic speech-loop turn latency");
  res.send(twiml.toString());
});

router.post("/twilio/outbound-voice", twilioMediaIssuer("outbound"), async (req, res) => {
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

  const baseUrl = mediaPublicUrl("");
  const voice = mapVoice(agentConfig?.voice);

  const connect = twiml.connect();
  const streamUrl = mediaPublicUrl(`/ws/crm/calls/twilio-media-stream/${callLogId}`, true);
  const stream = connect.stream({ url: streamUrl });
  stream.parameter({ name: "mediaCredential", value: await mediaSessions.issue(Number(callLogId)) });

  res.type("text/xml");
  res.send(twiml.toString());
});

const providerStatus = (value: unknown) =>
  typeof value === "string" && /^[a-z-]{1,32}$/.test(value) ? value : "unknown";

router.post(
  "/twilio/status",
  verifyTwilioCallWebhook({ route: "status", callIdParam: "callLogId", allowCallSidLookup: true, callSid: "bind", allowEnded: true }),
  async (req, res) => {
    const { call } = req.twilioWebhook!;
    const callStatus = providerStatus(req.body.CallStatus);
    const rawDuration = req.body.CallDuration;
    const callDuration = typeof rawDuration === "string" && /^[0-9]{1,6}$/.test(rawDuration) ? Number(rawDuration) : 0;

    await completeCallLog(call.id, callStatus, callDuration, mediaPublicUrl(""), "provider_callback");
    logger.info({ event: "twilio_status_callback", callLogId: call.id, providerStatus: callStatus }, "Twilio status callback");
    res.status(200).send("OK");
  },
);

// Transfer callbacks are bound to the call (signature + account + tenant) and
// to the specific conference via the signed `transfer` parameter, so stale or
// duplicate events from an earlier transfer cannot release the current slot.
const CONFERENCE_RELEASE_EVENTS = new Set(["participant-leave", "conference-end"]);
const AGENT_LEG_TERMINAL = new Set(["completed", "busy", "no-answer", "failed", "canceled"]);

function boundTransfer(req: { query: any; twilioWebhook?: { call: { conferenceSid: string | null } } }) {
  const transfer = req.query.transfer;
  return typeof transfer === "string" && transfer.length > 0 && req.twilioWebhook?.call.conferenceSid === transfer
    ? transfer
    : null;
}

router.post(
  "/twilio/conference-status",
  verifyTwilioCallWebhook({ route: "conference-status", callIdParam: "callId", callSid: "none", allowEnded: true }),
  async (req, res) => {
    const { call } = req.twilioWebhook!;
    const event = providerStatus(req.body.StatusCallbackEvent);
    const friendlyName = req.body.FriendlyName;
    let transfer = boundTransfer(req);
    if (transfer && friendlyName !== undefined && String(friendlyName).trim() !== transfer) transfer = null;
    const released = transfer && CONFERENCE_RELEASE_EVENTS.has(event)
      ? await releaseTransferSlot(call.id, transfer)
      : false;
    logger.info(
      { event: "twilio_conference_status", callLogId: call.id, providerEvent: event, currentTransfer: !!transfer, released },
      "Conference status callback",
    );
    res.status(200).send("OK");
  },
);

/**
 * A transfer adds a second outbound PSTN leg (the agent) and conference
 * participant time. The agent leg's duration comes from its signed status
 * callback; the conference has no configured rate and stays for reconciliation.
 */
async function recordTransferUsage(
  call: { id: number; userId: number; startedAt: Date | null },
  transfer: string,
  agentStatus: string,
  body: Record<string, unknown>,
) {
  const rawDuration = body.CallDuration;
  const seconds = typeof rawDuration === "string" && /^[0-9]{1,6}$/.test(rawDuration) ? Number(rawDuration) : 0;
  const agentCallSid = typeof body.CallSid === "string" && /^CA[0-9a-f]{32}$/i.test(body.CallSid) ? body.CallSid : null;
  const base = {
    userId: call.userId,
    callLogId: call.id,
    source: "transfer",
    category: "telephony" as const,
    provider: "twilio",
    unit: "call_seconds" as const,
    eventAt: call.startedAt ?? new Date(),
  };
  const answered = agentStatus === "completed" && seconds > 0;
  try {
    await recordUsage({
      ...base,
      model: "voice-outbound",
      leg: "outbound",
      providerRequestId: agentCallSid,
      idempotencyKey: `telephony:transfer:${call.id}:${transfer}:agent`,
      measurement: "actual",
      quantity: seconds,
      outcome: answered ? "charged" : "not_charged",
    });
    if (answered) {
      await recordUsage({
        ...base,
        model: "conference-participant",
        leg: "conference",
        idempotencyKey: `telephony:transfer:${call.id}:${transfer}:conference`,
        measurement: "estimated",
        quantity: seconds,
        metadata: { participants: 2 },
      });
    }
    await syncCallLogCosts(call.id);
  } catch (err) {
    logger.error({ err, callLogId: call.id }, "Transfer usage recording failed");
  }
}

router.post(
  "/twilio/agent-call-status",
  verifyTwilioCallWebhook({ route: "agent-call-status", callIdParam: "callId", callSid: "none", allowEnded: true }),
  async (req, res) => {
    const { call } = req.twilioWebhook!;
    const agentStatus = providerStatus(req.body.CallStatus);
    const transfer = boundTransfer(req);
    const terminal = AGENT_LEG_TERMINAL.has(agentStatus);
    const released = transfer && terminal
      ? await releaseTransferSlot(call.id, transfer)
      : false;
    if (transfer && terminal) await recordTransferUsage(call, transfer, agentStatus, req.body);
    logger.info(
      { event: "twilio_agent_call_status", callLogId: call.id, providerStatus: agentStatus, currentTransfer: !!transfer, released },
      "Agent call status callback",
    );
    res.status(200).send("OK");
  },
);

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
  twiml.redirect({ method: "POST" }, mediaPublicUrl(`/api/twilio/hold-music?lang=${encodeURIComponent(queryLang)}`));

  res.type("text/xml");
  res.send(twiml.toString());
});

// ── Widget Voice: Browser-to-AI voice calls via Twilio Client SDK ──────
// When a website visitor clicks the call button in the widget, the Twilio
// Client JS SDK connects via WebRTC. Twilio hits this webhook to get the
// initial TwiML. After that, the call flows through the existing /twilio/voice
// turn loop — identical to regular phone calls.
router.post("/twilio/widget-voice", twilioMediaIssuer("widget"), async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const baseUrl = mediaPublicUrl("");

  const callerIdentity = req.body.From || req.body.Caller || "widget-caller";
  const userId = req.verifiedMediaOwnerId!;

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
  const callLog = await getOrCreateVerifiedCall({
    userId,
    direction: "widget-voice" as any,
    phone: callerIdentity,
    callSid: req.body.CallSid ?? null,
    outcome: "answered",
    aiModel: agentConfig?.aiModel || "gpt-4o-mini",
    startedAt: new Date(),
  });

  if (!await holdIncomingCall(callLog, "client")) {
    twiml.reject();
    res.type("text/xml");
    res.send(twiml.toString());
    return;
  }

  const callLogIdStr = String(callLog.id);
  callMetaCache.set(callLogIdStr, {
    userId,
    callSid: req.body.CallSid ?? undefined,
    crmMetadata: undefined,
    liveTranscript: [],
    scriptId: script?.id || null,
    externalCrmContext: null,
    externalCrmCallFlow: null,
  });

  fetchExternalCrmData(userId, callerIdentity).then(crmCtx => {
    const meta = callMetaCache.get(callLogIdStr);
    if (meta && crmCtx) meta.externalCrmContext = crmCtx;
  }).catch(() => {});

  getExternalCrmCallFlow(userId).then(flow => {
    const meta = callMetaCache.get(callLogIdStr);
    if (meta && flow) meta.externalCrmCallFlow = flow;
  }).catch(() => {});

  getCachedSystemPrompt(userId, { ...(agentConfig || {}), language: configuredLang }, script?.id || null).catch(() => {});

  attachCallStatusCallback(twiml, baseUrl, callLog.id);

  const connect = twiml.connect();
  const streamUrl = mediaPublicUrl(`/ws/crm/calls/twilio-media-stream/${callLog.id}`, true);
  const stream = connect.stream({ url: streamUrl });
  stream.parameter({ name: "mediaCredential", value: await mediaSessions.issue(callLog.id) });

  logger.info({ event: "widget_voice_call_started", userId, callLogId: callLog.id }, "New widget voice call");

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
  BULBUL_VOICE_FOR_LANG,
};

export default router;
