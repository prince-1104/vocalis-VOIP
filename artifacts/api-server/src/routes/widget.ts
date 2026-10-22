import { mediaPublicUrl } from "../lib/media-session";
import { logger } from "../lib/logger";
import { twilioAuthTokenFor } from "../lib/tenant-credentials";
import { extractProviderCode, providerHttpError } from "../lib/log-redaction";
import { Router, type IRouter } from "express";
import { db, agentConfigsTable, callLogsTable, trainingDataTable, callingScriptsTable, externalCrmConfigsTable, type WidgetCustomerSession } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { randomUUID } from "crypto";
import { classifyProviderFailure, estimateTokens } from "../lib/billing/usage-ledger";
import { recordLlmCall, reportedUsage } from "../lib/billing/llm-usage";
import { createRequestMeter, type RequestMeter } from "../lib/billing/request-meter";
import { assertBudgetAvailable, SpendLimitError, spendLimitHttpStatus } from "../lib/billing/spend-budget";
import type { AiWorkEstimate } from "../lib/billing/estimates";
import {
  appendCrmContextToWidgetPrompt,
} from "../lib/widget-crm-orders";
import {
  ORDER_NOT_FOUND_MESSAGE,
  greetingFor,
  loadSessionOrder,
  resolveVerifiedOrder,
  resolveWidgetCrmSessionForChat,
  type WidgetCrmSession,
} from "../lib/widget-crm-session";
import { getWidgetVerification } from "../lib/widget-verification";
import { resolveActiveWidgetPolicy } from "../lib/widget-verification-policy";
import {
  POLICIES,
  enforceWidgetTenantBudget,
  widgetChatRateLimit,
  widgetConfigRateLimit,
  widgetCustomerSessionRateLimit,
  widgetTtsRateLimit,
  widgetVerificationRateLimits,
  widgetVoiceTokenRateLimit,
} from "../lib/rate-limit-policies";
import { clientAddress } from "../lib/rate-limit";
import {
  fireWidgetChatSessionStarted,
  fireWidgetChatTurn,
  loadWidgetChatHistory,
} from "../lib/widget-crm-chat-sync";
import {
  WIDGET_CHAT_LIMITS,
  WIDGET_CHAT_REJECTED_MESSAGE,
  assertServerAuthoredMessages,
  buildWidgetModelMessages,
  parseWidgetChatRequest,
  widgetChatSecurityPolicy,
  type WidgetChatTurn,
} from "../lib/widget-chat-security";

const router: IRouter = Router();

const SARVAM_API_KEY = process.env.SARVAM_API_KEY ?? "";
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? "";

const INDIAN_LANGUAGES = new Set(["kn-IN", "hi-IN", "ta-IN", "te-IN", "mr-IN"]);

// Sarvam Bulbul v3 voices — ALL female with native Indian accent.
// Speaker names below are validated against the bulbul:v3 speaker list returned
// by the Sarvam API: aditya, ashutosh, priya, neha, rahul, pooja, rohan,
// simran, kavya, amit, dev, ishita, shreya, ratan, varun, manan, sumit, roopa,
// kabir, aayan, shubh, advait, anand, tanya, tarun, sunny, mani, gokul, vijay,
// shruti, suhani, mohit, kavitha, rehan, soham, rupali, niharika.
// We pick female-sounding voices for every supported language.
const BULBUL_VOICE_FOR_LANG: Record<string, string> = {
  "hi-IN": "kavya",
  "kn-IN": "shreya",
  "ta-IN": "priya",
  "te-IN": "pooja",
  "mr-IN": "simran",
  "en-IN": "shreya",
  "en-US": "shreya",
};
// Known-female speaker names from the bulbul:v3 list — used as a safety net
// if the language map ever points to an unknown/male speaker.
const BULBUL_FEMALE_FALLBACKS = ["shreya", "kavya", "priya", "pooja", "simran", "neha", "ishita", "kavitha", "suhani", "niharika", "rupali", "tanya", "shruti"];

// For TTS we always speak with an Indian-accent female voice via Sarvam Bulbul.
// English maps to the en-IN target language code so the prosody is Indian.
function sarvamTargetLang(lang: string): string {
  if (lang === "en-US" || lang === "en-IN") return "en-IN";
  return lang;
}

function isIndianLanguage(lang?: string | null): boolean {
  return INDIAN_LANGUAGES.has(lang ?? "");
}

function isSarvamSupportedTTS(lang?: string | null): boolean {
  if (!lang) return false;
  return INDIAN_LANGUAGES.has(lang) || lang === "en-IN" || lang === "en-US";
}

// ── TTS pronunciation normalization ─────────────────────────────────────
// Sarvam Bulbul v3 reads Latin "e-Khata" as "ee-kkata" because it treats
// the standalone "e" prefix as a long vowel and over-aspirates "Kh".
// We rewrite brand terms to phonetically correct forms per language so
// the TTS output sounds natural.
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
  "en-IN": [
    // For English, use "ee" so Bulbul pronounces the long vowel (ई) with Indian accent
    { pattern: /\be[- ]?[Kk]hata\b/gi, replacement: "ee khata" },
  ],
  "en-US": [
    { pattern: /\be[- ]?[Kk]hata\b/gi, replacement: "ee khata" },
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

// ── Voice TTS sanitization ──────────────────────────────────────────────
// Strip contact details from TTS output so the bot doesn't read out phone
// numbers, emails, social handles, etc. The full text is still shown in chat.
function stripForVoiceTTS(text: string): string {
  let out = text;
  // Phone numbers: +91 63629 85767, 063629 85767, +91-636-29-85767, etc.
  out = out.replace(/(\+?\d{1,3}[\s.-]?)?(\(?\d{2,5}\)?[\s.-]?){1,4}\d{3,5}/g, '');
  // Email addresses
  out = out.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '');
  // Social media handles and references
  out = out.replace(/@[a-zA-Z0-9_]+/g, '');
  out = out.replace(/\b(Instagram|Facebook|Twitter|YouTube|WhatsApp|Telegram|LinkedIn)\b[^.!?।॥]*/gi, '');
  // URLs
  out = out.replace(/https?:\/\/\S+/gi, '');
  out = out.replace(/www\.[^\s]+/gi, '');
  // Google Play / App Store references
  out = out.replace(/\b(Google Play|Play Store|App Store|Chanakya App)\b[^.!?।॥]*/gi, '');
  // Clean up residual punctuation and whitespace
  out = out.replace(/,\s*,/g, ',').replace(/\.\s*\./g, '.').replace(/\s{2,}/g, ' ').trim();
  // Remove empty sentences (just punctuation left)
  out = out.replace(/^[\s,;.!?।॥]+/, '').replace(/[\s,;]+$/, '').trim();
  return out || text; // fallback to original if everything was stripped
}

async function generateSarvamWidgetTTS(text: string, lang: string): Promise<string | null> {
  if (!SARVAM_API_KEY || !isSarvamSupportedTTS(lang)) return null;

  const target = sarvamTargetLang(lang);
  const ttsText = normalizeTTSPronunciation(text, lang);
  const speaker = BULBUL_VOICE_FOR_LANG[lang] ?? BULBUL_VOICE_FOR_LANG[target] ?? BULBUL_FEMALE_FALLBACKS[0];
  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": SARVAM_API_KEY,
    },
    body: JSON.stringify({
      inputs: [ttsText],
      target_language_code: target,
      speaker,
      model: "bulbul:v3",
      temperature: 0.4,
      pace: 1.0,
      enable_preprocessing: true,
      output_audio_codec: "wav",
    }),
  });

  if (!res.ok) {
    throw providerHttpError("Sarvam widget TTS", res.status, await res.text().catch(() => ""));
  }

  const data = await res.json() as any;
  return data.audios?.[0] ?? null;
}

async function generateOpenAIWidgetTTS(text: string, voice: string): Promise<string> {
  const mp3 = await openai.audio.speech.create({
    model: "tts-1",
    voice: voice as any,
    input: text,
  });
  const arrayBuffer = await mp3.arrayBuffer();
  return Buffer.from(arrayBuffer).toString("base64");
}

const WIDGET_LIMIT_MESSAGE = "This assistant is temporarily unavailable. Please try again later.";
/** Allowance for the widget system prompt (agent instructions and knowledge base) when sizing a hold. */
const WIDGET_PROMPT_TOKENS = 6000;

/** Upper-bound hold for one chat request: reply plus arbiter and rewrite calls, and speech when requested. */
function widgetChatEstimate(message: string, history: { content: string }[], withSpeech: boolean): AiWorkEstimate {
  return {
    llmModels: ["gpt-4o-mini", "deepseek-chat", "sarvam-m"],
    inputTokens: WIDGET_PROMPT_TOKENS + estimateTokens(message, ...history.map((h) => h.content)),
    maxOutputTokens: 250,
    extraLlmCalls: 2,
    ttsProviders: withSpeech ? ["sarvam", "openai"] : [],
  };
}

function recordWidgetTts(meter: RequestMeter, provider: "sarvam" | "openai", characters: number, failure?: unknown) {
  meter.usage.record({
    category: "tts",
    provider,
    model: provider === "sarvam" ? "bulbul:v3" : "tts-1",
    measurement: "actual",
    unit: "characters",
    quantity: characters,
    outcome: failure === undefined ? "charged" : classifyProviderFailure(failure),
  });
}

/** Throws SpendLimitError (before any provider request) when the budget refuses the work. */
async function synthesizeWidgetTTS(
  text: string,
  voice: string,
  language: string,
  meter: RequestMeter,
): Promise<{ audio: string | null; provider: "sarvam" | "openai" | null; mimeType: string }> {
  await meter.ensureBudget();
  // Voice policy: ALWAYS female + Indian accent. Route every supported
  // language (including English) through Sarvam Bulbul v3 first.
  if (isSarvamSupportedTTS(language) && SARVAM_API_KEY) {
    const sent = normalizeTTSPronunciation(text, language).length;
    try {
      const sarvamAudio = await generateSarvamWidgetTTS(text, language);
      recordWidgetTts(meter, "sarvam", sent);
      if (sarvamAudio) return { audio: sarvamAudio, provider: "sarvam", mimeType: "audio/wav" };
    } catch (sarvamErr) {
      recordWidgetTts(meter, "sarvam", sent, sarvamErr);
      logger.error({ err: sarvamErr, provider: "sarvam", language }, "Widget Sarvam TTS failed, falling back to OpenAI");
    }
  }

  // OpenAI fallback only used if Sarvam is unavailable. Keep a female voice.
  try {
    const fallbackVoice = ["nova", "shimmer", "coral", "sage"].includes(voice) ? voice : "nova";
    const openAiAudio = await generateOpenAIWidgetTTS(text, fallbackVoice);
    recordWidgetTts(meter, "openai", text.length);
    return { audio: openAiAudio, provider: "openai", mimeType: "audio/mpeg" };
  } catch (openAiErr) {
    recordWidgetTts(meter, "openai", text.length, openAiErr);
    logger.error({ err: openAiErr, provider: "openai" }, "Widget OpenAI TTS failed");
    return { audio: null, provider: null, mimeType: "audio/mpeg" };
  }
}

const KB_ENTRY_MAX_CHARS = 800;
const KB_MAX_ENTRIES = 10;

// Voice gets a much smaller prompt for speed — short KB, short replies.
const KB_ENTRY_MAX_CHARS_VOICE = 400;
const KB_MAX_ENTRIES_VOICE = 5;

const SUPPORTED_LANGUAGES_LINE =
  "You support these languages and MUST be able to converse in any of them: English (en-US), Hindi (hi-IN), Kannada (kn-IN), Tamil (ta-IN), Telugu (te-IN), and Marathi (mr-IN). NEVER tell the user you only speak English or Hindi. If the user asks for Kannada / Tamil / Telugu / Marathi (in any script — e.g. 'in kannada', 'kannada me', 'ಕನ್ನಡದಲ್ಲಿ', 'कन्नड में', 'इन कनाडा लैंग्वेज'), switch to that language immediately and continue the entire conversation in it. NEVER ask the user to clarify which language they want when they have already named one.";

const TRANSLITERATION_LINE =
  "INPUT UNDERSTANDING: Users may transliterate freely — they might write English words using Devanagari/Kannada script (e.g. 'हाउ टू क्रिएट ए न्यू खाता' = 'how to create a new khata'), or write Indic words using Roman letters (e.g. 'nanage khata beku' = Kannada). DECODE their intent across scripts before answering. NEVER reply with a clarification question if the user's intent is reasonably clear — answer the actual question. Only ask for clarification when the message is genuinely empty or nonsensical.";

// IMPORTANT: Indian-language replies MUST be in NATIVE SCRIPT (not romanized).
// Sarvam Bulbul v3 TTS pronounces native scripts perfectly, but treats romanized
// text as English which causes the wrong-pronunciation bug we used to ship with.
function buildScriptInstruction(language?: string | null): string {
  if (language === "hi-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Hindi using NATIVE Devanagari script (देवनागरी). Do NOT use romanized Hinglish. Example: 'नमस्ते! मैं आपकी कैसे मदद कर सकता हूं?'";
  }
  if (language === "kn-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Kannada using NATIVE Kannada script (ಕನ್ನಡ ಲಿಪಿ). Do NOT romanize. Example: 'ನಮಸ್ಕಾರ! ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?'";
  }
  if (language === "ta-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Tamil using NATIVE Tamil script (தமிழ்). Do NOT romanize. Example: 'வணக்கம்! நான் உங்களுக்கு எப்படி உதவ முடியும்?'";
  }
  if (language === "te-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Telugu using NATIVE Telugu script (తెలుగు). Do NOT romanize. Example: 'నమస్కారం! నేను మీకు ఎలా సహాయం చేయగలను?'";
  }
  if (language === "mr-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Marathi using NATIVE Devanagari script (मराठी). Do NOT romanize. Example: 'नमस्कार! मी तुम्हाला कशी मदत करू शकतो?'";
  }
  if (language === "auto") {
    return "CRITICAL SCRIPT RULE: Detect the user's language from their message. Reply in their NATIVE script — Hindi → Devanagari (देवनागरी), Kannada → ಕನ್ನಡ, Tamil → தமிழ், Telugu → తెలుగు, Marathi → मराठी. Never romanize Indian languages. English questions → English reply.";
  }
  return "";
}

type LangCode = "en-US" | "hi-IN" | "kn-IN" | "ta-IN" | "te-IN" | "mr-IN";
const ALL_LANG_CODES: LangCode[] = ["en-US", "hi-IN", "kn-IN", "ta-IN", "te-IN", "mr-IN"];

// Detect language from native (Unicode) script ranges. This is the fastest and
// most reliable signal — far better than guessing from romanized hints.
// Returns the dominant script if it covers a meaningful portion of the message;
// short stray characters (e.g. "ಕನ್ನಡ" inside an English sentence) shouldn't flip
// the whole conversation.
function detectNativeScriptLanguage(text: string): { lang: LangCode; coverage: number } | null {
  const ranges: Array<{ re: RegExp; lang: LangCode }> = [
    { re: /[\u0C80-\u0CFF]/g, lang: "kn-IN" },
    { re: /[\u0B80-\u0BFF]/g, lang: "ta-IN" },
    { re: /[\u0C00-\u0C7F]/g, lang: "te-IN" },
    { re: /[\u0900-\u097F]/g, lang: "hi-IN" }, // shared with Marathi
  ];
  let best: { lang: LangCode; count: number } | null = null;
  for (const r of ranges) {
    const matches = text.match(r.re);
    const count = matches ? matches.length : 0;
    if (count > 0 && (!best || count > best.count)) best = { lang: r.lang, count };
  }
  if (!best) return null;
  // Marathi disambiguation in Devanagari range
  if (best.lang === "hi-IN" && /(आहे|नाही|पाहिजे|तुम्ही|मला|करतो|करते|कसा|कसे|माझ्या|तुझ्या)/.test(text)) {
    return { lang: "mr-IN", coverage: best.count / Math.max(1, text.length) };
  }
  return { lang: best.lang, coverage: best.count / Math.max(1, text.length) };
}

// Detect an EXPLICIT request to switch language. Works regardless of the script
// the request itself is written in (e.g. "explain in kannada", "कन्नड में बताओ",
// "ಕನ್ನಡದಲ್ಲಿ ಹೇಳಿ", "हिंदी में जवाब दो", "इन कनाडा लैंग्वेज", "speak english").
// Requires both a language name AND a switch-intent cue nearby to avoid false
// positives like a passing reference to a language.
function detectExplicitLanguageRequest(text: string): LangCode | null {
  const t = text;
  const lower = t.toLowerCase();

  const langPatterns: Array<{ lang: LangCode; res: RegExp[] }> = [
    {
      lang: "kn-IN",
      res: [
        /\b(kannada|kanada|kannad|kanad)\b/i,
        /ಕನ್ನಡ/,
        /कन्नड|कन्नडा|कन्नड़|कनाडा/,
      ],
    },
    {
      lang: "hi-IN",
      res: [
        /\b(hindi|hinglish|hindee)\b/i,
        /हिन्दी|हिंदी/,
        /ಹಿಂದಿ/,
      ],
    },
    {
      lang: "ta-IN",
      res: [/\b(tamil|tamizh)\b/i, /தமிழ்/, /तमिल/, /ತಮಿಳು/],
    },
    {
      lang: "te-IN",
      res: [/\b(telugu)\b/i, /తెలుగు/, /तेलुगू|तेलुगु/, /ತೆಲುಗು/],
    },
    {
      lang: "mr-IN",
      res: [/\b(marathi)\b/i, /मराठी/, /ಮರಾಠಿ/, /மராத்தி/],
    },
    {
      lang: "en-US",
      res: [
        /\b(english|englis|inglish|angrezi|angreji|englsh)\b/i,
        /अंग्रे(जी|ज़ी)|इंग्लिश|इंग्ल/,
        /ಇಂಗ್ಲಿಷ್|ಆಂಗ್ಲ/,
        /ஆங்கில|இங்கிலீஷ்/,
      ],
    },
  ];

  // Switch-intent cues across scripts/languages — must appear somewhere in the
  // message alongside a language name for us to treat it as a real request.
  const intentRe = new RegExp(
    [
      // English/Romanized
      "\\b(in|into|to|reply|answer|speak|talk|switch|change|use|explain|tell|say|translate|please|me|mein|me\\s+samjhao|me\\s+bata|dalli|language|lang)\\b",
      // Hindi/Devanagari
      "में|मे|में\\s|बताओ|समझाओ|बोलो|बोल|जवाब|दो|करो|कीजिए|भाषा|लैंग्वेज|बात",
      // Kannada
      "ದಲ್ಲಿ|ಹೇಳಿ|ಹೇಳು|ಮಾತಾಡಿ|ಮಾತು|ಭಾಷೆ|ಬದಲಿಸಿ",
      // Tamil
      "மொழி|பேசு|சொல்",
      // Telugu
      "భాష|మాట్లాడు|చెప్పు",
      // Marathi
      "मध्ये|बोला|भाषा|सांगा",
    ].join("|"),
    "i",
  );

  // First, very explicit phrases like "in <language>" / "<language> me".
  for (const { lang, res } of langPatterns) {
    for (const re of res) {
      if (re.test(t) || re.test(lower)) {
        if (intentRe.test(t) || intentRe.test(lower)) return lang;
      }
    }
  }
  return null;
}

