import { Router, type IRouter } from "express";
import { db, agentConfigsTable, callLogsTable, trainingDataTable, callingScriptsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { openai } from "@workspace/integrations-openai-ai-server";
import { randomUUID } from "crypto";

const router: IRouter = Router();

const SARVAM_API_KEY = process.env.SARVAM_API_KEY ?? "";

const INDIAN_LANGUAGES = new Set(["kn-IN", "hi-IN", "ta-IN", "te-IN", "mr-IN"]);

const BULBUL_VOICE_FOR_LANG: Record<string, string> = {
  "hi-IN": "kavya",
  "kn-IN": "kavya",
  "ta-IN": "priya",
  "te-IN": "pooja",
  "mr-IN": "simran",
};

function isIndianLanguage(lang?: string | null): boolean {
  return INDIAN_LANGUAGES.has(lang ?? "");
}

async function generateSarvamWidgetTTS(text: string, lang: string): Promise<string | null> {
  if (!SARVAM_API_KEY || !isIndianLanguage(lang)) return null;

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
  if (isIndianLanguage(language)) {
    try {
      const sarvamAudio = await generateSarvamWidgetTTS(text, language);
      if (sarvamAudio) return { audio: sarvamAudio, provider: "sarvam", mimeType: "audio/wav" };
    } catch (sarvamErr) {
      console.error("[widget/tts] Sarvam TTS failed, falling back to OpenAI:", sarvamErr);
    }
  }

  try {
    const openAiAudio = await generateOpenAIWidgetTTS(text, voice);
    return { audio: openAiAudio, provider: "openai", mimeType: "audio/mpeg" };
  } catch (openAiErr) {
    console.error("[widget/tts] OpenAI TTS error:", openAiErr);
    return { audio: null, provider: null, mimeType: "audio/mpeg" };
  }
}

const KB_ENTRY_MAX_CHARS = 300;
const KB_MAX_ENTRIES = 6;

const SUPPORTED_LANGUAGES_LINE =
  "You support these languages and MUST be able to converse in any of them: English (en-US), Hindi (hi-IN), Kannada (kn-IN), Tamil (ta-IN), Telugu (te-IN), and Marathi (mr-IN). NEVER tell the user you only speak English or Hindi. If the user asks for Kannada / Tamil / Telugu / Marathi, switch to that language immediately and continue the entire conversation in it.";

function buildRomanizedScriptInstruction(language?: string | null): string {
  if (language === "hi-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Hindi using only English letters (romanized Hindi / Hinglish). Never use Devanagari or Urdu script.";
  }
  if (language === "kn-IN") {
    return "CRITICAL SCRIPT RULE: Reply in Kannada using only English letters (romanized Kannada). Never use Kannada script. Example style: 'Namaskara! Naanu nimage hege sahaaya maadabahudu?'";
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
    return "CRITICAL SCRIPT RULE: Detect the user's language from their message. If they use Hindi / Kannada / Tamil / Telugu / Marathi, reply in that same language but ONLY in English letters (romanized). Never use Devanagari, Kannada, Tamil, Telugu, or Urdu script.";
  }
  return "";
}

function detectRomanizedIndicLanguage(text: string): "hi-IN" | "kn-IN" | "ta-IN" | "te-IN" | "mr-IN" | null {
  const lower = text.toLowerCase();

  const explicitMentions: Array<[RegExp, "hi-IN" | "kn-IN" | "ta-IN" | "te-IN" | "mr-IN"]> = [
    [/\b(kannada|kanada|canada)\b/, "kn-IN"],
    [/\b(hindi|hindii)\b/, "hi-IN"],
    [/\b(tamil|tamizh)\b/, "ta-IN"],
    [/\b(telugu)\b/, "te-IN"],
    [/\b(marathi)\b/, "mr-IN"],
  ];
  for (const [pattern, lang] of explicitMentions) {
    if (pattern.test(lower)) return lang;
  }

  const kannadaHints = [
    "nanag", "nanage", "nanu", "nanna", "beku", "bekagittu", "bagge", "yaake", "yake",
    "yenu", "enu", "ide", "illa", "kodti", "kodutte", "heli", "tilsi", "saku",
    "namaskara", "hege", "yelli", "yaaru", "maadi", "maadu", "maadta", "maaduttare",
    "guru", "swalpa", "thumba", "barbeku", "barthini",
  ];
  const hindiHints = [
    "mujhe", "mujh", "aap", "kya", "kaise", "hai", "hain", "nahi", "chahiye", "karna",
    "meri", "mera", "hum", "batao", "samjhao", "kar sakte", "ke baare", "thoda",
  ];
  const tamilHints = ["enna", "yenna", "naan", "naangal", "ennoda", "konjam", "vendam", "venum", "irukku", "panra", "panren"];
  const teluguHints = ["nenu", "meeru", "enti", "emi", "kavali", "kavalsina", "chestunna", "chestunnaru", "ela"];
  const marathiHints = ["mala", "tula", "tumhi", "kasa", "kase", "ahe", "nahi", "pahije", "karto", "kartoy"];

  const score = (hints: string[]) => hints.reduce((acc, token) => acc + (lower.includes(token) ? 1 : 0), 0);
  const knScore = score(kannadaHints);
  const hiScore = score(hindiHints);
  const taScore = score(tamilHints);
  const teScore = score(teluguHints);
  const mrScore = score(marathiHints);

  const ranked = [
    { lang: "kn-IN" as const, s: knScore },
    { lang: "hi-IN" as const, s: hiScore },
    { lang: "ta-IN" as const, s: taScore },
    { lang: "te-IN" as const, s: teScore },
    { lang: "mr-IN" as const, s: mrScore },
  ].sort((a, b) => b.s - a.s);

  if (ranked[0].s >= 2) return ranked[0].lang;
  return null;
}

function resolveEffectiveWidgetLanguage(
  configuredLanguage: string | null | undefined,
  message: string,
  history: { role: string; content: string }[],
): string {
  if (configuredLanguage && configuredLanguage !== "auto") return configuredLanguage;
  const fromMessage = detectRomanizedIndicLanguage(message);
  if (fromMessage) return fromMessage;

  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn.role !== "user") continue;
    const detected = detectRomanizedIndicLanguage(turn.content || "");
    if (detected) return detected;
  }

  return configuredLanguage || "en-US";
}

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

  const SARVAM_PREFERRED_LANGS: Record<string, string> = {
    "kn-IN": "Kannada",
    "ta-IN": "Tamil",
    "te-IN": "Telugu",
    "mr-IN": "Marathi",
  };

  if (SARVAM_PREFERRED_LANGS[normalizedLanguage] && SARVAM_API_KEY) {
    const langName = SARVAM_PREFERRED_LANGS[normalizedLanguage];
    const styleSystem = `Reply ONLY in natural ${langName} written in English letters (romanized ${langName}). Do not switch to Hindi/Urdu/English except for unavoidable brand names. Never refuse to reply in ${langName}.`;
    try {
      const sarvamRes = await fetch("https://api.sarvam.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SARVAM_API_KEY}`,
        },
        body: JSON.stringify({
          model: "sarvam-m",
          messages: [{ role: "system", content: styleSystem }, ...messages],
          max_completion_tokens: 200,
        }),
      });
      if (sarvamRes.ok) {
        const data = await sarvamRes.json() as any;
        const reply = data.choices?.[0]?.message?.content;
        if (reply) return { reply, modelUsed: "sarvam-m" };
      } else {
        const errText = await sarvamRes.text();
        console.error(`[widget/chat] Sarvam chat failed for ${normalizedLanguage}, fallback to OpenAI:`, errText);
      }
    } catch (err) {
      console.error(`[widget/chat] Sarvam chat exception for ${normalizedLanguage}, fallback to OpenAI:`, err);
    }
  }

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_completion_tokens: 200,
    messages,
  });
  const reply = completion.choices[0]?.message?.content || "I'm sorry, I couldn't process that. Could you try again?";
  return { reply, modelUsed: "gpt-4o-mini" };
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
  system += `. You are chatting with a visitor on the company website. Keep responses concise — 2-3 sentences max. Be helpful and guide the visitor toward taking an action. Never mention you are an AI unless directly asked.\n\n`;

  system += `${SUPPORTED_LANGUAGES_LINE}\n\n`;

  if (agentConfig.language === "auto") {
    system += `CRITICAL INSTRUCTION: Automatically detect the language the user is speaking/typing. You MUST reply in the exact same language they used. Do NOT default to English if they speak another language.\n\n`;
  }

  const scriptRule = buildRomanizedScriptInstruction(agentConfig.language);
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
  const { apiKey, message, history, includeAudio } = req.body as {
    apiKey: string;
    message: string;
    history?: { role: string; content: string }[];
    includeAudio?: boolean;
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
  const effectiveLanguage = resolveEffectiveWidgetLanguage(agent.language, message, safeHistory);
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

  console.log(`[widget/chat] lang=${language} model=${modelUsed} tts=${provider ?? "none"} includeAudio=${!!includeAudio}`);

  res.json({ reply, agentName: agent.agentName, language, audio, provider, audioMimeType });
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
  var open = false;
  var listening = false;
  var speaking = false;
  var recognition = null;
  var micBlocked = false;
  var SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var hasSpeechAPI = !!SpeechRecognition;

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

  function speakReply(text) {
    speaking = true;
    fetch(BASE_URL + "/api/widget/tts", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ text: text, language: agentLang, apiKey: API_KEY })
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
    fetch(BASE_URL + "/api/widget/chat", {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({apiKey:API_KEY, message:msg, history:history.slice(-6), includeAudio:isVoice})
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
        if (isVoice) {
          if (res.data.audio) playReplyAudio(res.data.audio, res.data.audioMimeType);
          else speakReply(reply);
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
    recognition.lang = agentLang === "auto" ? "en-IN" : agentLang;
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
      if (nameEl) nameEl.textContent = agentName;
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
