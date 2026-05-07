import { Router, type IRouter } from "express";
import { db, agentConfigsTable, callLogsTable, trainingDataTable, callingScriptsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { randomUUID } from "crypto";

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

async function generateSarvamWidgetTTS(text: string, lang: string): Promise<string | null> {
  if (!SARVAM_API_KEY || !isSarvamSupportedTTS(lang)) return null;

  const target = sarvamTargetLang(lang);
  const speaker = BULBUL_VOICE_FOR_LANG[lang] ?? BULBUL_VOICE_FOR_LANG[target] ?? BULBUL_FEMALE_FALLBACKS[0];
  const res = await fetch("https://api.sarvam.ai/text-to-speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": SARVAM_API_KEY,
    },
    body: JSON.stringify({
      inputs: [text],
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
    const errorText = await res.text();
    throw new Error(`Sarvam widget TTS error ${res.status}: ${errorText}`);
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

async function synthesizeWidgetTTS(
  text: string,
  voice: string,
  language: string,
): Promise<{ audio: string | null; provider: "sarvam" | "openai" | null; mimeType: string }> {
  // Voice policy: ALWAYS female + Indian accent. Route every supported
  // language (including English) through Sarvam Bulbul v3 first.
  if (isSarvamSupportedTTS(language)) {
    try {
      const sarvamAudio = await generateSarvamWidgetTTS(text, language);
      if (sarvamAudio) return { audio: sarvamAudio, provider: "sarvam", mimeType: "audio/wav" };
    } catch (sarvamErr) {
      console.error("[widget/tts] Sarvam TTS failed, falling back to OpenAI:", sarvamErr);
    }
  }

  // OpenAI fallback only used if Sarvam is unavailable. Keep a female voice.
  try {
    const fallbackVoice = ["nova", "shimmer", "coral", "sage"].includes(voice) ? voice : "nova";
    const openAiAudio = await generateOpenAIWidgetTTS(text, fallbackVoice);
    return { audio: openAiAudio, provider: "openai", mimeType: "audio/mpeg" };
  } catch (openAiErr) {
    console.error("[widget/tts] OpenAI TTS error:", openAiErr);
    return { audio: null, provider: null, mimeType: "audio/mpeg" };
  }
}

const KB_ENTRY_MAX_CHARS = 280;
const KB_MAX_ENTRIES = 4;

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
  ];
  const hindiHints = [
    "mujhe", "mujh", "aap", "kya", "kaise", "hai", "hain", "nahi", "chahiye", "karna",
    "meri", "mera", "hum", "batao", "samjhao", "kar sakte", "ke baare", "thoda",
    "bata", "bataa", "samajh", "krpya", "kripya",
  ];
  const tamilHints = ["enna", "yenna", "naan", "naangal", "ennoda", "konjam", "vendam", "venum", "irukku", "panra", "panren"];
  const teluguHints = ["nenu", "meeru", "enti", "emi", "kavali", "kavalsina", "chestunna", "chestunnaru", "ela"];
  const marathiHints = ["mala", "tula", "tumhi", "kasa", "kase", "ahe", "pahije", "karto", "kartoy"];

  const score = (hints: string[]) => hints.reduce((acc, token) => acc + (lower.includes(token) ? 1 : 0), 0);
  const ranked = ([
    { lang: "kn-IN" as LangCode, s: score(kannadaHints) },
    { lang: "hi-IN" as LangCode, s: score(hindiHints) },
    { lang: "ta-IN" as LangCode, s: score(tamilHints) },
    { lang: "te-IN" as LangCode, s: score(teluguHints) },
    { lang: "mr-IN" as LangCode, s: score(marathiHints) },
  ] as Array<{ lang: LangCode; s: number }>).sort((a, b) => b.s - a.s);
  if (ranked[0].s >= 2) return { lang: ranked[0].lang, score: ranked[0].s };
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
): Promise<LangCode | null> {
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
      "3. Romanized Indic with strong markers: nanu/maadi/beku → kn-IN, mujhe/aap/kya → hi-IN, naan/enna → ta-IN, nenu/meeru → te-IN, mala/tumhi → mr-IN.",
      "4. Domain terms like 'BBMP', 'e-Khata', 'ekhata', 'khata', 'ePID', 'PID', 'amalgamation' are LANGUAGE-NEUTRAL — used freely in English, Hindi and Kannada. Do NOT use them as language signals.",
      "5. If the user writes plainly in English (e.g. 'can you tell me about ekhata', 'how do I apply') reply in en-US — even if the prior turn was Indic. The user is switching back.",
      "6. Default en-US only when nothing else applies.",
      sessionLanguage ? `Previous session language was: ${sessionLanguage}.` : "",
      "Output the code only. No quotes. No explanation.",
    ].filter(Boolean).join("\n");
    const userBlock = `${recent ? recent + "\n" : ""}USER (latest): ${message.slice(0, 500)}`;
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_completion_tokens: 6,
      temperature: 0,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userBlock },
      ],
    });
    const raw = (completion.choices[0]?.message?.content || "").trim();
    const code = raw.replace(/[^a-zA-Z-]/g, "");
    const found = ALL_LANG_CODES.find(c => c.toLowerCase() === code.toLowerCase());
    return found ?? null;
  } catch (err) {
    console.error("[widget/lang] LLM resolve failed:", err);
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
  sessionLanguage?: string | null,
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
  if (romanized && romanized.score >= 3 && eng.ratio < 0.3) {
    return { lang: romanized.lang, source: "romanized-strong" };
  }

  // Truly ambiguous: only call the LLM arbiter when heuristics conflict, NOT
  // for every message. This was previously firing on common English words
  // ("in", "me") and adding 400–800ms to every turn.
  const conflictingSignals =
    (native && romanized && native.lang !== romanized.lang) ||
    (hasNativeChars && eng.ratio >= 0.35) ||
    (romanized && eng.ratio >= 0.2 && eng.ratio < 0.4);
  if (conflictingSignals) {
    const arbiter = await llmResolveLanguage(message, history, sessionLanguage ?? null);
    if (arbiter) return { lang: arbiter, source: "llm-arbiter" };
  }

  if (native) return { lang: native.lang, source: "native-script-weak" };
  if (romanized && eng.ratio < 0.3) return { lang: romanized.lang, source: "romanized-weak" };

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
  const trimmed = reply.trim();
  if (!isIndianLanguage(language)) return trimmed;
  // Replace English greetings the model occasionally code-switches into.
  return trimmed
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
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_completion_tokens: 200,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: `You are a transliteration assistant. Rewrite the user's text in NATIVE ${info.script}. Preserve the meaning and tone EXACTLY — do not add, remove or summarise. Keep brand names like BBMP, e-Khata, ePID, PID and URLs in their original Latin form. Output only the rewritten text. Example: ${info.example}`,
        },
        { role: "user", content: reply },
      ],
    });
    const rewritten = completion.choices[0]?.message?.content?.trim();
    if (!rewritten) return null;
    // Sanity check — make sure the rewrite is actually in native script now.
    if (isIndicReplyRomanized(rewritten, language)) return null;
    return rewritten;
  } catch (err) {
    console.error("[widget/chat] rewrite-to-native failed:", err);
    return null;
  }
}