// Common English function/content words. Used to confidently identify English
// even when a message contains domain terms (e.g. "ekhata", "BBMP", "ePID")
// that previously caused false positives in the Indic hint scorer.
const ENGLISH_COMMON_WORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","am",
  "i","you","he","she","it","we","they","me","my","your","our","their","us","him","her",
  "and","or","but","if","then","else","not","no","yes","ok","okay",
  "to","of","in","on","at","for","with","by","from","about","over","under","into","onto",
  "what","when","where","why","how","who","which","whom","whose",
  "can","could","would","should","do","does","did","done","have","has","had","will","may","might","must","shall",
  "tell","show","help","know","want","need","get","give","make","go","see","say","said","find","take","put","let",
  "this","that","these","those","there","here","very","more","some","any","all","every","each","such","other","another",
  "please","thanks","thank","sorry","hi","hello","hey","yes","no","please","good","fine","sure",
  "abot","abt","u","r","ur","pls","plz","thx","ty",
]);

function englishWordRatio(text: string): { ratio: number; words: number } {
  const cleaned = text.toLowerCase().replace(/[^a-z\s]/g, " ");
  const words = cleaned.split(/\s+/).filter(w => w.length >= 1);
  if (words.length === 0) return { ratio: 0, words: 0 };
  const matched = words.filter(w => ENGLISH_COMMON_WORDS.has(w)).length;
  return { ratio: matched / words.length, words: words.length };
}

function detectRomanizedHints(text: string): { lang: LangCode; score: number } | null {
  const lower = text.toLowerCase();
  // NOTE: domain terms like "khata" / "ekhata" are intentionally NOT in the
  // Kannada list — they are language-neutral (used freely in English/Hindi too)
  // and were causing English questions like "tell me about ekhata" to be
  // misrouted as Kannada.
  const kannadaHints = [
    "nanag", "nanage", "nanu", "nanna", "beku", "bekagittu", "bagge", "yaake", "yake",
    "yenu", "ide", "illa", "kodti", "kodutte", "heli", "tilsi", "saku",
    "namaskara", "hege", "yelli", "yaaru", "maadi", "maadu", "maadta", "maaduttare",
    "swalpa", "thumba", 
    // Added to catch Voice transcription phonetics (e.g., Whisper translating 
    // "bekada dakhalegalu" as "bekadar Aakhri Guru"):
    "bekad", "bekada", "dakhale", "dakhal", "arji", "araji", "hesaru", "badalavane", 
    "aasti", "asti", "nondani", "madoke", "madodu", "kodi", "kodu", "galu", "galannu"
  ];
  const hindiHints = [
    "mujhe", "mujh", "aap", "kya", "kaise", "hai", "hain", "nahi", "chahiye", "karna",
    "meri", "mera", "hum", "batao", "samjhao", "kar sakte", "ke baare", "thoda",
    "bata", "bataa", "samajh", "krpya", "kripya",
    "dastavez", "kagaz", "jankari", "naam", "badal", "kaha", "kahan", "nyayalay", "aadesh"
  ];
  const tamilHints = ["enna", "yenna", "naan", "naangal", "ennoda", "konjam", "vendam", "venum", "irukku", "panra", "panren", "aavanam"];
  const teluguHints = ["nenu", "meeru", "enti", "emi", "kavali", "kavalsina", "chestunna", "chestunnaru", "ela", "patralu"];
  const marathiHints = ["mala", "tula", "tumhi", "kasa", "kase", "ahe", "pahije", "karto", "kartoy", "kagad"];

  const score = (hints: string[]) => hints.reduce((acc, token) => acc + (lower.includes(token) ? 1 : 0), 0);
  const ranked = ([
    { lang: "kn-IN" as LangCode, s: score(kannadaHints) },
    { lang: "hi-IN" as LangCode, s: score(hindiHints) },
    { lang: "ta-IN" as LangCode, s: score(tamilHints) },
    { lang: "te-IN" as LangCode, s: score(teluguHints) },
    { lang: "mr-IN" as LangCode, s: score(marathiHints) },
  ] as Array<{ lang: LangCode; s: number }>).sort((a, b) => b.s - a.s);
  
  // Return even weak signals (score 1) so the arbitrator can decide if needed
  if (ranked[0].s >= 1) return { lang: ranked[0].lang, score: ranked[0].s };
  return null;
}

// Use a tiny, fast LLM call to arbitrate ambiguous cases (e.g. user writing in
// Devanagari but explicitly asking for Kannada, or mixed transliteration). The
// model is constrained to output ONLY a BCP-47 code, so the latency hit is
// minimal (~one token) and the accuracy is high.
async function llmResolveLanguage(
  message: string,
  history: { role: string; content: string }[],
  sessionLanguage: string | null,
  meter: RequestMeter,
): Promise<LangCode | null> {
  await meter.ensureBudget();
  try {
    const recent = history
      .slice(-4)
      .map(h => `${h.role === "assistant" ? "BOT" : "USER"}: ${(h.content || "").slice(0, 200)}`)
      .join("\n");
    const sys = [
      "You are a language router. Output EXACTLY one BCP-47 code from this set and NOTHING else:",
      "en-US, hi-IN, kn-IN, ta-IN, te-IN, mr-IN.",
      "Decide which language the assistant should reply in for the LATEST user message.",
      "Rules (in priority order):",
      "1. If the user explicitly asks to switch language (e.g. 'in kannada', 'reply in hindi', 'कन्नड में बताओ', 'ಕನ್ನಡದಲ್ಲಿ ಹೇಳಿ', 'इन कनाडा लैंग्वेज', 'english me'), output that language. Cross-script mentions count.",
      "2. Otherwise mirror the language the user is writing in (Devanagari → hi-IN unless clearly Marathi; Kannada script → kn-IN; Tamil → ta-IN; Telugu → te-IN).",
      "3. Romanized Indic with strong markers: nanu/maadi/beku/bekada/arji/dakhale → kn-IN, mujhe/aap/kya/dastavez → hi-IN, naan/enna → ta-IN, nenu/meeru → te-IN, mala/tumhi → mr-IN.",
      "4. Voice Transcription Artifacts: Sometimes English voice models aggressively mis-transcribe Kannada into Hindi/English-sounding words (e.g., 'bekadar' for bekada, 'Aakhri Guru' for dakhalegalu, 'nyayalay Aadesh'). If it looks like butchered Kannada phonetics about eKhata, route to kn-IN.",
      "5. Domain terms like 'BBMP', 'e-Khata', 'ekhata', 'khata', 'ePID', 'PID', 'amalgamation' are LANGUAGE-NEUTRAL — used freely in English, Hindi and Kannada. Do NOT use them as language signals.",
      "6. If the user writes plainly in English (e.g. 'can you tell me about ekhata', 'how do I apply') reply in en-US — even if the prior turn was Indic. The user is switching back.",
      "7. Default en-US only when nothing else applies.",
      sessionLanguage ? `Previous session language was: ${sessionLanguage}.` : "",
      "Output the code only. No quotes. No explanation.",
    ].filter(Boolean).join("\n");
    const userBlock = `${recent ? recent + "\n" : ""}USER (latest): ${message.slice(0, 500)}`;
    const llmCall = { provider: "openai", model: "gpt-4o-mini", promptTexts: [sys, userBlock], maxOutputTokens: 6, key: "language-arbiter" };
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_completion_tokens: 6,
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userBlock },
      ],
    }).catch((err: unknown) => {
      recordLlmCall(meter.usage, { ...llmCall, usage: null, failure: err });
      throw err;
    });
    recordLlmCall(meter.usage, { ...llmCall, usage: reportedUsage(completion.usage), outputText: completion.choices[0]?.message?.content });
    const raw = (completion.choices[0]?.message?.content || "").trim();
    const code = raw.replace(/[^a-zA-Z-]/g, "");
    const found = ALL_LANG_CODES.find(c => c.toLowerCase() === code.toLowerCase());
    return found ?? null;
  } catch (err) {
    logger.error({ err, provider: "openai" }, "Widget language resolution failed");
    return null;
  }
}

// Resolve effective language with a layered, intelligent strategy:
//   (a) Configured language (non-auto) wins always.
//   (b) Explicit cross-script switch request in the latest message wins next.
//   (c) Strong native-script signal in the latest message.
//   (d) Romanized hints with score ≥ 2.
//   (e) Sticky session language (last assistant reply / client-tracked).
//   (f) Last user-detected language in history.
//   (g) LLM arbiter for any remaining ambiguity / mixed-script content.
//   (h) Fall back to en-US.
async function resolveEffectiveWidgetLanguage(
  configuredLanguage: string | null | undefined,
  message: string,
  history: { role: string; content: string }[],
  sessionLanguage: string | null | undefined,
  meter: RequestMeter,
): Promise<{ lang: LangCode; source: string }> {
  if (configuredLanguage && configuredLanguage !== "auto") {
    const cfg = ALL_LANG_CODES.find(c => c === configuredLanguage);
    if (cfg) return { lang: cfg, source: "configured" };
  }

  const explicit = detectExplicitLanguageRequest(message);
  if (explicit) return { lang: explicit, source: "explicit-request" };

  const native = detectNativeScriptLanguage(message);
  // Strong native script signal: at least 4 native-script chars OR coverage > 30%.
  const nativeCharCount = (message.match(/[\u0900-\u097F\u0980-\u09FF\u0A80-\u0AFF\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/g) || []).length;
  if (native && (nativeCharCount >= 4 || (native.coverage ?? 0) > 0.3)) {
    return { lang: native.lang, source: "native-script" };
  }

  // Strong English signal — message is plainly English ASCII with common
  // English words and no native script. This must beat romanized Indic hints
  // and sticky session language so the user can switch back to English at any
  // turn (e.g. "can u tell me about ekhata" must NOT be routed as Kannada).
  const eng = englishWordRatio(message);
  const hasNativeChars = nativeCharCount > 0;
  const isPlainlyEnglish =
    !hasNativeChars && eng.words >= 2 && (eng.ratio >= 0.4 || (eng.ratio >= 0.25 && eng.words >= 5));
  if (isPlainlyEnglish) {
    return { lang: "en-US", source: "english-words" };
  }

  const romanized = detectRomanizedHints(message);
  // Romanized-strong only fires when there's no competing English signal.
  if (romanized && romanized.score >= 2 && eng.ratio < 0.3) {
    return { lang: romanized.lang, source: "romanized-strong" };
  }

  // Truly ambiguous: only call the LLM arbiter when heuristics GENUINELY
  // conflict, NOT for weak signals. Tightened thresholds to avoid the
  // 400-800ms LLM call on the majority of turns.
  const conflictingSignals =
    (native && romanized && native.lang !== romanized.lang) ||
    (hasNativeChars && eng.ratio >= 0.45) ||
    (romanized && romanized.score >= 2 && eng.ratio >= 0.2 && eng.ratio < 0.4) ||
    (romanized && romanized.score === 1 && eng.words === 0); // Whisper phonetic artifact
    
  if (conflictingSignals) {
    // The arbiter is optional: over the budget the heuristics below decide.
    const arbiter = await llmResolveLanguage(message, history, sessionLanguage ?? null, meter)
      .catch((err: unknown) => {
        if (err instanceof SpendLimitError) return null;
        throw err;
      });
    if (arbiter) return { lang: arbiter, source: "llm-arbiter" };
  }

  if (native) return { lang: native.lang, source: "native-script-weak" };
  if (romanized && romanized.score >= 2 && eng.ratio < 0.3) return { lang: romanized.lang, source: "romanized-weak" };

  // Sticky session: keep the previously established language so a quick
  // confirmation ("ok", "yes") doesn't flip the conversation. We only stick
  // when the current message had no clear language signal at all.
  if (sessionLanguage && sessionLanguage !== "auto" && ALL_LANG_CODES.includes(sessionLanguage as LangCode)) {
    // But if the current message is mostly ASCII English-looking, prefer English
    // over a sticky Indic session — this is what enables real-time switching.
    if (!hasNativeChars && eng.ratio >= 0.25) {
      return { lang: "en-US", source: "english-override" };
    }
    return { lang: sessionLanguage as LangCode, source: "session-sticky" };
  }

  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn.role !== "user") continue;
    const h = detectNativeScriptLanguage(turn.content || "");
    if (h) return { lang: h.lang, source: "history-native" };
    const r = detectRomanizedHints(turn.content || "");
    if (r) return { lang: r.lang, source: "history-romanized" };
  }

  return { lang: "en-US", source: "default" };
}

// Strip stray romanization the LLM might still output (e.g. "Namaskara"
// appearing inside Devanagari text) and trim to a single short reply.
function normalizeIndicReply(reply: string, language: string): string {
  // Strip <think> tags that DeepSeek/other models might generate
  let cleaned = reply.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  
  if (!isIndianLanguage(language)) return cleaned;
  // Replace English greetings the model occasionally code-switches into.
  return cleaned
    .replace(/^(Hi|Hello|Hey)[!,.]?\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

const NATIVE_SCRIPT_REGEX_FOR_LANG: Record<string, RegExp> = {
  "hi-IN": /[\u0900-\u097F]/g,
  "mr-IN": /[\u0900-\u097F]/g,
  "kn-IN": /[\u0C80-\u0CFF]/g,
  "ta-IN": /[\u0B80-\u0BFF]/g,
  "te-IN": /[\u0C00-\u0C7F]/g,
};

// Detect when an Indic-language reply is mostly Latin (romanized) instead of
// the required native script. Brand terms (BBMP, e-Khata, ePID, URLs) and
// digits/punctuation are excluded from the calculation so they don't penalise
// otherwise-good native-script replies.
function isIndicReplyRomanized(reply: string, language: string): boolean {
  const nativeRe = NATIVE_SCRIPT_REGEX_FOR_LANG[language];
  if (!nativeRe) return false;
  const cleaned = reply
    .replace(/\b(BBMP|e-?Khata|ePID|PID|API|URL|GST|PAN)\b/gi, "")
    .replace(/https?:\/\/\S+|www\.\S+/gi, "")
    .replace(/\[[^\]]+\]\([^)]+\)/g, "");
  const latinChars = (cleaned.match(/[a-zA-Z]/g) || []).length;
  const nativeChars = (cleaned.match(nativeRe) || []).length;
  // Need a meaningful sample. If reply has very few alphabetic chars overall,
  // assume it's fine (e.g. "ok!" or short brand-only response).
  if (latinChars + nativeChars < 10) return false;
  // Romanized if > 40% of alphabetic content is Latin AND native is < 50%.
  const latinRatio = latinChars / (latinChars + nativeChars);
  return latinRatio > 0.4;
}

// Rewrite a romanized Indic reply to native script using gpt-4o-mini. This is
// only invoked as a corrective step when the primary model returns the wrong
// script. Adds ~600ms to the slow path but preserves the conversation quality.
async function rewriteToNativeScript(
  reply: string,
  language: string,
  meter: RequestMeter,
): Promise<string | null> {
  const langInfo: Record<string, { name: string; script: string; example: string }> = {
    "hi-IN": { name: "Hindi", script: "Devanagari (देवनागरी)", example: "नमस्ते! मैं आपकी मदद कर सकता हूं।" },
    "kn-IN": { name: "Kannada", script: "Kannada script (ಕನ್ನಡ ಲಿಪಿ)", example: "ನಮಸ್ಕಾರ! ನಾನು ನಿಮಗೆ ಸಹಾಯ ಮಾಡುತ್ತೇನೆ." },
    "ta-IN": { name: "Tamil", script: "Tamil script (தமிழ்)", example: "வணக்கம்! நான் உங்களுக்கு உதவுகிறேன்." },
    "te-IN": { name: "Telugu", script: "Telugu script (తెలుగు)", example: "నమస్కారం! నేను మీకు సహాయం చేస్తాను." },
    "mr-IN": { name: "Marathi", script: "Devanagari (देवनागरी)", example: "नमस्कार! मी तुम्हाला मदत करतो." },
  };
  const info = langInfo[language];
  if (!info) return null;
  await meter.ensureBudget();
  try {
    const system = `You are a transliteration assistant. Rewrite the user's text in NATIVE ${info.script}. Preserve the meaning and tone EXACTLY — do not add, remove or summarise. Keep brand names like BBMP, e-Khata, ePID, PID and URLs in their original Latin form. Output only the rewritten text. Example: ${info.example}`;
    const llmCall = { provider: "openai", model: "gpt-4o-mini", promptTexts: [system, reply], maxOutputTokens: 200, key: "native-rewrite" };
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_completion_tokens: 200,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: reply },
      ],
    }).catch((err: unknown) => {
      recordLlmCall(meter.usage, { ...llmCall, usage: null, failure: err });
      throw err;
    });
    recordLlmCall(meter.usage, { ...llmCall, usage: reportedUsage(completion.usage), outputText: completion.choices[0]?.message?.content });
    const rewritten = completion.choices[0]?.message?.content?.trim();
    if (!rewritten) return null;
    // Sanity check — make sure the rewrite is actually in native script now.
    if (isIndicReplyRomanized(rewritten, language)) return null;
    return rewritten;
  } catch (err) {
    logger.error({ err, provider: "openai", language }, "Widget native-script rewrite failed");
    return null;
  }
}

