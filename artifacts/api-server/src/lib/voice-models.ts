/** Transport-independent aliases shared with the existing Twilio pipeline. */
export function streamTarget(aiModel: string): { provider: "openai" | "deepseek" | "sarvam"; model: string } {
  if (aiModel === "deepseek-chat" || aiModel === "deepseek-v3") return { provider: "deepseek", model: "deepseek-chat" };
  if (aiModel === "sarvam-m" || aiModel === "sarvam-1-2b") return { provider: "sarvam", model: "sarvam-m" };
  return { provider: "openai", model: ({ "gpt-4o-mini": "gpt-4o-mini", "gpt-4o": "gpt-4o", "gpt-5.2": "gpt-4o",
    "gemini-1.5-pro": "gpt-4o-mini", "llama-3.3-8b-private": "gpt-4o-mini", bharatgpt: "gpt-4o-mini", "bolna-ai": "gpt-4o-mini" } as Record<string, string>)[aiModel] ?? "gpt-4o-mini" };
}
export const BULBUL_VOICE_FOR_LANG: Record<string, string> = {
  "hi-IN": "kavya", "kn-IN": "manan", "ta-IN": "priya", "te-IN": "pooja", "mr-IN": "simran",
};
// Only this verified intersection is admitted, rather than assuming all Sarvam languages
// are supported by Nova-3. Extend it after validating the selected provider model.
export function livekitVoice(language: string): { speaker: string; sttLanguage: string; ttsLanguage: string } {
  if (!["en-US", "en-IN", "hi-IN", "ta-IN"].includes(language)) throw new Error("Unsupported voice configuration");
  return { speaker: BULBUL_VOICE_FOR_LANG[language] ?? "manan", sttLanguage: language.startsWith("en") ? language : language.split("-")[0], ttsLanguage: language === "en-US" ? "en-IN" : language };
}