async function ensureNativeScript(
  reply: string,
  language: string,
): Promise<{ reply: string; rewrote: boolean }> {
  if (!isIndianLanguage(language)) return { reply, rewrote: false };
  if (!isIndicReplyRomanized(reply, language)) return { reply, rewrote: false };
  console.warn(`[widget/chat] romanized output detected for ${language}, rewriting…`);
  const rewritten = await rewriteToNativeScript(reply, language);
  if (rewritten) return { reply: rewritten, rewrote: true };
  return { reply, rewrote: false };
}

// Some providers (Sarvam-M, several OpenAI-compatible Indic endpoints) are
// strict about message ordering:
//   1. EXACTLY ONE system message at the very top.
//   2. The first non-system message MUST be from "user" (Sarvam returns 400:
//      "First message must be from user (or after system message)").
//   3. user/assistant turns should alternate.
// We merge extra system instructions into the leading system message, then
// drop any leading assistant turns (typically the bot's greeting) so the
// first message after system is from the user.
function normalizeMessagesForSingleSystem(messages: any[]): any[] {
  const systemParts: string[] = [];
  let rest: any[] = [];
  for (const m of messages) {
    if (m && m.role === "system" && typeof m.content === "string") {
      systemParts.push(m.content);
    } else if (m && m.role) {
      rest.push(m);
    }
  }
  while (rest.length > 0 && rest[0].role !== "user") {
    rest = rest.slice(1);
  }
  // Collapse any consecutive same-role turns by keeping the latest, which
  // protects against history corruption (e.g. two assistant turns in a row).
  const cleaned: any[] = [];
  for (const m of rest) {
    if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === m.role) {
      cleaned[cleaned.length - 1] = m;
    } else {
      cleaned.push(m);
    }
  }
  if (systemParts.length === 0) return cleaned;
  return [{ role: "system", content: systemParts.join("\n\n") }, ...cleaned];
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
  console.warn(`[widget/chat] circuit-break ${name} for ${cooldownMs}ms: ${reason}`);
}