async function ensureNativeScript(
  reply: string,
  language: string,
  meter: RequestMeter,
): Promise<{ reply: string; rewrote: boolean }> {
  if (!isIndianLanguage(language)) return { reply, rewrote: false };
  if (!isIndicReplyRomanized(reply, language)) return { reply, rewrote: false };
  logger.warn({ language }, "Widget romanized output detected, rewriting");
  const rewritten = await rewriteToNativeScript(reply, language, meter);
  if (rewritten) return { reply: rewritten, rewrote: true };
  return { reply, rewrote: false };
}

// Lightweight in-process circuit breaker for upstream providers. Once a
// provider returns a hard "we are unusable" error (auth/billing), we stop
// hitting it for `cooldownMs` so we don't spam logs and waste latency on every
// turn — the fallback chain takes over instantly.
type BreakerState = { until: number; reason: string };
const providerBreakers: Record<string, BreakerState> = {};
function isProviderTripped(name: string): string | null {
  const b = providerBreakers[name];
  if (!b) return null;
  if (Date.now() < b.until) return b.reason;
  delete providerBreakers[name];
  return null;
}
function tripProvider(name: string, reason: string, cooldownMs: number) {
  providerBreakers[name] = { until: Date.now() + cooldownMs, reason };
  logger.warn({ provider: name, cooldownMs, reason }, "Widget provider circuit opened");
}

interface LLMResult {
  content: string;
}

type WidgetModelMessages = ReturnType<typeof buildWidgetModelMessages>;

/** Records a widget LLM request; HTTP errors carry their status so they count as not billed. */
function widgetLlmRecorder(meter: RequestMeter, provider: string, model: string, messages: WidgetModelMessages, maxOutputTokens: number) {
  const base = { provider, model, promptTexts: messages.map((m) => String(m.content)), maxOutputTokens };
  return {
    success: (usage: unknown, outputText: string | null | undefined) =>
      recordLlmCall(meter.usage, { ...base, usage: reportedUsage(usage), outputText }),
    failure: (failure: unknown) => recordLlmCall(meter.usage, { ...base, usage: null, failure }),
  };
}

async function callDeepSeekChat(
  messages: WidgetModelMessages,
  meter: RequestMeter,
  maxTokens: number = 250,
): Promise<LLMResult | null> {
  if (!DEEPSEEK_API_KEY) return null;
  assertServerAuthoredMessages(messages);
  const tripped = isProviderTripped("deepseek");
  if (tripped) {
    logger.info({ provider: "deepseek", reason: tripped }, "Widget provider skipped (circuit open)");
    return null;
  }
  await meter.ensureBudget();
  const record = widgetLlmRecorder(meter, "deepseek", "deepseek-chat", messages, maxTokens);
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages,
        max_tokens: maxTokens,
        temperature: 0.4,
      }),
    });
    if (!res.ok) {
      record.failure({ status: res.status });
      const providerCode = extractProviderCode(await res.text().catch(() => ""));
      logger.error({ provider: "deepseek", status: res.status, providerCode }, "Widget DeepSeek request failed");
      // Insufficient balance / auth → don't hammer the provider for 10 minutes
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        tripProvider("deepseek", `${res.status} ${providerCode ?? ""}`.trim(), 10 * 60 * 1000);
      } else if (res.status === 429) {
        tripProvider("deepseek", "rate-limit", 60 * 1000);
      }
      return null;
    }
    const data = await res.json() as any;
    const content: string | null = data.choices?.[0]?.message?.content ?? null;
    record.success(data.usage, content);
    if (!content) return null;
    return { content };
  } catch (err) {
    record.failure(err);
    logger.error({ err, provider: "deepseek" }, "Widget DeepSeek request threw");
    return null;
  }
}

async function callSarvamChat(
  messages: WidgetModelMessages,
  meter: RequestMeter,
): Promise<LLMResult | null> {
  if (!SARVAM_API_KEY) return null;
  assertServerAuthoredMessages(messages);
  const tripped = isProviderTripped("sarvam-m");
  if (tripped) {
    logger.info({ provider: "sarvam-m", reason: tripped }, "Widget provider skipped (circuit open)");
    return null;
  }
  await meter.ensureBudget();
  const record = widgetLlmRecorder(meter, "sarvam", "sarvam-m", messages, 250);
  try {
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SARVAM_API_KEY}`,
      },
      body: JSON.stringify({
        model: "sarvam-m",
        messages,
        max_completion_tokens: 250,
      }),
    });
    if (!res.ok) {
      record.failure({ status: res.status });
      const providerCode = extractProviderCode(await res.text().catch(() => ""));
      logger.error({ provider: "sarvam-m", status: res.status, providerCode }, "Widget Sarvam-M request failed");
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        tripProvider("sarvam-m", `${res.status} ${providerCode ?? ""}`.trim(), 10 * 60 * 1000);
      } else if (res.status === 429) {
        tripProvider("sarvam-m", "rate-limit", 60 * 1000);
      }
      return null;
    }
    const data = await res.json() as any;
    const content: string | null = data.choices?.[0]?.message?.content ?? null;
    record.success(data.usage, content);
    if (!content) return null;
    return { content };
  } catch (err) {
    record.failure(err);
    logger.error({ err, provider: "sarvam-m" }, "Widget Sarvam-M request threw");
    return null;
  }
}

// Pipeline routing per language.
//   en-US  → gpt-4o-mini   (fastest, OpenAI TTS downstream)
//   hi-IN  → DeepSeek V3  → Sarvam Bulbul TTS (Devanagari)
//   kn-IN  → Sarvam-M      → Sarvam Bulbul TTS (native Kannada)
//   ta/te/mr → Sarvam-M    → Sarvam Bulbul TTS (native scripts)
async function generateWidgetReply(
  systemPrompt: string,
  history: WidgetChatTurn[],
  message: string,
  language: string,
  isVoiceRequest: boolean | undefined,
  meter: RequestMeter,
): Promise<{ reply: string; modelUsed: string }> {
  const normalizedLanguage = language || "en-US";
  const messages = buildWidgetModelMessages([systemPrompt], history, message);
  assertServerAuthoredMessages(messages);

  const NATIVE_LANG_NAMES: Record<string, { name: string; script: string }> = {
    "hi-IN": { name: "Hindi", script: "Devanagari (देवनागरी)" },
    "kn-IN": { name: "Kannada", script: "ಕನ್ನಡ ಲಿಪಿ" },
    "ta-IN": { name: "Tamil", script: "தமிழ் எழுத்து" },
    "te-IN": { name: "Telugu", script: "తెలుగు లిపి" },
    "mr-IN": { name: "Marathi", script: "Devanagari (देवनागरी)" },
  };

  // --- All Indic Languages: prefer DeepSeek V3 (best code-switching + native accuracy) ---
  // DeepSeek understands "Kanglish" (Kannada in English letters) just as well as "Hinglish".
  const langInfo = NATIVE_LANG_NAMES[normalizedLanguage];
  if (langInfo && DEEPSEEK_API_KEY) {
    const brevity = isVoiceRequest ? " Answer in 1-2 short spoken sentences ONLY. NEVER read out phone numbers, email addresses, social media handles, URLs, or app store links — just say 'you can find contact details on the website'. Be warm and natural." : " Keep your answer brief and conversational — 2-3 sentences max.";
    const styleSystem = `Reply ONLY in natural ${langInfo.name} written in NATIVE ${langInfo.script}. Output MUST be in ${langInfo.script}. NEVER romanize. NEVER use Latin/English letters except for brand names like "BBMP", "e-Khata", "ePID" or URLs. If you cannot produce native script, output nothing. Provide the answer from the knowledge base — include key details. The user's input may mix scripts or use transliteration — understand their intent and ANSWER the question. NEVER reply with a clarification question if the intent is clear.${brevity}`;
    const llmMaxTokens = isVoiceRequest ? 100 : 150;
    const result = await callDeepSeekChat(buildWidgetModelMessages([styleSystem, systemPrompt], history, message), meter, llmMaxTokens);
    if (result) {
      const normalized = normalizeIndicReply(result.content, normalizedLanguage);
      // DeepSeek V3 reliably produces native script — skip the expensive
      // ensureNativeScript check (~600ms gpt-4o-mini call) for both voice
      // and text paths. Only Sarvam-M or GPT fallbacks might need the check.
      return { reply: normalized, modelUsed: "deepseek-chat" };
    }
  }

  // --- Fallback to Sarvam-M for Indic if DeepSeek is missing or fails ---
  if (langInfo && SARVAM_API_KEY) {
    const brevity = isVoiceRequest ? " Answer in 1-2 short spoken sentences ONLY. NEVER read out phone numbers, email addresses, social media handles, URLs, or app store links — just say 'you can find contact details on the website'. Be warm and natural." : " Keep your answer brief and conversational — 2-3 sentences max.";
    const styleSystem = `Reply ONLY in natural ${langInfo.name} written in NATIVE ${langInfo.script}. Output MUST be in ${langInfo.script}. NEVER romanize. NEVER use Latin/English letters except for brand names like "BBMP", "e-Khata", "ePID" or URLs. If you cannot produce native script, output nothing. Provide the answer from the knowledge base — include key details. The user's input may be transliterated — understand the intent and ANSWER the question directly. NEVER respond with a clarification request when the user has already asked something specific.${brevity}`;
    const result = await callSarvamChat(buildWidgetModelMessages([styleSystem, systemPrompt], history, message), meter);
    if (result) {
      const normalized = normalizeIndicReply(result.content, normalizedLanguage);
      if (isVoiceRequest) return { reply: normalized, modelUsed: "sarvam-m" };
      const fixed = await ensureNativeScript(normalized, normalizedLanguage, meter);
      return { reply: fixed.reply, modelUsed: fixed.rewrote ? "sarvam-m+rewrite" : "sarvam-m" };
    }
  }

  // --- English (or any fallback): gpt-4o-mini (fast & multilingual) ---
  let reply = "";
  let modelUsed = "gpt-4o-mini";
  const maxTokens = isVoiceRequest ? 100 : 150;
  await meter.ensureBudget();
  const record = widgetLlmRecorder(meter, "openai", "gpt-4o-mini", messages, maxTokens);
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_completion_tokens: maxTokens,
      messages,
    }).catch((err: unknown) => {
      record.failure(err);
      throw err;
    });
    record.success(completion.usage, completion.choices[0]?.message?.content);
    reply = completion.choices[0]?.message?.content || "I'm sorry, I couldn't process that. Could you try again?";
  } catch (err: any) {
    logger.warn({ err, provider: "openai" }, "Widget OpenAI chat failed, falling back to DeepSeek");
    if (DEEPSEEK_API_KEY) {
      const dsResult = await callDeepSeekChat(messages, meter);
      if (dsResult) {
        reply = dsResult.content;
        modelUsed = "deepseek-chat";
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }
  
  const normalized = normalizeIndicReply(reply, normalizedLanguage);
  
  // gpt-4o-mini/DeepSeek reliably produce native script for Indic; only run the
  // ensureNativeScript safety net when the language is non-English to keep
  // the English fast-path latency-free.
  if (!isIndianLanguage(normalizedLanguage) || isVoiceRequest) {
    return { reply: normalized, modelUsed };
  }
  const fixed = await ensureNativeScript(normalized, normalizedLanguage, meter);
  return { reply: fixed.reply, modelUsed: fixed.rewrote ? `${modelUsed}+rewrite` : modelUsed };
}

// ── Agent config cache (60s TTL) ─────────────────────────────────────────
// The widget API key is stable within a session. Caching avoids a DB round-
// trip (~50ms) on every turn, which adds up on voice requests.
const AGENT_CACHE_TTL_MS = 60_000;
const agentConfigCache = new Map<string, { data: any; fetchedAt: number }>();

async function getAgentByWidgetKey(apiKey: string) {
  const cached = agentConfigCache.get(apiKey);
  if (cached && Date.now() - cached.fetchedAt < AGENT_CACHE_TTL_MS) {
    return cached.data;
  }
  const agent = await db.query.agentConfigsTable.findFirst({
    where: and(eq(agentConfigsTable.widgetApiKey, apiKey), eq(agentConfigsTable.widgetEnabled, true)),
  });
  agentConfigCache.set(apiKey, { data: agent, fetchedAt: Date.now() });
  return agent;
}

// ── Intelligent per-message KB relevance scoring ────────────────────────
// Scores each KB entry against the user's message using:
// 1. Title token overlap (3× weight)
// 2. Query variation matching (highest signal — matches the "many ways to ask")
// 3. Content token overlap (1× weight)
// 4. Native-script substring matching (Devanagari, Kannada)

// Extract query variation lines from content (lines starting with •)
function extractQueryVariations(content: string): string[] {
  const queries: string[] = [];
  const marker = "--- Query Variations";
  const idx = content.indexOf(marker);
  if (idx === -1) return queries;
  const block = content.slice(idx);
  const lines = block.split("\n");
  for (const line of lines) {
    const trimmed = line.replace(/^[•\-]\s*/, "").trim();
    if (trimmed && !trimmed.startsWith("---")) {
      queries.push(trimmed);
    }
  }
  return queries;
}

function scoreKBRelevance(entry: { title: string; content: string; type: string }, messageTokens: string[], messageJoined: string, rawMessage: string): number {
  if (!messageTokens.length) return 0;
  const messageSet = new Set(messageTokens);
  const msgLower = rawMessage.toLowerCase();

  // 1. Score against title
  const titleNorm = normalizeSearchText(entry.title);
  const titleTokens = titleNorm.split(/\s+/).filter(t => t.length > 1);
  let titleOverlap = 0;
  for (const t of titleTokens) {
    if (messageSet.has(t)) titleOverlap++;
  }
  // Phrase match on title — very strong signal
  if (titleNorm.length > 4 && messageJoined.includes(" " + titleNorm + " ")) {
    return 15;
  }

  // 2. Score against query variations — THIS IS THE KEY SIGNAL
  // Each entry has embedded "--- Query Variations ---" with all possible
  // ways someone might ask this question (EN, HI, KN, transliterated).
  const queryVars = extractQueryVariations(entry.content);
  let bestQueryScore = 0;
  for (const q of queryVars) {
    const qNorm = normalizeSearchText(q);
    const qTokens = tokenizeForSearch(q);

    // Exact phrase match in normalized form (strongest)
    if (qNorm.length > 4 && messageJoined.includes(" " + qNorm + " ")) {
      bestQueryScore = Math.max(bestQueryScore, 12);
      continue;
    }

    // Native-script substring match (handles Devanagari/Kannada)
    // e.g., user types "ई खाता के लिए जरूरी दस्तावेज" → matches embedded query
    const qTrimmed = q.trim();
    if (qTrimmed.length > 5 && (
      msgLower.includes(qTrimmed.toLowerCase()) ||
      qTrimmed.toLowerCase().includes(msgLower)
    )) {
      bestQueryScore = Math.max(bestQueryScore, 12);
      continue;
    }

    // Token coverage match (handles partial/fuzzy matching)
    if (qTokens.length > 0) {
      let overlap = 0;
      for (const t of qTokens) {
        if (messageSet.has(t)) overlap++;
      }
      const coverage = overlap / qTokens.length;
      // High coverage of query tokens = strong match
      if (overlap >= 2 && coverage >= 0.5) {
        bestQueryScore = Math.max(bestQueryScore, 5 + overlap + coverage * 2);
      } else if (overlap >= 1 && coverage >= 0.4 && qTokens.length >= 2) {
        bestQueryScore = Math.max(bestQueryScore, 3 + overlap + coverage);
      }
    }
  }

  // 3. Score against content body (scan more to reach query block)
  const contentSnippet = normalizeSearchText(entry.content.slice(0, 2000));
  const contentTokens = contentSnippet.split(/\s+/).filter(t => t.length > 1);
  const contentSet = new Set(contentTokens);
  let contentOverlap = 0;
  for (const t of messageTokens) {
    if (contentSet.has(t)) contentOverlap++;
  }

  // 4. Native-script substring match on full content
  // Handles cases where user types full native-script text
  const hasNativeScript = /[\u0900-\u097F\u0C80-\u0CFF]/.test(rawMessage);
  let nativeBonus = 0;
  if (hasNativeScript && rawMessage.trim().length > 5) {
    if (entry.content.includes(rawMessage.trim())) {
      nativeBonus = 10;
    } else {
      // Check partial containment of message words in native script
      const nativeWords = rawMessage.trim().split(/\s+/).filter(w => w.length > 2);
      let nativeHits = 0;
      for (const w of nativeWords) {
        if (entry.content.includes(w)) nativeHits++;
      }
      if (nativeWords.length > 0) {
        const nativeCoverage = nativeHits / nativeWords.length;
        if (nativeCoverage >= 0.5) nativeBonus = Math.round(nativeCoverage * 8);
      }
    }
  }

  // Weighted combination: query vars are most important
  return Math.max(bestQueryScore, titleOverlap * 3 + contentOverlap) + nativeBonus;
}

function selectRelevantKBEntries(
  allEntries: any[],
  userMessage: string | undefined,
  maxEntries: number,
): any[] {
  if (!userMessage || !userMessage.trim()) {
    return allEntries.slice(0, maxEntries);
  }
  const tokens = tokenizeForSearch(userMessage);
  if (!tokens.length) return allEntries.slice(0, maxEntries);
  const joined = " " + tokens.join(" ") + " ";

  const scored = allEntries.map(entry => ({
    entry,
    score: scoreKBRelevance(entry, tokens, joined, userMessage),
  }));
  scored.sort((a, b) => b.score - a.score);

  // Always include entries with score > 0 up to maxEntries, then fill
  // remaining slots with unseen entries to provide general context.
  const relevant = scored.filter(s => s.score > 0).slice(0, maxEntries);
  const relevantIds = new Set(relevant.map(s => s.entry.id));
  const filler = scored.filter(s => !relevantIds.has(s.entry.id)).slice(0, Math.max(0, maxEntries - relevant.length));
  return [...relevant.map(s => s.entry), ...filler.map(s => s.entry)];
}

const trainingDataCache = new Map<number, { data: any[]; scripts: any[]; fetchedAt: number }>();
const TRAINING_CACHE_TTL_MS = 60 * 1000;

async function buildSystemPromptForWidget(
  userId: number,
  agentConfig: any,
  userMessage?: string,
  isVoice?: boolean,
  crmSession?: WidgetCrmSession | null,
): Promise<string> {
  const maxEntries = isVoice ? KB_MAX_ENTRIES_VOICE : KB_MAX_ENTRIES;
  const maxChars = isVoice ? KB_ENTRY_MAX_CHARS_VOICE : KB_ENTRY_MAX_CHARS;
  let trainingDataRaw: any[] = [];
  let scripts: any[] = [];
  const cached = trainingDataCache.get(userId);

  if (cached && Date.now() - cached.fetchedAt < TRAINING_CACHE_TTL_MS) {
    trainingDataRaw = cached.data;
    scripts = cached.scripts;
  } else {
    const [fetchedData, fetchedScripts] = await Promise.all([
      db.select().from(trainingDataTable).where(eq(trainingDataTable.userId, userId)).limit(200),
      db.select().from(callingScriptsTable)
        .where(and(eq(callingScriptsTable.userId, userId), eq(callingScriptsTable.isDefault, true)))
        .limit(1),
    ]);
    trainingDataRaw = fetchedData;
    scripts = fetchedScripts;
    trainingDataCache.set(userId, { data: fetchedData, scripts: fetchedScripts, fetchedAt: Date.now() });
  }
  // Video-link entries are metadata used for the YouTube suggestion feature —
  // exclude them from the knowledge-base prompt so they don't pollute it.
  const kbCandidates = trainingDataRaw.filter((td: any) => td.type !== "video_link");
  // Use per-message relevance scoring to pick the most relevant KB entries
  const trainingData = selectRelevantKBEntries(kbCandidates, userMessage, maxEntries);

  let system = `You are ${agentConfig.agentName || "SalesBot"}, an AI assistant`;
  if (agentConfig.personality) system += ` with a ${agentConfig.personality} personality`;
  if (isVoice) {
    system += `. You are on a VOICE call. Answer in 1-2 short, natural spoken sentences ONLY. NEVER read out phone numbers, email addresses, contact numbers, social media handles, website URLs, or app store links — if the user asks for contact info, say "you can find the contact details on the website" or "I can show you the details in the chat". Be warm, conversational, and concise — the user is listening. Never mention you are an AI unless directly asked.\n\n`;
  } else {
    system += `. You are chatting with a visitor on the company website. Keep replies brief and conversational — 2-3 sentences max. Be helpful and guide the visitor toward taking an action. Never mention you are an AI unless directly asked.\n\n`;
  }

  system += `${SUPPORTED_LANGUAGES_LINE}\n\n`;
  system += `${TRANSLITERATION_LINE}\n\n`;

  if (agentConfig.language === "auto") {
    system += `CRITICAL INSTRUCTION: Mirror the user's CURRENT message language on every turn — not the previous turn's language.\n` +
      `• User writes in English → reply in English.\n` +
      `• User writes in Hindi (Devanagari or romanized "mujhe/aap/kya") → reply in Hindi (Devanagari).\n` +
      `• User writes in Kannada (Kannada script or romanized "nanu/maadi/beku") → reply in Kannada (Kannada script).\n` +
      `• If the user explicitly requests a language ("in kannada", "हिंदी में", "ಕನ್ನಡದಲ್ಲಿ") — even in a different script — switch to the REQUESTED language.\n` +
      `• Domain terms like BBMP / e-Khata / ekhata / ePID / PID / amalgamation are LANGUAGE-NEUTRAL — do not use them to guess the language.\n` +
      `• Real-time switching: if the user goes back to English (or any other language) on a turn, switch back immediately.\n\n`;
  }

  const scriptRule = buildScriptInstruction(agentConfig.language);
  if (scriptRule) {
    system += `${scriptRule}\n\n`;
  }

  if (trainingData.length > 0) {
    system += `KNOWLEDGE BASE:\n`;
    for (const td of trainingData) {
      const snippet = td.content.length > maxChars
        ? td.content.slice(0, maxChars).trimEnd() + "…"
        : td.content;
      system += `• [${td.type.replace(/_/g, " ").toUpperCase()}] ${td.title}: ${snippet}\n`;
    }
    system += "\n";
  }

  if (scripts.length > 0) {
    const script = scripts[0];
    system += `CALL SCRIPT:\nOpening: "${script.openingLine}"\n`;
    if (script.pitchPoints && Array.isArray(script.pitchPoints) && (script.pitchPoints as string[]).length > 0) {
      system += `Key points: ${(script.pitchPoints as string[]).slice(0, 3).join(" | ")}\n`;
    }
  }

  system += `\n${widgetChatSecurityPolicy(Boolean(crmSession?.crmContext))}\n\n`;

  if (crmSession?.crmContext) {
    system = appendCrmContextToWidgetPrompt(
      system,
      crmSession.crmContext,
      crmSession.activeOrderId,
      crmSession.customerName,
    );
  }

  return system;
}

// ── Direct KB answer retrieval for voice fast-path ──────────────────────
// For voice requests, try to find an exact FAQ/objection match from the
// training data and return the pre-written answer directly, completely
// skipping the LLM call. This cuts voice latency by ~2-3 seconds.

interface DirectKBAnswer {
  answer: string;
  confidence: number;
  source: string;
}

function scoreQuestionMatch(
  messageTokens: string[],
  messageLower: string,
  question: string,
): number {
  const qLower = question.toLowerCase().trim();
  const qTokens = tokenizeForSearch(question);

  // Exact or near-exact match
  if (messageLower === qLower) return 100;
  if (messageLower.length > 5 && qLower.length > 5 &&
      (messageLower.includes(qLower) || qLower.includes(messageLower))) return 90;

  // Token overlap scoring
  if (!qTokens.length || !messageTokens.length) return 0;
  const messageSet = new Set(messageTokens);
  let overlap = 0;
  for (const t of qTokens) {
    if (messageSet.has(t)) overlap++;
  }
  const coverage = overlap / qTokens.length;
  const messageCoverage = overlap / messageTokens.length;

  // Both sides need good coverage to avoid false positives
  if (coverage >= 0.8 && messageCoverage >= 0.4) return 80;
  if (coverage >= 0.6 && messageCoverage >= 0.3 && overlap >= 2) return 60;
  if (coverage >= 0.5 && overlap >= 2) return 40;
  // Single decisive token — only if it's specific enough (length >= 5)
  if (overlap >= 1 && messageCoverage >= 0.5 && qTokens.some(t => messageSet.has(t) && t.length >= 5)) return 35;
  return 0;
}

async function findDirectKBAnswer(
  userId: number,
  message: string,
): Promise<DirectKBAnswer | null> {
  let trainingData: any[] = [];
  const cached = trainingDataCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < TRAINING_CACHE_TTL_MS) {
    trainingData = cached.data;
  } else {
    trainingData = await db.select().from(trainingDataTable)
      .where(eq(trainingDataTable.userId, userId)).limit(200);
  }

  const messageLower = message.toLowerCase().trim();
  const messageTokens = tokenizeForSearch(message);
  if (!messageTokens.length && messageLower.length < 3) return null;

  let bestMatch: DirectKBAnswer | null = null;
  let bestScore = 0;

  for (const entry of trainingData) {
    // 1. Manually added FAQ/objection entries — title is question, content is answer
    if (entry.type === "faq" || entry.type === "objection_handling") {
      const score = scoreQuestionMatch(messageTokens, messageLower, entry.title || "");
      if (score > bestScore) {
        bestScore = score;
        bestMatch = { answer: entry.content, confidence: score, source: entry.type };
      }
      continue;
    }

    // 2. Uploaded JSON files — parse and extract FAQ/objection structures
    try {
      const parsed = JSON.parse(entry.content);
      const root = parsed?.knowledge_base || parsed;

      // Check FAQs array
      const faqs: any[] = root?.faqs || parsed?.faqs || [];
      for (const faq of faqs) {
        if (!faq?.question || !faq?.answer) continue;
        const score = scoreQuestionMatch(messageTokens, messageLower, faq.question);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = { answer: faq.answer, confidence: score, source: "faq" };
        }
      }

      // Check objection handling array
      const objections: any[] = root?.objection_handling || parsed?.objection_handling || [];
      for (const obj of objections) {
        if (!obj?.objection || !obj?.response) continue;
        const score = scoreQuestionMatch(messageTokens, messageLower, obj.objection);
        if (score > bestScore) {
          bestScore = score;
          bestMatch = { answer: obj.response, confidence: score, source: "objection" };
        }
      }
    } catch {
      // Not JSON — skip structured matching for this entry
    }
  }

  // Require confidence >= 35 for a direct match
  if (bestMatch && bestMatch.confidence >= 35) {
    return bestMatch;
  }
  return null;
}

