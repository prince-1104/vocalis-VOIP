export interface LanguageMenuOption {
  digit: string;
  language: string;
  label: string;
}

export interface LanguageMenuConfig {
  enabled: boolean;
  promptText?: string | null;
  options: LanguageMenuOption[];
  timeoutSeconds: number;
  defaultLanguage: string;
}

export const DEFAULT_LANGUAGE_MENU: LanguageMenuConfig = {
  enabled: false,
  promptText: null,
  options: [
    { digit: "1", language: "hi-IN", label: "Hindi" },
    { digit: "2", language: "en-US", label: "English" },
    { digit: "3", language: "auto", label: "Other languages" },
  ],
  timeoutSeconds: 12,
  defaultLanguage: "en-US",
};

export const GREETING_BY_LANGUAGE: Record<string, string> = {
  "hi-IN": "नमस्ते, धन्यवाद कॉल करने के लिए। मैं आपकी कैसे मदद कर सकता हूँ?",
  "en-US": "Hi, thank you for calling. How can I help you today?",
  "kn-IN": "ನಮಸ್ಕಾರ, ಕರೆ ಮಾಡಿದ್ದಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?",
  "ta-IN": "வணக்கம், அழைத்ததற்கு நன்றி. நான் உங்களுக்கு எப்படி உதவ முடியும்?",
  "te-IN": "నమస్కారం, కాల్ చేసినందుకు ధన్యవాదాలు. నేను మీకు ఎలా సహాయం చేయగలను?",
  "mr-IN": "नमस्कार, कॉल केल्याबद्दल धन्यवाद. मी तुम्हाला कशी मदत करू शकतो?",
};

export function parseLanguageMenuConfig(raw: unknown): LanguageMenuConfig {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_LANGUAGE_MENU };
  }
  const obj = raw as Partial<LanguageMenuConfig>;
  const options = Array.isArray(obj.options) && obj.options.length > 0
    ? obj.options.filter(o => o?.digit && o?.language)
    : DEFAULT_LANGUAGE_MENU.options;

  return {
    enabled: obj.enabled === true,
    promptText: obj.promptText ?? null,
    options,
    timeoutSeconds: typeof obj.timeoutSeconds === "number" && obj.timeoutSeconds > 0
      ? Math.min(obj.timeoutSeconds, 30)
      : DEFAULT_LANGUAGE_MENU.timeoutSeconds,
    defaultLanguage: obj.defaultLanguage || DEFAULT_LANGUAGE_MENU.defaultLanguage,
  };
}

export function getActiveLanguageMenu(agentConfig: { language?: string | null; languageMenuConfig?: unknown }): LanguageMenuConfig | null {
  if ((agentConfig.language || "en-US") !== "auto") return null;
  const config = parseLanguageMenuConfig(agentConfig.languageMenuConfig);
  return config.enabled ? config : null;
}

export function buildLanguageMenuPrompt(config: LanguageMenuConfig): string {
  if (config.promptText?.trim()) return config.promptText.trim();

  const optionText = config.options
    .map(o => `Press ${o.digit} for ${o.label}`)
    .join(". ");

  return (
    `Welcome. Please choose your language. ` +
    `Hindi ke liye ${config.options.find(o => o.language === "hi-IN")?.digit ?? "1"} dabayein. ` +
    `For English press ${config.options.find(o => o.language === "en-US")?.digit ?? "2"}. ` +
    `For other languages press ${config.options.find(o => o.language === "auto")?.digit ?? "3"}. ` +
    optionText + "."
  );
}

export function resolveLanguageFromDigit(config: LanguageMenuConfig, digit: string): string | null {
  const option = config.options.find(o => o.digit === digit);
  return option?.language ?? null;
}

/** Locked language for the call: concrete locale or "auto" for per-turn detection. */
export function resolveCallLanguage(
  configuredLang: string,
  lockedLang: string | null,
  detectedLang?: string,
): string {
  if (lockedLang === "auto") {
    return detectedLang || configuredLang;
  }
  if (lockedLang) return lockedLang;
  if (configuredLang !== "auto") return configuredLang;
  return detectedLang || "en-US";
}

export function shouldAutoDetectLanguage(configuredLang: string, lockedLang: string | null): boolean {
  if (lockedLang && lockedLang !== "auto") return false;
  if (lockedLang === "auto") return true;
  return configuredLang === "auto";
}

export function greetingForLanguage(
  lang: string,
  scriptOpening?: string | null,
  agentGreeting?: string | null,
): string {
  if (lang !== "auto" && GREETING_BY_LANGUAGE[lang]) {
    return GREETING_BY_LANGUAGE[lang];
  }
  return scriptOpening || agentGreeting || GREETING_BY_LANGUAGE["en-US"];
}