async function callDeepSeekChat(
  messages: any[],
): Promise<string | null> {
  if (!DEEPSEEK_API_KEY) return null;
  const tripped = isProviderTripped("deepseek");
  if (tripped) {
    console.log(`[widget/chat] DeepSeek skipped (circuit open: ${tripped})`);
    return null;
  }
  try {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: normalizeMessagesForSingleSystem(messages),
        max_tokens: 140,
        temperature: 0.4,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[widget/chat] DeepSeek failed: ${res.status} ${body}`);
      // Insufficient balance / auth → don't hammer the provider for 10 minutes
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        tripProvider("deepseek", `${res.status} ${body.slice(0, 120)}`, 10 * 60 * 1000);
      } else if (res.status === 429) {
        tripProvider("deepseek", "rate-limit", 60 * 1000);
      }
      return null;
    }
    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.error("[widget/chat] DeepSeek exception:", err);
    return null;
  }
}

async function callSarvamChat(
  messages: any[],
): Promise<string | null> {
  if (!SARVAM_API_KEY) return null;
  const tripped = isProviderTripped("sarvam-m");
  if (tripped) {
    console.log(`[widget/chat] Sarvam-M skipped (circuit open: ${tripped})`);
    return null;
  }
  try {
    const res = await fetch("https://api.sarvam.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SARVAM_API_KEY}`,
      },
      body: JSON.stringify({
        model: "sarvam-m",
        messages: normalizeMessagesForSingleSystem(messages),
        max_completion_tokens: 140,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`[widget/chat] Sarvam-M failed: ${res.status} ${body}`);
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        tripProvider("sarvam-m", `${res.status} ${body.slice(0, 120)}`, 10 * 60 * 1000);
      } else if (res.status === 429) {
        tripProvider("sarvam-m", "rate-limit", 60 * 1000);
      }
      return null;
    }
    const data = await res.json() as any;
    return data.choices?.[0]?.message?.content ?? null;
  } catch (err) {
    console.error("[widget/chat] Sarvam-M exception:", err);
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
  history: { role: string; content: string }[],
  message: string,
  language: string,
): Promise<{ reply: string; modelUsed: string }> {
  const normalizedLanguage = language || "en-US";
  const messages: any[] = [
    { role: "system", content: systemPrompt },
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: message },
  ];

  const NATIVE_LANG_NAMES: Record<string, { name: string; script: string }> = {
    "hi-IN": { name: "Hindi", script: "Devanagari (देवनागरी)" },
    "kn-IN": { name: "Kannada", script: "ಕನ್ನಡ ಲಿಪಿ" },
    "ta-IN": { name: "Tamil", script: "தமிழ் எழுத்து" },
    "te-IN": { name: "Telugu", script: "తెలుగు లిపి" },
    "mr-IN": { name: "Marathi", script: "Devanagari (देवनागरी)" },
  };

  // --- Hindi: prefer DeepSeek V3 (best Hinglish + Devanagari accuracy) ---
  if (normalizedLanguage === "hi-IN" && DEEPSEEK_API_KEY) {
    const styleSystem = `Reply ONLY in natural Hindi written in NATIVE Devanagari script (देवनागरी). Never use romanized/Hinglish letters. Keep replies under 2 sentences. The user's input may mix scripts or use transliteration — understand their intent and ANSWER the question. NEVER reply with a clarification question if the intent is clear.`;
    const reply = await callDeepSeekChat([{ role: "system", content: styleSystem }, ...messages]);
    if (reply) {
      const normalized = normalizeIndicReply(reply, normalizedLanguage);
      const fixed = await ensureNativeScript(normalized, normalizedLanguage);
      return { reply: fixed.reply, modelUsed: fixed.rewrote ? "deepseek-chat+rewrite" : "deepseek-chat" };
    }
  }

  // --- Kannada/Tamil/Telugu/Marathi: prefer Sarvam-M (Indic-native) ---
  const langInfo = NATIVE_LANG_NAMES[normalizedLanguage];
  if (langInfo && normalizedLanguage !== "hi-IN" && SARVAM_API_KEY) {
    const styleSystem = `Reply ONLY in natural ${langInfo.name} written in NATIVE ${langInfo.script}. Output MUST be in ${langInfo.script}. NEVER romanize. NEVER use Latin/English letters except for brand names like "BBMP", "e-Khata", "ePID" or URLs. If you cannot produce native script, output nothing. Keep replies under 2 sentences. The user's input may be transliterated (e.g. English words in Devanagari, or ${langInfo.name} words in Roman letters) — understand the intent and ANSWER the question directly. NEVER respond with a clarification request when the user has already asked something specific.`;
    const reply = await callSarvamChat([{ role: "system", content: styleSystem }, ...messages]);
    if (reply) {
      const normalized = normalizeIndicReply(reply, normalizedLanguage);
      const fixed = await ensureNativeScript(normalized, normalizedLanguage);
      return { reply: fixed.reply, modelUsed: fixed.rewrote ? "sarvam-m+rewrite" : "sarvam-m" };
    }
  }

  // --- English (or any fallback): gpt-4o-mini (fast & multilingual) ---
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_completion_tokens: 140,
    messages,
  });
  const reply = completion.choices[0]?.message?.content || "I'm sorry, I couldn't process that. Could you try again?";
  const normalized = normalizeIndicReply(reply, normalizedLanguage);
  // gpt-4o-mini reliably produces native script for Indic; only run the
  // ensureNativeScript safety net when the language is non-English to keep
  // the English fast-path latency-free.
  if (!isIndianLanguage(normalizedLanguage)) {
    return { reply: normalized, modelUsed: "gpt-4o-mini" };
  }
  const fixed = await ensureNativeScript(normalized, normalizedLanguage);
  return { reply: fixed.reply, modelUsed: fixed.rewrote ? "gpt-4o-mini+rewrite" : "gpt-4o-mini" };
}

