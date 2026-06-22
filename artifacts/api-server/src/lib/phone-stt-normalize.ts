/**
 * Correct common phone-STT mishears on short caller utterances.
 * Whisper often transcribes "yes" as "bye", "it", or "bee" on 8 kHz telephony audio.
 */

const YES_NO_QUESTION =
  /\b(is this|good time|would you|can i|may i|shall i|do you have (a |the )?minute|speak (for|with)|are you (free|available)|okay to|ok to|interested|can we talk|mind if)\b/i;

const AFFIRMATIVE_STANDALONE =
  /^\s*(yes|yeah|yep|yup|sure|ok|okay|correct|right|absolutely|of course|go ahead|please do)\.?\s*$/i;

const BYE_MISHEAR = /^\s*(bye|by|bee|be)\.?\s*$/i;
const IT_MISHEAR = /^\s*it\.?\s*$/i;

function lastAssistantLine(history: { role: string; content: string }[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === "assistant") return history[i].content;
  }
  return "";
}

function agentExpectsYesNo(history: { role: string; content: string }[], openingGreeting?: string): boolean {
  const last = lastAssistantLine(history) || openingGreeting || "";
  return YES_NO_QUESTION.test(last);
}

export function buildWhisperPrompt(
  history: { role: string; content: string }[],
  openingGreeting?: string,
): string {
  const lastAgent = lastAssistantLine(history) || openingGreeting || "";
  const snippet = lastAgent.slice(0, 120).replace(/\s+/g, " ").trim();
  return (
    `Phone sales call. Caller short replies: yes, no, sure, okay, hello, not interested, goodbye. ` +
    (snippet ? `Agent: ${snippet}` : "")
  ).slice(0, 220);
}

export function normalizePhoneTranscript(
  transcript: string,
  history: { role: string; content: string }[],
  openingGreeting?: string,
): string {
  const trimmed = transcript.trim();
  if (!trimmed) return transcript;

  const userTurns = history.filter(h => h.role === "user").length;
  const earlyCall = userTurns === 0;
  const expectsYesNo = agentExpectsYesNo(history, openingGreeting);

  if (BYE_MISHEAR.test(trimmed) && (expectsYesNo || earlyCall)) {
    return "Yes.";
  }

  if (IT_MISHEAR.test(trimmed) && expectsYesNo) {
    return "Yes.";
  }

  if (AFFIRMATIVE_STANDALONE.test(trimmed)) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).replace(/\.$/, "") + ".";
  }

  return transcript;
}