router.get("/widget/config/:apiKey", widgetConfigRateLimit, async (req, res) => {
  const agent = await getAgentByWidgetKey(req.params.apiKey);
  if (!agent) {
    res.status(404).json({ error: "Widget not found or disabled" });
    return;
  }

  const crmConfig = await db.query.externalCrmConfigsTable.findFirst({
    where: eq(externalCrmConfigsTable.userId, agent.userId),
  });
  const crmConnected = !!(crmConfig?.isEnabled && crmConfig.lookupUrl);
  const policy = await resolveActiveWidgetPolicy(agent as any);

  res.json({
    agentName: agent.agentName,
    greeting: agent.greeting || `Hi! I'm ${agent.agentName}. How can I help you today?`,
    language: agent.language || "en-US",
    personality: agent.personality,
    voiceEnabled: !!(agent as any).widgetVoiceEnabled,
    crmAuthRequired: !!policy,
    crmVerification: policy ? publicFactor(policy) : null,
    crmName: crmConfig?.name ?? null,
    crmConnected,
    widgetExternalCrmEnabled: !!(agent as any).widgetExternalCrmEnabled,
  });
});

// ── Widget CRM customer verification ─────────────────────────────────────
// The embed key only identifies the widget. Customer data requires the
// factor chosen by the tenant's server-side policy, checked against the
// tenant's CRM. Every failure body below is fixed so it cannot reveal
// whether a phone number, order or date of birth exists or matched.
const CRM_MESSAGES = {
  started: "If this number is registered with us, you'll receive a 6-digit verification code shortly. Please enter it here.",
  unavailable: "Customer verification is not available right now. Please try again later.",
  invalidPhone: "Please enter a valid 10-digit phone number.",
  rateLimited: "Too many verification requests. Please try again later.",
  failed: "That code is invalid or has expired. Please try again or request a new code.",
  factorFailed: "We couldn't verify those details. Please check them and try again, or start over.",
  verified: "Thanks, you're verified. Please enter your order ID to continue.",
  resent: "If this number is registered with us, a new code is on its way.",
  required: "Please verify your details before we can continue.",
  disabled: "Customer account access is not enabled for this chat.",
  legacy: "Please verify your details using the current verification flow.",
} as const;

const verificationLimits = widgetVerificationRateLimits((res, retryAfterSeconds) => {
  res
    .set("Retry-After", String(retryAfterSeconds))
    .status(429)
    .json({ success: false, error: "rate_limited", message: CRM_MESSAGES.rateLimited });
});

type ActivePolicy = NonNullable<Awaited<ReturnType<typeof resolveActiveWidgetPolicy>>>;

/** Describes the factor the widget must collect; contains no customer data. */
function publicFactor(policy: ActivePolicy) {
  if (policy.method === "sms_otp") return { method: policy.method, factor: "code", length: 6 };
  if (policy.method === "date_of_birth") return { method: policy.method, factor: "date_of_birth", format: "DD/MM/YYYY" };
  return { method: policy.method, factor: "order_digits", length: policy.method === "order_suffix_6" ? 6 : 4 };
}

function factorPrompt(policy: ActivePolicy): string {
  const factor = publicFactor(policy);
  if (factor.factor === "code") return CRM_MESSAGES.started;
  if (factor.factor === "date_of_birth")
    return "Please enter your date of birth (DD/MM/YYYY) to verify your account.";
  return `Please enter the last ${factor.length} digits of your order ID to verify your account.`;
}

async function widgetCrmAgent(req: any, res: any) {
  const apiKey = req.body?.apiKey;
  if (typeof apiKey !== "string" || !apiKey) {
    res.status(400).json({ success: false, error: "apiKey is required" });
    return null;
  }
  const agent = await getAgentByWidgetKey(apiKey);
  if (!agent) {
    res.status(404).json({ success: false, error: "Widget not found or disabled" });
    return null;
  }
  const policy = await resolveActiveWidgetPolicy(agent as any);
  if (!policy) {
    res.status(403).json({ success: false, error: "customer_access_disabled", message: CRM_MESSAGES.disabled });
    return null;
  }
  return { agent, apiKey, policy };
}

router.post("/widget/crm/verification/start", verificationLimits.start, async (req, res) => {
  const ctx = await widgetCrmAgent(req, res);
  if (!ctx) return;
  const result = await getWidgetVerification().start({
    agent: ctx.agent,
    apiKey: ctx.apiKey,
    phone: req.body?.phone,
    source: clientAddress(req),
    policy: ctx.policy,
  });
  if (result.ok) {
    res.json({
      success: true,
      challengeId: result.challengeId,
      ...publicFactor(ctx.policy),
      message: factorPrompt(ctx.policy),
    });
  } else if (result.reason === "invalid") {
    res.status(400).json({ success: false, error: "invalid_phone", message: CRM_MESSAGES.invalidPhone });
  } else if (result.reason === "rate_limited") {
    res.status(429).json({ success: false, error: "rate_limited", message: CRM_MESSAGES.rateLimited });
  } else {
    res.status(503).json({ success: false, error: "verification_unavailable", message: CRM_MESSAGES.unavailable });
  }
});

router.post("/widget/crm/verification/resend", verificationLimits.resend, async (req, res) => {
  const ctx = await widgetCrmAgent(req, res);
  if (!ctx) return;
  const result = await getWidgetVerification().resend({
    agent: ctx.agent,
    apiKey: ctx.apiKey,
    challengeId: req.body?.challengeId,
    policy: ctx.policy,
  });
  if (result.ok) {
    res.json({ success: true, message: CRM_MESSAGES.resent });
  } else if (result.reason === "rate_limited") {
    res.status(429).json({ success: false, error: "rate_limited", message: CRM_MESSAGES.rateLimited });
  } else {
    res.status(400).json({ success: false, error: "verification_failed", message: CRM_MESSAGES.failed });
  }
});

router.post("/widget/crm/verification/verify", verificationLimits.factor, async (req, res) => {
  const ctx = await widgetCrmAgent(req, res);
  if (!ctx) return;
  const verification = getWidgetVerification();
  const result = await verification.verify({
    agent: ctx.agent,
    apiKey: ctx.apiKey,
    challengeId: req.body?.challengeId,
    policy: ctx.policy,
    code: req.body?.code,
    orderDigits: req.body?.orderDigits,
    dateOfBirth: req.body?.dateOfBirth,
  });
  const failed = ctx.policy.method === "sms_otp" ? CRM_MESSAGES.failed : CRM_MESSAGES.factorFailed;
  if (!result.ok) {
    res.status(400).json({ success: false, error: "verification_failed", message: failed });
    return;
  }
  if (!result.activeOrderId) {
    res.json({ success: true, sessionToken: result.token, orderSelected: false, message: CRM_MESSAGES.verified });
    return;
  }
  // Order-digit methods bind the session to the single matched order.
  const verified = await verification.authorize(result.token, ctx.agent, ctx.apiKey, ctx.policy);
  const session = verified ? await loadSessionOrder(verified) : null;
  if (!verified || !session) {
    if (verified) await verification.revoke(verified);
    res.status(400).json({ success: false, error: "verification_failed", message: failed });
    return;
  }
  fireWidgetChatSessionStarted(ctx.agent.userId, session);
  const greeting = greetingFor(session);
  res.json({
    success: true,
    sessionToken: result.token,
    orderSelected: true,
    orderId: session.activeOrderId,
    greeting,
    message: greeting,
  });
});

router.post("/widget/crm/select-order", widgetCustomerSessionRateLimit, async (req, res) => {
  const ctx = await widgetCrmAgent(req, res);
  if (!ctx) return;
  const verification = getWidgetVerification();
  const verified = await verification.authorize(req.body?.sessionToken, ctx.agent, ctx.apiKey, ctx.policy);
  if (!verified) {
    res.status(401).json({ success: false, error: "verification_required", message: CRM_MESSAGES.required, crmAuthRequired: true });
    return;
  }
  const orderInput = req.body?.orderId;
  const session = typeof orderInput === "string" && orderInput.length <= 64
    ? await resolveVerifiedOrder(verified, orderInput)
    : null;
  if (!session || !(await verification.setActiveOrder(verified, session.activeOrderId))) {
    res.status(404).json({ success: false, error: "order_not_found", message: ORDER_NOT_FOUND_MESSAGE });
    return;
  }
  fireWidgetChatSessionStarted(ctx.agent.userId, session);
  const greeting = greetingFor(session);
  res.json({ success: true, orderId: session.activeOrderId, greeting, message: greeting });
});

router.post("/widget/crm/session/end", widgetCustomerSessionRateLimit, async (req, res) => {
  const ctx = await widgetCrmAgent(req, res);
  if (!ctx) return;
  const verification = getWidgetVerification();
  const verified = await verification.authorize(req.body?.sessionToken, ctx.agent, ctx.apiKey, ctx.policy);
  if (verified) await verification.revoke(verified);
  res.json({ success: true });
});

// Retired endpoints: phone or phone + order ID never establish identity.
for (const retired of ["/widget/crm/verify-phone", "/widget/crm/verify-order"]) {
  router.post(retired, (_req, res) => {
    res.status(410).json({ success: false, verificationRequired: true, message: CRM_MESSAGES.legacy });
  });
}