async function getAgentByWidgetKey(apiKey: string) {
  return db.query.agentConfigsTable.findFirst({
    where: and(eq(agentConfigsTable.widgetApiKey, apiKey), eq(agentConfigsTable.widgetEnabled, true)),
  });
}

async function buildSystemPromptForWidget(userId: number, agentConfig: any): Promise<string> {
  const [trainingData, scripts] = await Promise.all([
    db.select().from(trainingDataTable).where(eq(trainingDataTable.userId, userId)).limit(KB_MAX_ENTRIES),
    db.select().from(callingScriptsTable)
      .where(and(eq(callingScriptsTable.userId, userId), eq(callingScriptsTable.isDefault, true)))
      .limit(1),
  ]);

  let system = `You are ${agentConfig.agentName || "SalesBot"}, an AI sales representative`;
  if (agentConfig.personality) system += ` with a ${agentConfig.personality} personality`;
  system += `. You are chatting with a visitor on the company website. Keep responses concise — 2 short sentences max. Be helpful and guide the visitor toward taking an action. Never mention you are an AI unless directly asked.\n\n`;

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
      const snippet = td.content.length > KB_ENTRY_MAX_CHARS
        ? td.content.slice(0, KB_ENTRY_MAX_CHARS).trimEnd() + "…"
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
  return system;
}

router.get("/widget/config/:apiKey", async (req, res) => {
  const agent = await getAgentByWidgetKey(req.params.apiKey);
  if (!agent) {
    res.status(404).json({ error: "Widget not found or disabled" });
    return;
  }
  res.json({
    agentName: agent.agentName,
    greeting: agent.greeting || `Hi! I'm ${agent.agentName}. How can I help you today?`,
    language: agent.language || "en-US",
    personality: agent.personality,
  });
});

