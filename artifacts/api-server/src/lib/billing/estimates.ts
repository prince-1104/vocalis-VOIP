import { db, agentConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { currentRateCard, priceUsage, roundMoney, sttRateKey, telephonyRateKey, ttsRateKey } from "./rate-card";

// Reservation sizing only. Holds are upper-bound estimates that are released
// once the ledger records what was actually used. A component without a rate
// contributes nothing to the hold (the request is still gated on the limit).

/** Initial call hold horizon when the agent has no configured maximum (minutes). */
export const DEFAULT_CALL_HOLD_MINUTES = 10;
export const MAX_CALL_HOLD_MINUTES = 60;
/** Characters of speech generated per output token, rounded up. */
const CHARS_PER_OUTPUT_TOKEN = 4;

import type { Connection } from "./connection";

export async function callHoldMinutes(userId: number, connection: Connection = db): Promise<number> {
  const agent = await connection.query.agentConfigsTable.findFirst({ where: eq(agentConfigsTable.userId, userId) });
  const configured = Number(agent?.maxCallDuration ?? DEFAULT_CALL_HOLD_MINUTES);
  return Math.min(MAX_CALL_HOLD_MINUTES, Math.max(1, Number.isFinite(configured) ? configured : DEFAULT_CALL_HOLD_MINUTES));
}

export async function telephonyHold(provider: string, leg: string, minutes: number, connection: Connection = db): Promise<number> {
  const { rates } = await currentRateCard(connection);
  const rate = rates[telephonyRateKey(provider, leg)];
  return rate == null ? 0 : roundMoney(Math.max(0, minutes) * rate);
}

export interface AiWorkEstimate {
  /** Candidate LLM models; the most expensive configured one is used. */
  llmModels?: string[];
  inputTokens?: number;
  maxOutputTokens?: number;
  /** Additional small LLM calls (classifiers, rewrites) at the same rates. */
  extraLlmCalls?: number;
  ttsProviders?: string[];
  ttsCharacters?: number;
  sttProvider?: string;
  sttSeconds?: number;
}

export async function aiWorkHold(estimate: AiWorkEstimate, connection: Connection = db): Promise<number> {
  const { rates } = await currentRateCard(connection);
  let total = 0;
  const input = Math.max(0, estimate.inputTokens ?? 0);
  const output = Math.max(0, estimate.maxOutputTokens ?? 0);
  if (estimate.llmModels?.length) {
    const costs = estimate.llmModels.map((model) => {
      const price = priceUsage(rates, { category: "llm", provider: "", model, unit: "tokens", quantity: input + output, inputTokens: input, outputTokens: output });
      return price.priced ? price.cost : 0;
    });
    total += Math.max(...costs) * (1 + Math.max(0, estimate.extraLlmCalls ?? 0));
  }
  const ttsChars = estimate.ttsCharacters ?? output * CHARS_PER_OUTPUT_TOKEN;
  if (estimate.ttsProviders?.length && ttsChars > 0) {
    total += Math.max(...estimate.ttsProviders.map((provider) => {
      const rate = rates[ttsRateKey(provider)];
      return rate == null ? 0 : (ttsChars * rate) / 1_000_000;
    }));
  }
  if (estimate.sttProvider && estimate.sttSeconds) {
    const rate = rates[sttRateKey(estimate.sttProvider)];
    if (rate != null) total += (estimate.sttSeconds / 60) * rate;
  }
  return roundMoney(total);
}
