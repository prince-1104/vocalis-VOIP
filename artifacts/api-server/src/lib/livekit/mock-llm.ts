import { setTimeout as sleep } from "node:timers/promises";

// Deterministic provider fixture, deliberately not represented as real model inference.
// Word-sized chunks at a fixed pace make streaming behaviour observable; the pace is a
// fixture constant, not a model latency estimate.
export const MOCK_LLM_CHUNK_MS = 20;
const SHORT = "Sure, I can help with that. What would you like to know?";
const LONG = "Your order total is Rs. 1,250.50 and it ships on 12.05.2026. Dr. Rao will call at 3.30 p.m. to confirm the delivery window. "
  + "You can track it at https://dialog.example.com/track?id=4 at any time. Is there anything else I can help you with today?";

export function mockLlmText(messages: { role: string; content: string }[]): string {
  const last = [...messages].reverse().find(m => m.role === "user");
  return last?.content.includes("detailed") ? LONG : SHORT;
}

export async function* mockLlm(messages: { role: string; content: string }[], signal: AbortSignal, chunkMs = MOCK_LLM_CHUNK_MS) {
  for (const part of mockLlmText(messages).match(/\S+\s*/g) ?? []) {
    await sleep(chunkMs, undefined, { signal });
    yield part;
  }
}