router.post("/widget/chat", async (req, res) => {
  const { apiKey, message, history, includeAudio, sessionLanguage } = req.body as {
    apiKey: string;
    message: string;
    history?: { role: string; content: string }[];
    includeAudio?: boolean;
    sessionLanguage?: string;
  };

  if (!apiKey || !message) {
    res.status(400).json({ error: "apiKey and message are required" });
    return;
  }

  const agent = await getAgentByWidgetKey(apiKey);
  if (!agent) {
    res.status(404).json({ error: "Widget not found or disabled" });
    return;
  }

  const safeHistory = Array.isArray(history) ? history : [];
  const resolved = await resolveEffectiveWidgetLanguage(
    agent.language,
    message,
    safeHistory,
    sessionLanguage,
  );
  const effectiveLanguage = resolved.lang;
  const systemPrompt = await buildSystemPromptForWidget(agent.userId, {
    ...agent,
    language: effectiveLanguage,
  });
  let reply: string;
  let modelUsed = "gpt-4o-mini";
  try {
    const generation = await generateWidgetReply(
      systemPrompt,
      safeHistory,
      message,
      effectiveLanguage,
    );
    reply = generation.reply;
    modelUsed = generation.modelUsed;
  } catch (err) {
    console.error("Widget AI error:", err);
    reply = "Sorry, I'm having a moment. Please try again shortly.";
  }

  await db.insert(callLogsTable).values({
    userId: agent.userId,
    direction: "widget",
    phone: "web-widget",
    outcome: "answered",
    aiModel: modelUsed,
    startedAt: new Date(),
    endedAt: new Date(),
    duration: 0,
    estimatedCostUsd: "0",
    billedCostUsd: "0",
  }).catch(() => {});

  const language = effectiveLanguage;
  let audio: string | null = null;
  let provider: "sarvam" | "openai" | null = null;
  let audioMimeType = "audio/mpeg";

  if (includeAudio) {
    const ttsResult = await synthesizeWidgetTTS(reply, agent.voice || "nova", language);
    audio = ttsResult.audio;
    provider = ttsResult.provider;
    audioMimeType = ttsResult.mimeType;
  }

  console.log(`[widget/chat] configured=${agent.language} effective=${language} source=${resolved.source} session=${sessionLanguage ?? "-"} model=${modelUsed} tts=${provider ?? "none"} includeAudio=${!!includeAudio}`);

  res.json({
    reply,
    agentName: agent.agentName,
    language,
    detectedLanguage: language,
    configuredLanguage: agent.language,
    modelUsed,
    audio,
    provider,
    audioMimeType,
  });
});

// Server-side TTS for the Web Widget using OpenAI TTS (Fast, multilingual, high-quality)
router.post("/widget/tts", async (req, res) => {
  const { text, apiKey, language: requestedLanguage } = req.body as { text?: string; language?: string; apiKey?: string };
  if (!text) {
    res.status(400).json({ error: "text is required" });
    return;
  }
  
  let voice = "nova";
  let language = requestedLanguage || "en-US";
  if (apiKey) {
    const agent = await getAgentByWidgetKey(apiKey);
    if (agent?.voice) voice = agent.voice;
    if ((!requestedLanguage || requestedLanguage === "auto") && agent?.language) {
      language = agent.language;
    }
  }

  const ttsResult = await synthesizeWidgetTTS(text, voice, language);
  if (!ttsResult.audio) {
    res.status(502).json({ error: "TTS failed" });
    return;
  }
  console.log(`[widget/tts] lang=${language} provider=${ttsResult.provider ?? "none"} mime=${ttsResult.mimeType}`);
  res.json({ audio: ttsResult.audio, provider: ttsResult.provider, language, audioMimeType: ttsResult.mimeType });
});