// ── Twilio Client SDK: Voice Widget ─────────────────────────────────────
// Enables browser-based voice calling through the web widget using Twilio's
// Client JS SDK (WebRTC). The flow:
//   1. Widget calls /api/widget/voice-token → gets Access Token
//   2. Widget creates Twilio.Device, calls connect()
//   3. Twilio hits /api/twilio/widget-voice (TwiML webhook)
//   4. AI pipeline runs the same /api/twilio/voice loop as phone calls

import twilio from "twilio";

// Auto-provision a TwiML Application for the tenant's Twilio account.
// This is required for Twilio Client SDK to route incoming connections.
async function ensureTwimlApp(
  agent: any,
  baseUrl: string,
): Promise<string | null> {
  // Already provisioned
  if ((agent as any).twilioTwimlAppSid) {
    return (agent as any).twilioTwimlAppSid;
  }

  const authToken = agent.twilioAccountSid ? twilioAuthTokenFor(agent) : null;
  if (!agent.twilioAccountSid || !authToken) return null;

  try {
    const client = twilio(agent.twilioAccountSid, authToken);

    // Check if a Dialog TwiML app already exists (prevents duplicates on re-enable)
    const existingApps = await client.applications.list({ friendlyName: "Dialog Voice Widget", limit: 1 });
    let appSid: string;

    if (existingApps.length > 0) {
      appSid = existingApps[0].sid;
      // Update the voice URL in case the server URL changed
      await client.applications(appSid).update({
        voiceUrl: mediaPublicUrl("/api/twilio/widget-voice"),
        voiceMethod: "POST",
      });
    } else {
      const app = await client.applications.create({
        friendlyName: "Dialog Voice Widget",
        voiceUrl: mediaPublicUrl("/api/twilio/widget-voice"),
        voiceMethod: "POST",
      });
      appSid = app.sid;
    }

    // Persist to DB
    await db.update(agentConfigsTable)
      .set({ twilioTwimlAppSid: appSid, updatedAt: new Date() } as any)
      .where(eq(agentConfigsTable.userId, agent.userId));

    // Invalidate cache
    agentConfigCache.delete(agent.widgetApiKey);

    logger.info({ event: "widget_twiml_app_provisioned", userId: agent.userId, appSid }, "Widget TwiML app provisioned");
    return appSid;
  } catch (err) {
    logger.error({ err, userId: agent.userId }, "Widget TwiML app provisioning failed");
    return null;
  }
}

// Generate a Twilio Access Token for the browser-based voice widget
router.post("/widget/voice-token", widgetVoiceTokenRateLimit, async (req, res) => {
  const { apiKey } = req.body;

  if (!apiKey) {
    res.status(400).json({ error: "apiKey is required" });
    return;
  }

  const agent = await getAgentByWidgetKey(apiKey);
  if (!agent) {
    res.status(404).json({ error: "Widget not found or disabled" });
    return;
  }
  if (!(await enforceWidgetTenantBudget(req, res, POLICIES.widgetVoiceTokenTenant, agent.userId))) return;

  if (!(agent as any).widgetVoiceEnabled) {
    res.status(403).json({ error: "Voice calling is not enabled for this widget" });
    return;
  }

  // The token itself is free; the call it starts is held and enforced again
  // when Twilio connects it (/twilio/widget-voice).
  try {
    await assertBudgetAvailable(agent.userId);
  } catch (err) {
    if (!(err instanceof SpendLimitError)) throw err;
    res.status(spendLimitHttpStatus(err)).json({ error: err.message, code: err.code });
    return;
  }

  const authToken = agent.twilioAccountSid ? twilioAuthTokenFor(agent) : null;
  if (!agent.twilioAccountSid || !authToken) {
    res.status(400).json({ error: "Twilio credentials not configured" });
    return;
  }

  // Determine the base URL for the TwiML webhook
  const host = req.headers.host || "localhost";
  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const baseUrl = `${protocol}://${host}`;

  // Ensure TwiML App exists (auto-create if needed)
  const twimlAppSid = await ensureTwimlApp(agent, baseUrl);
  if (!twimlAppSid) {
    res.status(500).json({ error: "Could not provision TwiML Application. Check Twilio credentials." });
    return;
  }

  try {
    const identity = `widget_${randomUUID().slice(0, 8)}`;
    const { AccessToken } = twilio.jwt;
    const { VoiceGrant } = AccessToken;

    const token = new AccessToken(
      agent.twilioAccountSid,
      // For Twilio Client SDK, we need an API Key + Secret rather than the
      // master Auth Token. However Twilio allows using the Account SID as
      // the API Key SID and Auth Token as the secret for development.
      // In production, tenants should create a proper API Key in Twilio Console.
      agent.twilioAccountSid,
      authToken,
      { identity, ttl: 3600 },
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: twimlAppSid,
      incomingAllow: false, // Widget only makes outbound calls to the AI
    });
    token.addGrant(voiceGrant);

    logger.info({ event: "widget_voice_token_issued", userId: agent.userId }, "Widget voice token issued");

    res.json({
      token: token.toJwt(),
      identity,
    });
  } catch (err: any) {
    logger.error({ err }, "Widget voice token generation failed");
    res.status(500).json({ error: `Token generation failed: ${err.message}` });
  }
});

// ── Video-link suggestion ────────────────────────────────────────────────
// Tenants can store curated video tutorials by adding training entries with
// type='video_link'. The `content` column holds JSON like:
//   { "title": "...", "link_en": "...", "link_kn": "...",
//     "search_terms": ["how to apply", "ekhata kaise apply", ...] }
// On every chat turn we score the user's message against these search terms
// and append the best match (if confidence is high enough) to the reply.

interface VideoLinkEntry {
  title: string;
  link_en?: string;
  link_kn?: string;
  search_terms?: string[];
}
interface VideoCandidate {
  video: VideoLinkEntry;
  score: number;
}

interface CachedVideos {
  fetchedAt: number;
  videos: VideoLinkEntry[];
}

const VIDEO_CACHE_TTL_MS = 5 * 60 * 1000;
const videoCache = new Map<number, CachedVideos>();
const VIDEO_SUGGESTION_MARKER = "📺";
const SEARCH_STOPWORDS = new Set([
  // English
  "a", "an", "and", "are", "as", "at", "be", "between", "by", "for", "from", "how",
  "i", "if", "in", "is", "it", "me", "my", "new", "of", "on", "or", "the", "to",
  "what", "where", "why", "with", "you", "your", "do", "does", "can", "will",
  "need", "want", "please", "tell", "about", "which", "this", "that",
  // Romanized Hindi stopwords
  "kya", "hai", "ke", "ka", "ki", "ko", "se", "me", "mein", "ye", "wo", "aur",
  "liye", "kaise", "kahan", "kaun", "kab", "kitna", "kitne", "nahi",
  // Romanized Kannada stopwords
  "alli", "dalli", "madhu", "matthu", "iddu", "ide", "enu", "yenu", "hogona",
  "ge", "hegidhe", "yavudu", "yavu", "beku", "bekada", "yavavu",
  // Common terms that appear in most entries (too broad to score on)
  "khata", "e", "ekhata", "bbmp",
]);

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\be[\s-]*khata\b/g, "ekhata")
    .replace(/\bnew[\s-]*khata\b/g, "newkhata")
    .replace(/\bkahat\b/g, "khata")
    .replace(/\bekata\b/g, "ekhata")
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripVideoSuggestionText(text: string): string {
  if (!text) return text;
  const main = text.split(VIDEO_SUGGESTION_MARKER)[0];
  return main.replace(/https?:\/\/\S+/g, "").trim();
}

// Server-side TTS chunking — splits text into sentence-level chunks for
// parallel synthesis. Uses relaxed thresholds compared to the old client-side
// splitForTTS (which over-merged sentences into 150+ char blobs, defeating
// the parallelism benefit). Each chunk stays small enough for fast Sarvam
// synthesis (~120 chars max) while still merging truly tiny fragments.
function splitIntoTTSChunks(text: string): string[] {
  const stripped = stripVideoSuggestionText(text).replace(/https?:\/\/\S+/g, "").trim();
  if (!stripped) return [];
  // Split on sentence boundaries including Indic punctuation (purna viram, etc.)
  const parts = stripped.split(/(?<=[.?!।॥])\s+/);
  const chunks: string[] = [];
  let buf = "";
  for (const p of parts) {
    const trimmed = p.trim();
    if (!trimmed) continue;
    if (buf && (trimmed.length < 20 || (buf + " " + trimmed).length < 200)) {
      buf = (buf + " " + trimmed).trim();
    } else if (buf) {
      chunks.push(buf);
      buf = trimmed;
    } else {
      buf = trimmed;
    }
  }
  if (buf) chunks.push(buf);
  if (chunks.length === 0) return [stripped];

  // Hard cap at 3 chunks — merge overflow into the last chunk to limit
  // parallel Sarvam TTS calls and total latency.
  const MAX_TTS_CHUNKS = 3;
  if (chunks.length > MAX_TTS_CHUNKS) {
    const merged = chunks.slice(0, MAX_TTS_CHUNKS - 1);
    merged.push(chunks.slice(MAX_TTS_CHUNKS - 1).join(" "));
    return merged;
  }
  return chunks;
}

async function loadVideoLinks(userId: number): Promise<VideoLinkEntry[]> {
  const cached = videoCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < VIDEO_CACHE_TTL_MS) {
    return cached.videos;
  }

  // Fetch ALL training data (not just video_link) so we can extract embedded
  // video objects from FAQ/product_info/objection_handling entries too.
  const rows = await db
    .select()
    .from(trainingDataTable)
    .where(eq(trainingDataTable.userId, userId))
    .limit(200);

  const videos: VideoLinkEntry[] = [];
  const seenLinks = new Set<string>(); // deduplicate by link

  for (const r of rows) {
    try {
      const parsed = JSON.parse(r.content);

      // 1. Dedicated video_link entries (original format)
      if (r.type === "video_link" && parsed && typeof parsed.title === "string") {
        const key = parsed.link_en || parsed.link_kn || parsed.title;
        if (!seenLinks.has(key)) {
          seenLinks.add(key);
          videos.push(parsed);
        }
        continue;
      }

      // 2. Embedded videos inside FAQ/product_info/objection_handling entries
      //    Format: { title, answer, sampleQuestions: [...], video: { english, kannada } }
      //    Also handles nested structures like { knowledge_base: { faqs: [...] } }
      if (parsed?.video && (parsed.video.english || parsed.video.kannada)) {
        const linkEn = parsed.video.english || "";
        const linkKn = parsed.video.kannada || "";
        const key = linkEn || linkKn;
        if (key && !seenLinks.has(key)) {
          seenLinks.add(key);
          // Use title + sampleQuestions as search terms for matching
          const searchTerms: string[] = [];
          if (parsed.title) searchTerms.push(parsed.title);
          if (Array.isArray(parsed.sampleQuestions)) {
            searchTerms.push(...parsed.sampleQuestions);
          }
          videos.push({
            title: parsed.title || r.title || "Video",
            link_en: linkEn,
            link_kn: linkKn,
            search_terms: searchTerms,
          });
        }
        continue;
      }

      // 3. Nested knowledge_base structures with faqs/items arrays
      const root = parsed?.knowledge_base || parsed;
      const items: any[] = root?.items || root?.faqs || [];
      for (const item of items) {
        if (!item?.video) continue;
        const linkEn = item.video.english || item.video.link_en || "";
        const linkKn = item.video.kannada || item.video.link_kn || "";
        const key = linkEn || linkKn;
        if (!key || seenLinks.has(key)) continue;
        seenLinks.add(key);
        const searchTerms: string[] = [];
        if (item.title) searchTerms.push(item.title);
        if (Array.isArray(item.sampleQuestions)) {
          searchTerms.push(...item.sampleQuestions);
        }
        videos.push({
          title: item.title || "Video",
          link_en: linkEn,
          link_kn: linkKn,
          search_terms: searchTerms,
        });
      }
    } catch {
      // ignore malformed entries
    }
  }
  videoCache.set(userId, { fetchedAt: Date.now(), videos });
  return videos;
}

function tokenizeForSearch(text: string): string[] {
  const normalized = normalizeSearchText(text);
  return normalized
    .split(/\s+/)
    .filter(t => t.length > 1 && !SEARCH_STOPWORDS.has(t));
}

function scoreVideoMatch(messageTokens: string[], video: VideoLinkEntry): number {
  if (!messageTokens.length) return 0;
  const messageSet = new Set(messageTokens);
  const messageJoined = " " + messageTokens.join(" ") + " ";
  const candidates: string[] = [video.title, ...(video.search_terms ?? [])];
  let best = 0;
  for (const c of candidates) {
    if (!c) continue;
    const lc = normalizeSearchText(c);
    if (!lc) continue;
    // Phrase match: very strong signal.
    if (lc.length > 4 && messageJoined.includes(" " + lc + " ")) {
      best = Math.max(best, 5 + Math.min(3, Math.floor(lc.length / 8)));
      continue;
    }
    const candTokens = tokenizeForSearch(c);
    if (!candTokens.length) continue;
    let overlap = 0;
    for (const t of candTokens) {
      if (messageSet.has(t)) overlap += 1;
    }
    // Coverage of the candidate's tokens — most of them must be in the
    // message, otherwise short candidates over-score on common words.
    const coverage = overlap / candTokens.length;
    if (overlap >= 2 && coverage >= 0.5) {
      best = Math.max(best, overlap + coverage);
    } else if (overlap >= 1 && coverage >= 0.66 && candTokens.length >= 2) {
      best = Math.max(best, overlap + coverage * 0.5);
    }
  }
  return best;
}

async function findRelevantVideo(
  userId: number,
  message: string,
): Promise<VideoLinkEntry | null> {
  const videos = await loadVideoLinks(userId);
  return matchVideoFromList(videos, message);
}

// Pure lexical video matching — no LLM calls needed. Videos are already
// curated in training data with search_terms, so token overlap scoring is
// fast (~0ms) and accurate enough.
function matchVideoFromList(
  videos: VideoLinkEntry[],
  message: string,
): VideoLinkEntry | null {
  if (!videos.length) return null;
  const tokens = tokenizeForSearch(message);
  if (!tokens.length) return null;
  const ranked: VideoCandidate[] = [];
  for (const v of videos) {
    const s = scoreVideoMatch(tokens, v);
    if (s > 0) ranked.push({ video: v, score: s });
  }
  ranked.sort((a, b) => b.score - a.score);
  if (!ranked.length) return null;
  const best = ranked[0];
  if (best.score < 2.5) return null;
  return best.video;
}

function pickVideoLink(video: VideoLinkEntry, language: string): string | null {
  if (language === "kn-IN" && video.link_kn) return video.link_kn;
  if (video.link_en) return video.link_en;
  return video.link_kn ?? null;
}

function videoSuggestionLine(language: string, link: string): string {
  switch (language) {
    case "kn-IN":
      return `\n\n📺 ವಿಡಿಯೋ ನೋಡಿ: ${link}`;
    case "hi-IN":
      return `\n\n📺 वीडियो देखें: ${link}`;
    case "ta-IN":
      return `\n\n📺 வீடியோ பாருங்கள்: ${link}`;
    case "te-IN":
      return `\n\n📺 వీడియో చూడండి: ${link}`;
    case "mr-IN":
      return `\n\n📺 व्हिडिओ पहा: ${link}`;
    default:
      return `\n\n📺 Watch on YouTube: ${link}`;
  }
}