router.get("/widget/loader.js", async (req, res) => {
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
    ".dw-msg.user.voice{background:linear-gradient(135deg,#7c3aed,#4f46e5);display:flex;align-items:center;gap:6px;}",
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
    "#_dw-listen-bar{display:none;align-items:center;gap:8px;padding:6px 12px;background:rgba(239,68,68,.12);border-top:1px solid rgba(239,68,68,.2);}",
    "#_dw-listen-bar.active{display:flex;}",
    "#_dw-listen-bar span{font-size:12px;color:#fca5a5;flex:1;}",
    "#_dw-listen-bar button{border:none;background:none;color:#fca5a5;cursor:pointer;font-size:11px;padding:2px 6px;border-radius:4px;}",
    "#_dw-listen-bar button:hover{background:rgba(239,68,68,.2);}",
    "#_dw-brand{font-size:10px;color:rgba(255,255,255,.3);text-align:center;padding:4px 0 8px;letter-spacing:.5px;}",
  ].join("");
  document.head.appendChild(style);

  var fab = el("button", {id:"_dw-fab"});
  fab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"/></svg>';

  var box = el("div", {id:"_dw-box"});
  var head = el("div", {id:"_dw-head"});
  head.innerHTML = '<div class="dot"></div><span id="_dw-aname">Connecting\u2026</span><span id="_dw-mode">Voice</span>';
  var msgs = el("div", {id:"_dw-msgs"});

  var listenBar = el("div", {id:"_dw-listen-bar"});
  listenBar.innerHTML = '<span>\uD83C\uDFA4 Listening\u2026 speak now</span><button id="_dw-cancel-listen">Cancel</button>';

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
  box.appendChild(listenBar);
  box.appendChild(form);
  box.appendChild(brand);
  document.body.appendChild(fab);
  document.body.appendChild(box);

  function addMsg(text, who, isVoice) {
    var cls = "dw-msg " + who + (isVoice && who === "user" ? " voice" : "");
    var m = el("div", {class:cls}, text);
    msgs.appendChild(m);
    msgs.scrollTop = msgs.scrollHeight;
  }

  function setTyping(on) {
    var existing = document.getElementById("_dw-typing");
    if (on && !existing) {
      var t = el("div", {class:"dw-msg bot", id:"_dw-typing"}, "\u2026");
      msgs.appendChild(t);
      msgs.scrollTop = msgs.scrollHeight;
    }
    if (!on && existing) existing.remove();
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

  function speakReply(text, langOverride) {
    if (!text) return;
    speaking = true;
    var ttsLang = langOverride || ((configuredLang === "auto") ? sessionLang : agentLang);
    fetch(BASE_URL + "/api/widget/tts", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ text: text, language: ttsLang, apiKey: API_KEY })
    }).then(function(r){ return r.json(); }).then(function(data) {
      if (data.audio) {
        playReplyAudio(data.audio, data.audioMimeType);
      } else { speaking = false; }
    }).catch(function(){ speaking = false; });
  }

  function sendMessage(msg, isVoice) {
    if (!msg) return;
    input.value = "";
    addMsg(msg, "user", isVoice);
    history.push({role:"user", content:msg});
    setTyping(true);
    if (mic) mic.disabled = true;
    if (configuredLang === "auto") {
      var quickGuess = detectLangFromText(msg);
      if (quickGuess) sessionLang = quickGuess;
    }
    fetch(BASE_URL + "/api/widget/chat", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        apiKey: API_KEY,
        message: msg,
        history: history.slice(-6),
        // Decoupled TTS: never bundle audio in the chat response — the LLM
        // alone is fast (~1–3s), TTS for long Indic replies is 3–6s. By fetching
        // TTS separately AFTER the text arrives we cut perceived latency in half.
        includeAudio: false,
        sessionLanguage: sessionLang
      })
    }).then(function(r){
      return r.json().then(function(data) { return { ok: r.ok, status: r.status, data: data }; });
    }).then(function(res){
      setTyping(false);
      if (!res.ok) {
        var errMsg = (res.data && res.data.error) || "Something went wrong. Please try again.";
        if (res.status === 404) errMsg = "This widget is not active. Please contact the site owner.";
        addMsg(errMsg, "bot", false);
      } else {
        var reply = res.data.reply || "I\u2019m sorry, I didn\u2019t understand that.";
        addMsg(reply, "bot", false);
        history.push({role:"assistant", content:reply});
        if (res.data.detectedLanguage) sessionLang = res.data.detectedLanguage;
        if (isVoice) {
          // Server returns text immediately; fetch TTS separately so audio
          // plays as soon as it arrives without blocking the visible reply.
          if (res.data.audio) playReplyAudio(res.data.audio, res.data.audioMimeType);
          else speakReply(reply, res.data.detectedLanguage || sessionLang);
        }
      }
    }).catch(function(err){
      setTyping(false);
      addMsg("Could not reach the server. Please check your connection and try again.", "bot", false);
    }).finally(function(){
      if (mic) mic.disabled = false;
    });
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
      if (nameEl) nameEl.textContent = agentName;
      var modeBadge = document.getElementById("_dw-mode");
      if (modeBadge && agentLang === "auto") {
        modeBadge.textContent = "Auto";
        modeBadge.title = "Auto-detects English / Hindi / Kannada and more";
      }
      if (!hasSpeechAPI) {
        var modeEl2 = document.getElementById("_dw-mode");
        if (modeEl2) modeEl2.textContent = "Text";
      }
      var greeting = cfg.greeting || ("Hi! I\u2019m " + agentName + ". How can I help you today?");
      addMsg(greeting, "bot", false);
      history.push({role:"assistant", content:greeting});
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