router.post("/widget/chat", widgetChatRateLimit, async (req, res) => {
  const requestStart = Date.now();
  const parsed = parseWidgetChatRequest(req.body, ALL_LANG_CODES);
  if (!parsed.ok) {
    logger.warn({ event: "widget_chat_rejected", reason: parsed.reason }, "Widget chat request rejected");
    res.status(400).json({ error: WIDGET_CHAT_REJECTED_MESSAGE, reason: parsed.reason });
    return;
  }
  const { apiKey, message, history, includeAudio, isVoiceRequest, sessionLanguage, crmSessionToken } = parsed.value;

  const agent = await getAgentByWidgetKey(apiKey);
  if (!agent) {
    res.status(404).json({ error: "Widget not found or disabled" });
    return;
  }
  if (!(await enforceWidgetTenantBudget(req, res, POLICIES.widgetChatTenant, agent.userId))) return;

  const meter = createRequestMeter({
    userId: agent.userId,
    source: "widget-chat",
    estimate: widgetChatEstimate(message, history, Boolean(isVoiceRequest || includeAudio)),
  });
  res.once("close", () => { void meter.finish(); });

  // No active policy means general chat only: no CRM lookup, no customer data.
  const crmPolicy = await resolveActiveWidgetPolicy(agent as any);
  let crmSession: WidgetCrmSession | null = null;
  let verifiedCustomer: WidgetCustomerSession | null = null;

  if (crmPolicy) {
    const verification = getWidgetVerification();
    verifiedCustomer = await verification.authorize(crmSessionToken, agent, apiKey, crmPolicy);
    if (!verifiedCustomer) {
      res.status(403).json({
        error: "CRM verification required",
        reply: CRM_MESSAGES.required,
        crmAuthRequired: true,
      });
      return;
    }
    // Ownership is re-checked against the CRM on every turn.
    crmSession = await loadSessionOrder(verifiedCustomer);
    if (!crmSession) {
      res.status(403).json({
        error: "Order selection required",
        reply: "Please enter your order ID to continue.",
        crmAuthRequired: true,
        crmOrderRequired: true,
      });
      return;
    }
  }

  // A verified customer's model context comes from the transcript the server
  // recorded for that session, so browser-supplied turns cannot assert
  // verification, order ownership or completed actions alongside real data.
  const turns: WidgetChatTurn[] = crmSession
    ? await loadWidgetChatHistory(crmSession.userId, crmSession.sessionId, WIDGET_CHAT_LIMITS.modelHistoryEntries)
    : history;
  const normalizedHistory: WidgetChatTurn[] = turns.map((h) => ({
    role: h.role,
    content: h.role === "assistant" ? stripVideoSuggestionText(h.content) : h.content,
  }));

  // ── Optimization: preload video links AND warm training data cache ────
  // Both are I/O-bound DB fetches independent of language resolution.
  // Start them in parallel so data is ready by the time we need it.
  const videoPreload = loadVideoLinks(agent.userId).catch(() => [] as VideoLinkEntry[]);

  // Warm the training data cache in parallel with language resolution.
  // buildSystemPromptForWidget will find the data already cached.
  const trainingWarmup = (async () => {
    const cached = trainingDataCache.get(agent.userId);
    if (cached && Date.now() - cached.fetchedAt < TRAINING_CACHE_TTL_MS) return;
    const [fetchedData, fetchedScripts] = await Promise.all([
      db.select().from(trainingDataTable).where(eq(trainingDataTable.userId, agent.userId)).limit(200),
      db.select().from(callingScriptsTable)
        .where(and(eq(callingScriptsTable.userId, agent.userId), eq(callingScriptsTable.isDefault, true)))
        .limit(1),
    ]);
    trainingDataCache.set(agent.userId, { data: fetchedData, scripts: fetchedScripts, fetchedAt: Date.now() });
  })().catch(() => {});

  const [resolved] = await Promise.all([
    resolveEffectiveWidgetLanguage(
      agent.language,
      message,
      normalizedHistory,
      sessionLanguage,
      meter,
    ),
    trainingWarmup,
  ]);
  const effectiveLanguage = resolved.lang;
  let reply = "";
  let modelUsed = "gpt-4o-mini";
  let systemPrompt = "";

  // Handle phone switch / order switch within verified CRM session
  if (crmSession && verifiedCustomer) {
    const orderSwitch = resolveWidgetCrmSessionForChat(verifiedCustomer, crmSession, message);
    if (orderSwitch.switchedOrder) {
      if (await getWidgetVerification().setActiveOrder(verifiedCustomer, orderSwitch.session.activeOrderId)) {
        crmSession = orderSwitch.session;
        reply = orderSwitch.switchMessage ?? `I've switched to order #${crmSession.activeOrderId}. How can I help?`;
        modelUsed = "crm-switch";
        fireWidgetChatTurn(agent.userId, crmSession, message, reply, "widget.chat.order_switched");
      } else {
        reply = "Your session has ended. Please verify your phone number again.";
        modelUsed = "crm-guard";
      }
    } else if (orderSwitch.switchMessage) {
      reply = orderSwitch.switchMessage;
      modelUsed = "crm-guard";
    }
  }

  // ── Voice fast-path: direct KB match skips LLM entirely ────────────────
  // For voice, try to match the user's question against FAQ/objection entries
  // in the training data. If found, return the pre-written answer directly
  // without calling the LLM — this cuts voice latency by ~2-3 seconds.
  // Skip when CRM session is active — order-specific CRM context takes priority.
  if (isVoiceRequest && !crmSession) {
    const directAnswer = await findDirectKBAnswer(agent.userId, message);
    if (directAnswer) {
      reply = directAnswer.answer;
      modelUsed = "direct-kb";
      logger.info({ confidence: directAnswer.confidence, kbSource: directAnswer.source }, "Widget voice fast path: direct KB match");
    }
  }

  if (!reply) {
    systemPrompt = await buildSystemPromptForWidget(agent.userId, {
      ...agent,
      language: effectiveLanguage,
    }, message, isVoiceRequest, crmSession);
    try {
      const generation = await generateWidgetReply(
        systemPrompt,
        normalizedHistory,
        message,
        effectiveLanguage,
        isVoiceRequest,
        meter,
      );
      reply = generation.reply;
      modelUsed = generation.modelUsed;
    } catch (err) {
      if (err instanceof SpendLimitError) {
        logger.warn({ event: "widget_chat_spend_limit", code: err.code }, "Widget chat refused by spending limit");
        res.status(spendLimitHttpStatus(err)).json({ error: err.message, code: err.code, reply: WIDGET_LIMIT_MESSAGE });
        return;
      }
      logger.error({ err }, "Widget AI reply generation failed");
      reply = "Sorry, I'm having a moment. Please try again shortly.";
    }
  }

  // ── Fire-and-forget: DB call log (never block response) ─
  // Costs live in the usage ledger; a widget chat row has no telephony cost of its own.
  db.insert(callLogsTable).values({
    userId: agent.userId,
    direction: "widget",
    phone: crmSession?.phone ?? "web-widget",
    outcome: "answered",
    aiModel: modelUsed,
    startedAt: new Date(),
    endedAt: new Date(),
    duration: 0,
  }).catch(() => {});

  // Sync verified CRM widget chat to external CRM (fire-and-forget)
  if (crmSession?.sessionId && reply && message) {
    const skipSync = modelUsed === "crm-guard";
    if (!skipSync) {
      fireWidgetChatTurn(agent.userId, crmSession, message, reply);
    }
  }

  const language = effectiveLanguage;
  let audio: string | null = null;
  let provider: "sarvam" | "openai" | null = null;
  let audioMimeType = "audio/mpeg";
  let audioChunks: Array<{ audio: string | null; mimeType: string }> | null = null;

  // ── Voice path: server-side parallel TTS so text + audio arrive together ──
  if (isVoiceRequest) {
    const ttsReplyRaw = stripVideoSuggestionText(reply) || reply;
    const ttsReplyText = stripForVoiceTTS(ttsReplyRaw);
    const ttsChunks = splitIntoTTSChunks(ttsReplyText);

    // Fire TTS chunks and video search in parallel
    const ttsPromise = ttsChunks.length > 0
      ? (async () => {
          const ttsStart = Date.now();
          const chunkResults = await Promise.allSettled(
            ttsChunks.map(chunk =>
              synthesizeWidgetTTS(chunk, agent.voice || "nova", language, meter)
            )
          );
          const chunks = chunkResults.map(r =>
            r.status === "fulfilled"
              ? { audio: r.value.audio, mimeType: r.value.mimeType }
              : { audio: null, mimeType: "audio/wav" }
          );
          let prov: "sarvam" | "openai" | null = null;
          for (const r of chunkResults) {
            if (r.status === "fulfilled" && r.value.provider) {
              prov = r.value.provider;
              break;
            }
          }
          logger.info({ chunks: ttsChunks.length, ttsMs: Date.now() - ttsStart }, "Widget parallel TTS complete");
          return { chunks, provider: prov, mimeType: chunks[0]?.mimeType || "audio/wav" };
        })()
      : Promise.resolve(null);

    const videoMatch = matchVideoFromList(await videoPreload, message);
    const [ttsResult] = await Promise.all([ttsPromise]);

    if (ttsResult) {
      audioChunks = ttsResult.chunks;
      provider = ttsResult.provider;
      audioMimeType = ttsResult.mimeType;
    }

    let suggestedVideo: { title: string; link: string } | null = null;
    if (videoMatch) {
      const link = pickVideoLink(videoMatch, language);
      if (link) {
        reply = `${reply.trim()}${videoSuggestionLine(language, link)}`;
        suggestedVideo = { title: videoMatch.title, link };
      }
    }

    logger.info({
      configuredLanguage: agent.language,
      language,
      languageSource: resolved.source,
      sessionLanguage: sessionLanguage ?? null,
      model: modelUsed,
      tts: provider ?? "none",
      voice: true,
      chunks: audioChunks?.length ?? 0,
      hasVideo: Boolean(suggestedVideo),
      totalMs: Date.now() - requestStart,
    }, "Widget chat turn complete");

    res.json({
      reply,
      agentName: agent.agentName,
      language,
      detectedLanguage: language,
      configuredLanguage: agent.language,
      modelUsed,
      audio,
      audioChunks,
      provider,
      video: suggestedVideo,
      audioMimeType,
      activeOrderId: crmSession?.activeOrderId ?? null,
    });
    return;
  }

  // ── Non-voice path (text-only or legacy includeAudio) ─────────────────
  // Reuse the videoPreload started earlier instead of a fresh DB query.
  let suggestedVideo: { title: string; link: string } | null = null;
  try {
    const videos = await videoPreload;
    const matched = matchVideoFromList(videos, message);
    if (matched) {
      const link = pickVideoLink(matched, effectiveLanguage);
      if (link) {
        reply = `${reply.trim()}${videoSuggestionLine(effectiveLanguage, link)}`;
        suggestedVideo = { title: matched.title, link };
      }
    }
  } catch (e) {
    logger.error({ err: e }, "Widget video match failed");
  }

  if (includeAudio) {
    const ttsText = stripVideoSuggestionText(reply) || reply;
    // Over the budget the (possibly free) text reply is still returned, without audio.
    const ttsResult = await synthesizeWidgetTTS(ttsText, agent.voice || "nova", language, meter)
      .catch((err: unknown) => {
        if (err instanceof SpendLimitError) return null;
        throw err;
      });
    if (ttsResult) {
      audio = ttsResult.audio;
      provider = ttsResult.provider;
      audioMimeType = ttsResult.mimeType;
    }
  }

  logger.info({
    configuredLanguage: agent.language,
    language,
    languageSource: resolved.source,
    sessionLanguage: sessionLanguage ?? null,
    model: modelUsed,
    tts: provider ?? "none",
    voice: false,
    chunks: 0,
    hasVideo: Boolean(suggestedVideo),
    totalMs: Date.now() - requestStart,
  }, "Widget chat turn complete");

  res.json({
    reply,
    agentName: agent.agentName,
    language,
    detectedLanguage: language,
    configuredLanguage: agent.language,
    modelUsed,
    audio,
    audioChunks,
    provider,
    video: suggestedVideo,
    audioMimeType,
    activeOrderId: crmSession?.activeOrderId ?? null,
  });
});

// Server-side TTS for the Web Widget using OpenAI TTS (Fast, multilingual, high-quality)
router.post("/widget/tts", widgetTtsRateLimit, async (req, res) => {
  const { text, apiKey, language: requestedLanguage } = req.body as { text?: string; language?: string; apiKey?: string };
  if (typeof text !== "string" || !text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  
  // Paid synthesis is always attributed to a tenant; anonymous requests are refused.
  if (typeof apiKey !== "string" || !apiKey) {
    res.status(400).json({ error: "apiKey is required" });
    return;
  }
  const agent = await getAgentByWidgetKey(apiKey);
  if (!agent) {
    res.status(404).json({ error: "Widget not found or disabled" });
    return;
  }
  if (!(await enforceWidgetTenantBudget(req, res, POLICIES.widgetTtsTenant, agent.userId))) return;

  const voice = agent.voice || "nova";
  const language = (!requestedLanguage || requestedLanguage === "auto") && agent.language
    ? agent.language
    : requestedLanguage || "en-US";

  const meter = createRequestMeter({
    userId: agent.userId,
    source: "widget-tts",
    estimate: { ttsProviders: ["sarvam", "openai"], ttsCharacters: text.length },
  });
  res.once("close", () => { void meter.finish(); });

  let ttsResult;
  try {
    ttsResult = await synthesizeWidgetTTS(text, voice, language, meter);
  } catch (err) {
    if (!(err instanceof SpendLimitError)) throw err;
    res.status(spendLimitHttpStatus(err)).json({ error: err.message, code: err.code });
    return;
  }
  if (!ttsResult.audio) {
    res.status(502).json({ error: "TTS failed" });
    return;
  }
  logger.info({ language, provider: ttsResult.provider ?? "none", mimeType: ttsResult.mimeType }, "Widget standalone TTS complete");
  res.json({ audio: ttsResult.audio, provider: ttsResult.provider, language, audioMimeType: ttsResult.mimeType });
});

router.get("/widget/loader.js", widgetConfigRateLimit, async (req, res) => {
  const { key } = req.query as { key?: string };
  if (!key) {
    res.status(400).type("application/javascript").send("console.error('Dialog widget: missing key parameter');");
    return;
  }

  const js = `
(function() {
  var API_KEY = ${JSON.stringify(key)};
  // Determine BASE_URL from the script's own src so it works regardless of
  // how the reverse proxy forwards the Host header.
  var BASE_URL = (function() {
    var s = document.currentScript;
    if (s && s.src) { try { var u = new URL(s.src); return u.protocol + '//' + u.host; } catch(e) {} }
    // fallback: find script tag by src pattern
    var tags = document.querySelectorAll('script[src*="loader.js"]');
    for (var i = tags.length - 1; i >= 0; i--) {
      try { var u2 = new URL(tags[i].src); return u2.protocol + '//' + u2.host; } catch(e) {}
    }
    return window.location.origin;
  })();
  var history = [];
  var agentName = "Assistant";
  var agentLang = "en-US";
  var configuredLang = "en-US";
  var sessionLang = "en-US";
  var open = false;
  var listening = false;
  var speaking = false;
  var recognition = null;
  var micBlocked = false;
  var crmAuthRequired = false;
  var crmStep = "none";
  var crmChallengeId = "";
  var crmFactor = "";
  var crmSessionToken = "";
  var chatUnlocked = true;
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var hasSpeechAPI = !!SpeechRecognition;
  var INDIC_RANGES = [
    {re: /[\u0C80-\u0CFF]/, lang: "kn-IN"},
    {re: /[\u0B80-\u0BFF]/, lang: "ta-IN"},
    {re: /[\u0C00-\u0C7F]/, lang: "te-IN"},
    {re: /[\u0900-\u097F]/, lang: "hi-IN"}
  ];
  function detectExplicitSwitch(t) {
    if (!t) return null;
    var hasIntent = /\\b(in|reply|speak|talk|switch|change|use|explain|tell|translate|please|me|mein|dalli|language|lang)\\b|में|मे|बताओ|समझाओ|बोलो|जवाब|भाषा|लैंग्वेज|ದಲ್ಲಿ|ಹೇಳಿ|ಭಾಷೆ|மொழி|భాష|मध्ये|भाषा/i.test(t);
    if (!hasIntent) return null;
    if (/\\b(kannada|kanada|kannad)\\b/i.test(t) || /ಕನ್ನಡ/.test(t) || /कन्नड|कन्नडा|कन्नड़|कनाडा/.test(t)) return "kn-IN";
    if (/\\b(hindi|hinglish|hindee)\\b/i.test(t) || /हिन्दी|हिंदी/.test(t) || /ಹಿಂದಿ/.test(t)) return "hi-IN";
    if (/\\b(tamil|tamizh)\\b/i.test(t) || /தமிழ்/.test(t)) return "ta-IN";
    if (/\\b(telugu)\\b/i.test(t) || /తెలుగు/.test(t)) return "te-IN";
    if (/\\b(marathi)\\b/i.test(t) || /मराठी/.test(t)) return "mr-IN";
    if (/\\b(english|englis|inglish|angrezi|angreji)\\b/i.test(t) || /अंग्रेजी|इंग्लिश/.test(t) || /ಇಂಗ್ಲಿಷ್/.test(t)) return "en-US";
    return null;
  }
  function detectLangFromText(t) {
    if (!t) return null;
    var sw = detectExplicitSwitch(t);
    if (sw) return sw;
    for (var i=0;i<INDIC_RANGES.length;i++){ if (INDIC_RANGES[i].re.test(t)) return INDIC_RANGES[i].lang; }
    var l = (t||"").toLowerCase();
    if (/\\b(namaskara|hege|maadi|maadu|nanage|nanu|beku|swalpa|thumba)\\b/.test(l)) return "kn-IN";
    if (/\\b(kya|kaise|nahi|chahiye|mujhe|aap|hai|hain|bataao|samjhao)\\b/.test(l)) return "hi-IN";
    return null;
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs||{}).forEach(function(k){ e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }

  var style = el("style", {}, "");
  style.textContent = [
    "#_dw-fab{position:fixed;bottom:24px;right:24px;z-index:99999;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#7c3aed,#4f46e5);border:none;cursor:pointer;box-shadow:0 4px 20px rgba(124,58,237,.5);display:flex;align-items:center;justify-content:center;}",
    "#_dw-fab svg{width:28px;height:28px;fill:white;}",
    "#_dw-box{position:fixed;bottom:92px;right:24px;z-index:99998;width:340px;max-height:560px;border-radius:16px;background:#0f0d1a;border:1px solid rgba(255,255,255,.1);box-shadow:0 8px 40px rgba(0,0,0,.6);display:none;flex-direction:column;font-family:system-ui,sans-serif;}",
    "#_dw-box.open{display:flex;}",
    "#_dw-head{padding:14px 16px;background:linear-gradient(135deg,#7c3aed,#4f46e5);border-radius:16px 16px 0 0;display:flex;align-items:center;gap:10px;}",
    "#_dw-head span{color:#fff;font-weight:600;font-size:14px;flex:1;}",
    "#_dw-head .dot{width:8px;height:8px;border-radius:50%;background:#4ade80;flex-shrink:0;}",
    "#_dw-mode{font-size:10px;color:rgba(255,255,255,.7);background:rgba(0,0,0,.2);border-radius:20px;padding:2px 8px;flex-shrink:0;}",
    "#_dw-msgs{flex:1;overflow-y:auto;padding:12px;display:flex;flex-direction:column;gap:8px;min-height:200px;max-height:340px;}",
    ".dw-msg{max-width:80%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.4;}",
    ".dw-msg.bot{background:rgba(124,58,237,.15);color:#e2d9f3;border-bottom-left-radius:4px;align-self:flex-start;}",
    ".dw-msg.user{background:#7c3aed;color:#fff;border-bottom-right-radius:4px;align-self:flex-end;}",
    ".dw-msg.user.voice{background:linear-gradient(135deg,#7c3aed,#4f46e5);display:flex;align-items:center;gap:8px;padding:10px 14px;border-radius:16px;}",
    ".dw-voice-orb{display:flex;align-items:center;gap:3px;height:28px;}",
    ".dw-voice-orb .bar{width:3px;border-radius:3px;background:rgba(255,255,255,.85);animation:_dw-vbar 1.2s ease-in-out infinite;}",
    ".dw-voice-orb .bar:nth-child(1){height:8px;animation-delay:0s;}",
    ".dw-voice-orb .bar:nth-child(2){height:16px;animation-delay:.1s;}",
    ".dw-voice-orb .bar:nth-child(3){height:24px;animation-delay:.2s;}",
    ".dw-voice-orb .bar:nth-child(4){height:18px;animation-delay:.3s;}",
    ".dw-voice-orb .bar:nth-child(5){height:10px;animation-delay:.4s;}",
    ".dw-voice-orb .bar:nth-child(6){height:20px;animation-delay:.15s;}",
    ".dw-voice-orb .bar:nth-child(7){height:12px;animation-delay:.35s;}",
    ".dw-voice-label{font-size:12px;color:rgba(255,255,255,.8);font-style:italic;}",
    "@keyframes _dw-vbar{0%,100%{transform:scaleY(.3);opacity:.5;}50%{transform:scaleY(1);opacity:1;}}",
    "#_dw-form{display:flex;gap:6px;padding:10px 12px;border-top:1px solid rgba(255,255,255,.08);align-items:center;}",
    "#_dw-input{flex:1;background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:8px 10px;color:#fff;font-size:13px;outline:none;}",
    "#_dw-send{background:#7c3aed;border:none;border-radius:8px;width:34px;height:34px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}",
    "#_dw-send svg{width:16px;height:16px;fill:white;}",
    "#_dw-mic{border:none;border-radius:8px;width:34px;height:34px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:all .2s;background:rgba(255,255,255,.08);}",
    "#_dw-mic svg{width:18px;height:18px;fill:rgba(255,255,255,.6);}",
    "#_dw-mic.listening{background:#ef4444;animation:_dw-pulse 1s infinite;}",
    "#_dw-mic.listening svg{fill:white;}",
    "#_dw-mic:disabled{opacity:.4;cursor:not-allowed;}",
    "@keyframes _dw-pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.6);}50%{box-shadow:0 0 0 8px rgba(239,68,68,0);}}",
    "@keyframes _dw-search{0%,100%{transform:rotate(-15deg) scale(0.9);opacity:0.7;}50%{transform:rotate(15deg) scale(1.1);opacity:1;}}",
    "@keyframes _dw-shimmer{0%{background-position:200% 0;}100%{background-position:-200% 0;}}",
    "#_dw-listen-bar{display:none;align-items:center;gap:8px;padding:6px 12px;background:rgba(239,68,68,.12);border-top:1px solid rgba(239,68,68,.2);}",
    "#_dw-listen-bar.active{display:flex;}",
    "#_dw-listen-bar span{font-size:12px;color:#fca5a5;flex:1;}",
    "#_dw-listen-bar button{border:none;background:none;color:#fca5a5;cursor:pointer;font-size:11px;padding:2px 6px;border-radius:4px;}",
    "#_dw-listen-bar button:hover{background:rgba(239,68,68,.2);}",
    "#_dw-brand{font-size:10px;color:rgba(255,255,255,.3);text-align:center;padding:4px 0 8px;letter-spacing:.5px;}",
    "#_dw-call-btn{border:none;background:rgba(255,255,255,.15);border-radius:8px;width:30px;height:30px;cursor:pointer;display:none;align-items:center;justify-content:center;flex-shrink:0;transition:all .2s;}",
    "#_dw-call-btn:hover{background:rgba(74,222,128,.3);}",
    "#_dw-call-btn svg{width:16px;height:16px;fill:white;}",
    "#_dw-call-btn.active{background:rgba(239,68,68,.4);}",
    "#_dw-call-btn.active:hover{background:rgba(239,68,68,.6);}",
    "#_dw-voice-overlay{display:none;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px 16px;flex:1;min-height:280px;}",
    "#_dw-voice-overlay.active{display:flex;}",
    ".dw-call-orb{width:100px;height:100px;border-radius:50%;background:linear-gradient(135deg,#7c3aed,#4f46e5);display:flex;align-items:center;justify-content:center;animation:_dw-call-pulse 2s ease-in-out infinite;position:relative;}",
    ".dw-call-orb::after{content:'';position:absolute;inset:-6px;border-radius:50%;border:2px solid rgba(124,58,237,.3);animation:_dw-call-ring 2s ease-in-out infinite;}",
    "@keyframes _dw-call-pulse{0%,100%{box-shadow:0 0 20px rgba(124,58,237,.4);}50%{box-shadow:0 0 40px rgba(124,58,237,.7);}}",
    "@keyframes _dw-call-ring{0%,100%{transform:scale(1);opacity:.5;}50%{transform:scale(1.15);opacity:0;}}",
    ".dw-call-orb svg{width:40px;height:40px;fill:white;}",
    "#_dw-call-timer{font-size:28px;font-weight:700;color:#fff;letter-spacing:2px;font-variant-numeric:tabular-nums;}",
    "#_dw-call-status{font-size:13px;color:rgba(255,255,255,.6);}",
    ".dw-call-controls{display:flex;gap:16px;margin-top:8px;}",
    ".dw-call-ctrl{width:50px;height:50px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s;}",
    ".dw-call-ctrl svg{width:22px;height:22px;fill:white;}",
    ".dw-call-ctrl.mute{background:rgba(255,255,255,.12);}",
    ".dw-call-ctrl.mute:hover{background:rgba(255,255,255,.2);}",
    ".dw-call-ctrl.mute.muted{background:rgba(239,68,68,.4);}",
    ".dw-call-ctrl.hangup{background:#ef4444;}",
    ".dw-call-ctrl.hangup:hover{background:#dc2626;transform:scale(1.05);}",
  ].join("");
  document.head.appendChild(style);

  var fab = el("button", {id:"_dw-fab"});
  fab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg>';

  var box = el("div", {id:"_dw-box"});
  var head = el("div", {id:"_dw-head"});
  head.innerHTML = '<div class="dot"></div><span id="_dw-aname">Connecting\u2026</span><button id="_dw-call-btn" title="Voice Call"><svg viewBox="0 0 24 24"><path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011-.27 11.36 11.36 0 003.55.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.36 11.36 0 00.57 3.55 1 1 0 01-.27 1z"/></svg></button><span id="_dw-mode">Voice</span>';
  var msgs = el("div", {id:"_dw-msgs"});

  var listenBar = el("div", {id:"_dw-listen-bar"});
  listenBar.innerHTML = '<span>\uD83C\uDFA4 Listening\u2026 speak now</span><button id="_dw-cancel-listen">Cancel</button>';

  // Voice call overlay
  var voiceOverlay = el("div", {id:"_dw-voice-overlay"});
  voiceOverlay.innerHTML = '<div class="dw-call-orb"><svg viewBox="0 0 24 24"><path d="M6.62 10.79a15.05 15.05 0 006.59 6.59l2.2-2.2a1 1 0 011-.27 11.36 11.36 0 003.55.57 1 1 0 011 1V20a1 1 0 01-1 1A17 17 0 013 4a1 1 0 011-1h3.5a1 1 0 011 1 11.36 11.36 0 00.57 3.55 1 1 0 01-.27 1z"/></svg></div>' +
    '<div id="_dw-call-timer">00:00</div>' +
    '<div id="_dw-call-status">Connecting...</div>' +
    '<div class="dw-call-controls">' +
    '<button class="dw-call-ctrl mute" id="_dw-mute-btn" title="Mute"><svg viewBox="0 0 24 24"><path d="M12 1a4 4 0 014 4v6a4 4 0 01-8 0V5a4 4 0 014-4zm-2 17.93V21h-2a1 1 0 000 2h8a1 1 0 000-2h-2v-2.07A8.001 8.001 0 0020 11a1 1 0 00-2 0 6 6 0 01-12 0 1 1 0 00-2 0 8.001 8.001 0 006 7.93z"/></svg></button>' +
    '<button class="dw-call-ctrl hangup" id="_dw-hangup-btn" title="End Call"><svg viewBox="0 0 24 24"><path d="M12 9c-1.6 0-3.15.25-4.6.72v3.1c0 .39-.23.74-.56.9-.98.49-1.87 1.12-2.66 1.85-.18.18-.43.28-.7.28-.28 0-.53-.11-.71-.29L.29 13.08a.956.956 0 01-.29-.7c0-.28.11-.53.29-.71C3.34 8.78 7.46 7 12 7s8.66 1.78 11.71 4.67c.18.18.29.43.29.71 0 .28-.11.53-.29.71l-2.48 2.48c-.18.18-.43.29-.71.29-.27 0-.52-.1-.7-.28a11.27 11.27 0 00-2.67-1.85.996.996 0 01-.56-.9v-3.1C15.15 9.25 13.6 9 12 9z"/></svg></button>' +
    '</div>';

  var form = el("form", {id:"_dw-form"});
  var input = el("input", {id:"_dw-input", type:"text", placeholder:"Type or speak\u2026", autocomplete:"off"});
  var send = el("button", {id:"_dw-send", type:"submit"});
  send.innerHTML = '<svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';

  var mic = el("button", {id:"_dw-mic", type:"button", title:"Click to speak"});
  mic.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 1a4 4 0 014 4v6a4 4 0 01-8 0V5a4 4 0 014-4zm-2 17.93V21h-2a1 1 0 000 2h8a1 1 0 000-2h-2v-2.07A8.001 8.001 0 0020 11a1 1 0 00-2 0 6 6 0 01-12 0 1 1 0 00-2 0 8.001 8.001 0 006 7.93z"/></svg>';

  if (hasSpeechAPI) {
    form.appendChild(mic);
  }
  form.appendChild(input);
  form.appendChild(send);

  var brand = el("div", {id:"_dw-brand"}, "Powered by Dialog by NMC");
  box.appendChild(head);
  box.appendChild(msgs);
  box.appendChild(voiceOverlay);
  box.appendChild(listenBar);
  box.appendChild(form);
  box.appendChild(brand);
  document.body.appendChild(fab);
  document.body.appendChild(box);

  // ── Twilio Client SDK Voice Calling ──────────────────────────────────
  var twilioDevice = null;
  var twilioConnection = null;
  var callActive = false;
  var callMuted = false;
  var callStartTime = null;
  var callTimerInterval = null;
  var voiceEnabled = false;

  function formatCallTime(ms) {
    var secs = Math.floor(ms / 1000);
    var m = Math.floor(secs / 60).toString();
    var s = (secs % 60).toString();
    return (m.length < 2 ? '0' + m : m) + ':' + (s.length < 2 ? '0' + s : s);
  }

  function updateCallTimer() {
    if (!callStartTime) return;
    var el = document.getElementById('_dw-call-timer');
    if (el) el.textContent = formatCallTime(Date.now() - callStartTime);
  }

  function setCallStatus(text) {
    var el = document.getElementById('_dw-call-status');
    if (el) el.textContent = text;
  }

  function showVoiceOverlay(show) {
    voiceOverlay.classList.toggle('active', show);
    msgs.style.display = show ? 'none' : '';
    form.style.display = show ? 'none' : '';
    listenBar.style.display = show ? 'none' : '';
    var callBtn = document.getElementById('_dw-call-btn');
    if (callBtn) callBtn.classList.toggle('active', show);
  }

  function endTwilioCall() {
    if (twilioConnection) {
      try { twilioConnection.disconnect(); } catch(e) {}
      twilioConnection = null;
    }
    callActive = false;
    callMuted = false;
    if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
    showVoiceOverlay(false);
    var muteBtn = document.getElementById('_dw-mute-btn');
    if (muteBtn) muteBtn.classList.remove('muted');
  }

  function loadTwilioSDK() {
    return new Promise(function(resolve, reject) {
      if (window.Twilio && window.Twilio.Device) { resolve(); return; }
      var s = document.createElement('script');
      s.src = 'https://sdk.twilio.com/js/client/v1.14/twilio.min.js';
      s.onload = function() { resolve(); };
      s.onerror = function() { reject(new Error('Failed to load Twilio SDK')); };
      document.head.appendChild(s);
    });
  }

  function startTwilioCall() {
    if (callActive) { endTwilioCall(); return; }
    setCallStatus('Loading...');
    showVoiceOverlay(true);
    var timerEl = document.getElementById('_dw-call-timer');
    if (timerEl) timerEl.textContent = '00:00';

    loadTwilioSDK().then(function() {
      setCallStatus('Getting token...');
      return fetch(BASE_URL + '/api/widget/voice-token', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ apiKey: API_KEY })
      });
    }).then(function(r) {
      if (!r.ok) throw new Error('Token request failed');
      return r.json();
    }).then(function(data) {
      setCallStatus('Connecting...');
      twilioDevice = new window.Twilio.Device(data.token, { debug: false });

      twilioDevice.on('ready', function() {
        twilioConnection = twilioDevice.connect();

        twilioConnection.on('accept', function() {
          callActive = true;
          callStartTime = Date.now();
          callTimerInterval = setInterval(updateCallTimer, 1000);
          setCallStatus('Connected — speak now');
        });

        twilioConnection.on('disconnect', function() {
          setCallStatus('Call ended');
          endTwilioCall();
        });

        twilioConnection.on('error', function(err) {
          console.error('[widget/voice] Connection error:', err);
          setCallStatus('Call error');
          setTimeout(endTwilioCall, 2000);
        });
      });

      twilioDevice.on('error', function(err) {
        console.error('[widget/voice] Device error:', err);
        setCallStatus('Connection failed');
        setTimeout(endTwilioCall, 2000);
      });
    }).catch(function(err) {
      console.error('[widget/voice] Setup error:', err);
      setCallStatus('Failed: ' + err.message);
      setTimeout(endTwilioCall, 3000);
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
  function linkifyHtml(text) {
    var safe = escapeHtml(text);
    // 1. Parse markdown-style links: [text](url) -> clickable link
    safe = safe.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^\\s)]+)\\)/g, function(_, label, url) {
      var cleanUrl = url.replace(/[).,;:!?]+$/, '');
      return '<a href="' + cleanUrl + '" target="_blank" rel="noopener noreferrer" style="color:#a78bfa;text-decoration:underline;word-break:break-all">' + label + '</a>';
    });
    // 2. Linkify remaining bare URLs (not already inside href)
    safe = safe.replace(/(^|[^"=])(https?:\\/\\/[^\\s<]+)/g, function(match, prefix, url) {
      var cleanUrl = url.replace(/[).,;:!?]+$/, '');
      var trailing = url.slice(cleanUrl.length);
      return prefix + '<a href="' + cleanUrl + '" target="_blank" rel="noopener noreferrer" style="color:#a78bfa;text-decoration:underline;word-break:break-all">' + cleanUrl + '</a>' + trailing;
    });
    return safe;
  }
  function addMsg(text, who, isVoice) {
    var cls = "dw-msg " + who + (isVoice && who === "user" ? " voice" : "");
    var m = el("div", {class:cls});
    if (who === "bot") {
      m.innerHTML = linkifyHtml(text).replace(/\\n/g, "<br>");
    } else if (isVoice && who === "user") {
      // Show 3D audio wave animation instead of STT text (STT is often wrong)
      var orb = el("div", {class:"dw-voice-orb"});
      for (var bi = 0; bi < 7; bi++) { orb.appendChild(el("div", {class:"bar"})); }
      m.appendChild(orb);
      var lbl = el("span", {class:"dw-voice-label"}, "Voice message");
      m.appendChild(lbl);
    } else {
      m.textContent = text;
    }
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
  }

  var typingTimers = [];
  function setTyping(on) {
    var existing = document.getElementById("_dw-typing");
    if (on && !existing) {
      var t = el("div", {class:"dw-msg bot", id:"_dw-typing", style:"max-width:85%;"});
      var states = [
        { icon: "🤔", text: "Thinking..." },
        { icon: "📚", text: "Searching knowledge base..." },
        { icon: "🔍", text: "Finding relevant information..." },
        { icon: "📋", text: "Reviewing details..." },
        { icon: "✍️", text: "Crafting your answer..." },
        { icon: "🎯", text: "Almost ready..." },
        { icon: "⏳", text: "Finishing up..." },
        { icon: "💡", text: "Just a moment more..." }
      ];
      var shimmerHtml = '<div style="margin-top:8px;display:flex;flex-direction:column;gap:5px;">' +
        '<div style="height:8px;width:90%;border-radius:4px;background:linear-gradient(90deg,rgba(124,58,237,.1) 25%,rgba(124,58,237,.25) 50%,rgba(124,58,237,.1) 75%);background-size:200% 100%;animation:_dw-shimmer 1.5s ease-in-out infinite;"></div>' +
        '<div style="height:8px;width:70%;border-radius:4px;background:linear-gradient(90deg,rgba(124,58,237,.1) 25%,rgba(124,58,237,.25) 50%,rgba(124,58,237,.1) 75%);background-size:200% 100%;animation:_dw-shimmer 1.5s ease-in-out infinite;animation-delay:.2s;"></div>' +
        '<div style="height:8px;width:50%;border-radius:4px;background:linear-gradient(90deg,rgba(124,58,237,.1) 25%,rgba(124,58,237,.25) 50%,rgba(124,58,237,.1) 75%);background-size:200% 100%;animation:_dw-shimmer 1.5s ease-in-out infinite;animation-delay:.4s;"></div>' +
        '</div>';
      function updateState(idx) {
        if (!document.getElementById("_dw-typing")) return;
        var st = states[idx];
        t.innerHTML = '<div style="display:flex;flex-direction:column;gap:4px;">' +
          '<div style="display:flex;align-items:center;gap:8px;transition:opacity 0.3s ease;">' +
          '<span style="display:inline-block;animation:_dw-search 1.2s ease-in-out infinite;font-size:16px;">' + st.icon + '</span>' +
          '<span style="font-size:13px;opacity:0.9;font-style:italic;">' + st.text + '</span>' +
          '</div>' + shimmerHtml + '</div>';
        msgs.scrollTop = msgs.scrollHeight;
      }
      msgs.appendChild(t);
      updateState(0);
      typingTimers.push(setTimeout(function(){ updateState(1); }, 1500));
      typingTimers.push(setTimeout(function(){ updateState(2); }, 3500));
      typingTimers.push(setTimeout(function(){ updateState(3); }, 5500));
      typingTimers.push(setTimeout(function(){ updateState(4); }, 7500));
      typingTimers.push(setTimeout(function(){ updateState(5); }, 9500));
      typingTimers.push(setTimeout(function(){ updateState(6); }, 11500));
      typingTimers.push(setTimeout(function(){ updateState(7); }, 13500));
    }
    if (!on && existing) {
      existing.remove();
      typingTimers.forEach(clearTimeout);
      typingTimers = [];
    }
  }

  var INDIC_LANGS = ["kn-IN","hi-IN","ta-IN","te-IN","mr-IN"];
  var currentAudio = null;

  function playReplyAudio(audioBase64, mimeType) {
    if (!audioBase64) return;
    speaking = true;
    var finalMime = mimeType || "audio/mpeg";
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
    currentAudio = new Audio("data:" + finalMime + ";base64," + audioBase64);
    currentAudio.onended = currentAudio.onerror = function(){ speaking = false; currentAudio = null; };
    currentAudio.play().catch(function(){ speaking = false; });
  }

  // Split a reply into short utterances on sentence boundaries (Latin and
  // Devanagari/Indic punctuation). Falls back to a single chunk when there
  // are no clear breaks.
  function splitForTTS(text) {
    if (!text) return [];
    var raw = String(text).trim();
    if (!raw) return [];
    var parts = raw.split(/(?<=[\\.\\?!।॥])\\s+/);
    var chunks = [];
    var buf = "";
    for (var i = 0; i < parts.length; i++) {
      var p = (parts[i] || "").trim();
      if (!p) continue;
      // Glue ultra-short fragments to the previous chunk so we don't waste a
      // request on "Ok." or "Hi.".
      if (buf && (p.length < 20 || (buf + " " + p).length < 80)) {
        buf = (buf + " " + p).trim();
      } else if (buf) {
        chunks.push(buf);
        buf = p;
      } else {
        buf = p;
      }
    }
    if (buf) chunks.push(buf);
    return chunks.length > 0 ? chunks : [raw];
  }

  // Sentence-parallel TTS: fetch each sentence's audio concurrently and play
  // in order as soon as each one becomes ready. The first sentence starts
  // playing in ~1.5-2.5s instead of waiting for the full multi-sentence
  // synthesis (which used to take 6-10s for long Indic replies).
  var ttsQueue = [];
  var ttsPlaying = false;
  function ttsPlayNext() {
    if (ttsPlaying) return;
    if (ttsQueue.length === 0) { speaking = false; return; }
    var entry = ttsQueue[0];
    if (!entry.ready) return;
    ttsQueue.shift();
    if (!entry.audio) { ttsPlayNext(); return; }
    ttsPlaying = true;
    var finalMime = entry.audioMimeType || "audio/mpeg";
    if (currentAudio) { try { currentAudio.pause(); } catch(e){} }
    currentAudio = new Audio("data:" + finalMime + ";base64," + entry.audio);
    currentAudio.onended = currentAudio.onerror = function(){
      currentAudio = null;
      ttsPlaying = false;
      ttsPlayNext();
    };
    currentAudio.play().catch(function(){
      currentAudio = null;
      ttsPlaying = false;
      ttsPlayNext();
    });
  }
  function ttsCancelAll() {
    ttsQueue.length = 0;
    if (currentAudio) { try { currentAudio.pause(); } catch(e){} }
    currentAudio = null;
    ttsPlaying = false;
    speaking = false;
  }
  function speakReply(text, langOverride) {
    if (!text) return;
    speaking = true;
    ttsCancelAll();
    speaking = true;
    var ttsLang = langOverride || ((configuredLang === "auto") ? sessionLang : agentLang);
    // Strip any video-suggestion line (📺 ...) and bare URLs so the TTS engine
    // doesn't read out "h-t-t-p-s colon slash slash..." in the middle of an
    // otherwise natural reply.
    var ttsText = text.split("📺")[0].trim();
    ttsText = ttsText.replace(/https?:\\/\\/\\S+/g, "");
    if (!ttsText) return;
    var chunks = splitForTTS(ttsText);
    // Pre-allocate slot per chunk so order is preserved even if requests
    // resolve out-of-order.
    for (var i = 0; i < chunks.length; i++) {
      ttsQueue.push({ ready: false, audio: null, audioMimeType: null });
    }
    var queueRef = ttsQueue;
    chunks.forEach(function(chunk, idx) {
      var slot = queueRef[idx];
      fetch(BASE_URL + "/api/widget/tts", {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ text: chunk, language: ttsLang, apiKey: API_KEY })
      }).then(function(r){ return r.json(); }).then(function(data) {
        if (!slot) return;
        slot.audio = data && data.audio ? data.audio : null;
        slot.audioMimeType = data && data.audioMimeType ? data.audioMimeType : "audio/mpeg";
        slot.ready = true;
        ttsPlayNext();
      }).catch(function(){
        if (!slot) return;
        slot.ready = true;
        ttsPlayNext();
      });
    });
  }

  function sendMessage(msg, isVoice) {
    if (!msg) return;
    if (crmAuthRequired && !chatUnlocked) {
      handleCrmInput(msg);
      return;
    }
    input.value = "";
    addMsg(msg, "user", isVoice);
    history.push({role:"user", content:msg});
    setTyping(true);
    if (mic) mic.disabled = true;
    if (configuredLang === "auto") {
      var quickGuess = detectLangFromText(msg);
      if (quickGuess) sessionLang = quickGuess;
    }
    var chatBody = {
      apiKey: API_KEY,
      message: msg,
      history: history.slice(-6),
      includeAudio: false,
      isVoiceRequest: isVoice,
      sessionLanguage: sessionLang
    };
    if (crmSessionToken) chatBody.crmSessionToken = crmSessionToken;
    fetch(BASE_URL + "/api/widget/chat", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify(chatBody)
    }).then(function(r){
      return r.json().then(function(data) { return { ok: r.ok, status: r.status, data: data }; });
    }).then(function(res){
      setTyping(false);
      if (!res.ok && res.data && res.data.crmAuthRequired) {
        addMsg(res.data.reply || "Please verify your phone number to continue.", "bot", false);
        chatUnlocked = false;
        if (res.data.crmOrderRequired && crmSessionToken) {
          crmStep = "order";
          input.placeholder = "Enter your order ID\\u2026";
        } else {
          crmSessionToken = "";
          crmChallengeId = "";
          crmStep = "phone";
          input.placeholder = "Enter your registered phone number\\u2026";
        }
      } else if (!res.ok) {
        var errMsg = (res.data && (res.data.reply || res.data.error)) || "Something went wrong. Please try again.";
        if (res.status === 404) errMsg = "This widget is not active. Please contact the site owner.";
        addMsg(errMsg, "bot", false);
      } else {
        var reply = res.data.reply || "I\u2019m sorry, I didn\u2019t understand that.";
        addMsg(reply, "bot", false);
        history.push({role:"assistant", content:reply});
        if (res.data.detectedLanguage) sessionLang = res.data.detectedLanguage;
        if (isVoice) {
          // Server pre-generated TTS chunks in parallel — play them directly
          // without any extra fetch calls. This eliminates the N×RTT overhead
          // that used to add 4-8s of latency.
          if (res.data.audioChunks && res.data.audioChunks.length > 0) {
            ttsCancelAll();
            speaking = true;
            for (var ci = 0; ci < res.data.audioChunks.length; ci++) {
              ttsQueue.push({
                ready: true,
                audio: res.data.audioChunks[ci].audio,
                audioMimeType: res.data.audioChunks[ci].mimeType || "audio/wav"
              });
            }
            ttsPlayNext();
          } else if (res.data.audio) {
            // Legacy: monolithic audio from includeAudio=true
            playReplyAudio(res.data.audio, res.data.audioMimeType);
          } else {
            // Fallback: old client-side chunked fetch path
            speakReply(reply, res.data.detectedLanguage || sessionLang);
          }
        }
      }
    }).catch(function(err){
      setTyping(false);
      addMsg("Could not reach the server. Please check your connection and try again.", "bot", false);
    }).finally(function(){
      if (mic) mic.disabled = false;
    });
  }

  function handleCrmInput(msg) {
    input.value = "";
    addMsg(msg, "user", false);
    setTyping(true);
    if (mic) mic.disabled = true;

    function crmPost(path, body) {
      body.apiKey = API_KEY;
      return fetch(BASE_URL + "/api/widget/crm/" + path, {
        method: "POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify(body)
      }).then(function(r){ return r.json().then(function(d){ return { ok: r.ok, data: d || {} }; }); });
    }
    function done() { setTyping(false); if (mic) mic.disabled = false; }
    function failed() { done(); addMsg("Something went wrong. Please try again.", "bot", false); }

    function accessDisabled(res) {
      if (res.ok || res.data.error !== "customer_access_disabled") return false;
      crmAuthRequired = false;
      chatUnlocked = true;
      crmStep = "none";
      input.placeholder = "Type or speak\\u2026";
      return true;
    }

    if (crmStep === "phone") {
      crmPost("verification/start", { phone: msg }).then(function(res){
        done();
        addMsg(res.data.message || "Could not start verification.", "bot", false);
        if (accessDisabled(res)) return;
        if (res.ok && res.data.success) {
          crmChallengeId = res.data.challengeId || "";
          crmFactor = res.data.factor || "";
          crmStep = "factor";
          input.placeholder = crmFactor === "code"
            ? "Enter the 6-digit code (or type resend)\\u2026"
            : crmFactor === "date_of_birth"
              ? "DD/MM/YYYY\\u2026"
              : "Last " + (res.data.length || 4) + " digits of your order ID\\u2026";
        }
      }).catch(failed);
      return;
    }

    if (crmStep === "factor") {
      if (crmFactor === "code" && /^\\s*resend\\s*$/i.test(msg)) {
        crmPost("verification/resend", { challengeId: crmChallengeId }).then(function(res){
          done();
          addMsg(res.data.message || "Could not resend the code.", "bot", false);
        }).catch(failed);
        return;
      }
      var factorBody = { challengeId: crmChallengeId };
      if (crmFactor === "code") factorBody.code = msg.replace(/\\s+/g, "");
      else if (crmFactor === "date_of_birth") factorBody.dateOfBirth = msg.trim();
      else factorBody.orderDigits = msg.replace(/\\s+/g, "");
      crmPost("verification/verify", factorBody).then(function(res){
        done();
        if (accessDisabled(res)) { addMsg(res.data.message || "Please continue.", "bot", false); return; }
        if (res.ok && res.data.success) {
          crmSessionToken = res.data.sessionToken || "";
          crmChallengeId = "";
          if (res.data.orderSelected) {
            chatUnlocked = true;
            crmStep = "verified";
            input.placeholder = "Type or speak\\u2026";
            var hello = res.data.greeting || res.data.message || "You're verified.";
            history.push({role:"assistant", content:hello});
            addMsg(hello, "bot", false);
          } else {
            crmStep = "order";
            input.placeholder = "Enter your order ID\\u2026";
            addMsg(res.data.message || "You're verified.", "bot", false);
          }
        } else {
          addMsg(res.data.message || "Could not verify those details.", "bot", false);
        }
      }).catch(failed);
      return;
    }

    if (crmStep === "order") {
      crmPost("select-order", { sessionToken: crmSessionToken, orderId: msg }).then(function(res){
        done();
        var botMsg = res.data.message || "Could not find that order.";
        if (res.ok && res.data.success) {
          chatUnlocked = true;
          crmStep = "verified";
          input.placeholder = "Type or speak\\u2026";
          botMsg = res.data.greeting || botMsg;
          history.push({role:"assistant", content:botMsg});
        } else if (res.data.crmAuthRequired) {
          crmSessionToken = "";
          crmStep = "phone";
          input.placeholder = "Enter your registered phone number\\u2026";
        }
        addMsg(botMsg, "bot", false);
      }).catch(failed);
    }
  }

  function startCrmVerification(crmName) {
    crmAuthRequired = true;
    chatUnlocked = false;
    crmStep = "phone";
    input.placeholder = "Enter your registered phone number\\u2026";
    var label = crmName ? (" (" + crmName + ")") : "";
    addMsg("Welcome! To help you with your order, please enter your registered phone number" + label + ".", "bot", false);
  }

  function showStandardGreeting(cfg) {
    var greeting = cfg.greeting || ("Hi! I\\u2019m " + agentName + ". How can I help you today?");
    if (agentLang === "auto") {
      var langWrapper = el("div", {class: "dw-msg bot", style: "display:flex;flex-direction:column;gap:8px;"});
      langWrapper.textContent = "Please select your preferred language to begin:";
      var btnRow = el("div", {style: "display:flex;flex-wrap:wrap;gap:6px;margin-top:4px;"});
      var langs = [
        { label: "English", code: "en-US" },
        { label: "हिंदी", code: "hi-IN" },
        { label: "ಕನ್ನಡ", code: "kn-IN" },
        { label: "Other", code: "auto" }
      ];
      langs.forEach(function(l) {
        var btn = el("button", {style: "background:#7c3aed;color:#fff;border:none;border-radius:12px;padding:6px 12px;font-size:12px;cursor:pointer;"});
        btn.textContent = l.label;
        btn.onclick = function() {
          sessionLang = l.code;
          langWrapper.style.display = "none";
          if (l.label === "Other") {
            addMsg("You can type or speak the language you prefer (e.g., 'Speak in Tamil').", "bot", false);
          }
          addMsg(greeting, "bot", false);
          history.push({role:"assistant", content:greeting});
        };
        btnRow.appendChild(btn);
      });
      langWrapper.appendChild(btnRow);
      msgs.appendChild(langWrapper);
      msgs.scrollTop = msgs.scrollHeight;
    } else {
      addMsg(greeting, "bot", false);
      history.push({role:"assistant", content:greeting});
    }
  }

  function stopListening() {
    if (recognition) { try { recognition.stop(); } catch(e){} }
    listening = false;
    listenBar.classList.remove("active");
    if (mic) mic.classList.remove("listening");
  }

  function startListening() {
    if (listening) { stopListening(); return; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    recognition = new SpeechRecognition();
    var micLang;
    if (configuredLang === "auto") {
      micLang = sessionLang && sessionLang !== "auto" ? sessionLang : "en-IN";
    } else {
      micLang = agentLang;
    }
    recognition.lang = micLang;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;

    recognition.onstart = function() {
      listening = true;
      listenBar.classList.add("active");
      if (mic) mic.classList.add("listening");
    };
    recognition.onresult = function(event) {
      var transcript = event.results[0][0].transcript.trim();
      stopListening();
      if (transcript) sendMessage(transcript, true);
    };
    recognition.onerror = function(event) {
      stopListening();
      if (event.error === "not-allowed") {
        if (!micBlocked) {
          micBlocked = true;
          addMsg("Microphone access denied. Please allow microphone in your browser settings, then refresh the page.", "bot", false);
          // Hide mic button so user doesn't keep clicking it
          if (mic) { mic.style.display = "none"; }
        }
      } else if (event.error === "no-speech") {
        // Silent — user just didn't speak, no need for a message
      } else {
        addMsg("Voice capture error (" + event.error + "). You can type instead.", "bot", false);
      }
    };
    recognition.onend = function() {
      if (listening) stopListening();
    };
    try {
      recognition.start();
    } catch(e) {
      stopListening();
    }
  }

  fetch(BASE_URL + "/api/widget/config/" + API_KEY)
    .then(function(r){
      return r.json().then(function(data){ return { ok: r.ok, data: data }; });
    })
    .then(function(res){
      var nameEl = document.getElementById("_dw-aname");
      if (!res.ok) {
        if (nameEl) nameEl.textContent = "Offline";
        var modeEl = document.getElementById("_dw-mode");
        if (modeEl) { modeEl.textContent = "Offline"; modeEl.style.background = "rgba(239,68,68,.3)"; }
        addMsg("This widget is currently inactive. Please contact the site owner.", "bot", false);
        return;
      }
      var cfg = res.data;
      agentName = cfg.agentName || "Assistant";
      agentLang = cfg.language || "en-US";
      configuredLang = agentLang;
      sessionLang = agentLang === "auto" ? "en-IN" : agentLang;
      voiceEnabled = !!cfg.voiceEnabled;
      if (nameEl) nameEl.textContent = agentName;
      // Show the voice call button if voice calling is enabled
      var callBtnEl = document.getElementById('_dw-call-btn');
      if (callBtnEl && voiceEnabled) {
        callBtnEl.style.display = 'flex';
      }
      var modeBadge = document.getElementById("_dw-mode");
      if (modeBadge && agentLang === "auto") {
        modeBadge.textContent = "Auto";
        modeBadge.title = "Auto-detects English / Hindi / Kannada and more";
      }
      if (!hasSpeechAPI) {
        var modeEl2 = document.getElementById("_dw-mode");
        if (modeEl2) modeEl2.textContent = "Text";
      }
      if (cfg.crmAuthRequired) {
        startCrmVerification(cfg.crmName);
      } else {
        showStandardGreeting(cfg);
      }
    })
    .catch(function(){
      var nameEl = document.getElementById("_dw-aname");
      if (nameEl) nameEl.textContent = "Offline";
      addMsg("Could not connect to the assistant. Please try again later.", "bot", false);
    });

  if (window.speechSynthesis) {
    window.speechSynthesis.getVoices();
    window.speechSynthesis.onvoiceschanged = function(){ window.speechSynthesis.getVoices(); };
  }

  fab.addEventListener("click", function(){
    open = !open;
    box.classList.toggle("open", open);
    if (open && !hasSpeechAPI) input.focus();
  });

  if (mic) {
    mic.addEventListener("click", function(){
      startListening();
    });
  }

  // Voice call button in header
  var callBtn = document.getElementById('_dw-call-btn');
  if (callBtn) {
    callBtn.addEventListener('click', function() {
      startTwilioCall();
    });
  }

  // Mute button
  var muteBtn = document.getElementById('_dw-mute-btn');
  if (muteBtn) {
    muteBtn.addEventListener('click', function() {
      if (!twilioConnection) return;
      callMuted = !callMuted;
      twilioConnection.mute(callMuted);
      muteBtn.classList.toggle('muted', callMuted);
    });
  }

  // Hangup button
  var hangupBtn = document.getElementById('_dw-hangup-btn');
  if (hangupBtn) {
    hangupBtn.addEventListener('click', function() {
      endTwilioCall();
    });
  }

  document.getElementById("_dw-cancel-listen").addEventListener("click", function(){
    stopListening();
  });

  form.addEventListener("submit", function(e){
    e.preventDefault();
    stopListening();
    var msg = input.value.trim();
    if (!msg) return;
    sendMessage(msg, false);
  });
})();
`.trim();

  res.type("application/javascript").send(js);
});

export default router;
