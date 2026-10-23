import OpenAI from "openai";
import { streamTarget } from "../voice-models";
import { recordUsage } from "../billing/usage-ledger";
import { reportedUsage, recordLlmCall } from "../billing/llm-usage";
import { reserveBudget, releaseReservation } from "../billing/spend-budget";
import { currentRateCard, priceUsage } from "../billing/rate-card";
import { randomUUID } from "node:crypto";
import { VoiceDenied, type VoiceSession, type VoiceSessions } from "./sessions";

/** API-only model transport: keys, system instructions and charging never reach the worker. */
export async function* livekitLlm(sessions: VoiceSessions, session: VoiceSession,
  history: { role: "user" | "assistant"; content: string }[], signal: AbortSignal) {
  const cfg = (await sessions.pool.query("select * from agent_configs where user_id=$1 limit 1", [session.owner_id])).rows[0];
  if (!cfg) throw new VoiceDenied(503);
  const target = streamTarget(cfg.ai_model);
  const key = target.provider === "deepseek" ? process.env.DEEPSEEK_API_KEY : target.provider === "sarvam" ? process.env.SARVAM_API_KEY : process.env.OPENAI_API_KEY;
  if (!key) throw new VoiceDenied(503);
  const [scripts, knowledge, rateCard] = await Promise.all([
    sessions.pool.query("select full_script from calling_scripts where user_id=$1 order by is_default desc,updated_at desc limit 1", [session.owner_id]),
    sessions.pool.query("select content from training_data where user_id=$1 order by id limit 8", [session.owner_id]),
    currentRateCard(),
  ]);
  const instructions = `You are ${cfg.agent_name}. Use a ${cfg.personality} tone and respond in ${cfg.language}. Keep replies under two sentences.\n${scripts.rows[0]?.full_script ?? ""}\n${knowledge.rows.map(r => r.content.slice(0, 2000)).join("\n")}`;
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [{ role: "system", content: instructions }, ...history];
  const inputTokens = Math.ceil((instructions.length + history.reduce((n, m) => n + m.content.length, 0)) / 2);
  const price = priceUsage(rateCard.rates, { category: "llm", provider: target.provider, model: target.model, unit: "tokens", quantity: inputTokens + 200, inputTokens, outputTokens: 200 });
  if (!price.priced) throw new VoiceDenied(503);
  const operation = randomUUID(), usageKey = `livekit:${session.id}:llm:${operation}`;
  const reservation = await reserveBudget({ userId: session.owner_id, key: usageKey, amount: price.cost, source: "livekit-llm", ttlMs: 180000 });
  const base = { userId: session.owner_id, sessionRef: session.id, source: "livekit", idempotencyKey: usageKey };
  await recordUsage({ ...base, category: "llm", provider: target.provider, model: target.model,
    unit: "tokens", measurement: "unknown", quantity: null, outcome: "unknown", provisionalAmount: price.cost });
  await releaseReservation(reservation.tenantId, reservation.key, "livekit_usage_recorded");
  let usage: unknown, output = "", finished = false, failure: unknown;
  const client = new OpenAI({ apiKey: key, baseURL: target.provider === "deepseek" ? "https://api.deepseek.com/v1" : target.provider === "sarvam" ? "https://api.sarvam.ai/v1" : "https://api.openai.com/v1", maxRetries: 0, timeout: 8000 });
  try {
    signal.throwIfAborted();
    const stream = await client.chat.completions.create({ model: target.model, messages, max_tokens: 200, stream: true,
      ...(target.provider === "sarvam" ? {} : { stream_options: { include_usage: true } }) }, { signal });
    for await (const part of stream) {
      if (part.usage) usage = part.usage;
      signal.throwIfAborted();
      const text = part.choices[0]?.delta?.content;
      if (text) { output += text; yield text; }
    }
    finished = true;
  } catch (e) { failure = e; throw new VoiceDenied(503); }
  finally {
    await recordLlmCall({ record: async part => { const { key: _key, ...record } = part; await recordUsage({ ...record, ...base }); }, flush: async () => {} }, {
      ...target, usage: reportedUsage(usage), promptTexts: [instructions, ...history.map(m => m.content)], outputText: output,
      maxOutputTokens: 200, failure, cancelled: !finished,
    });
  }
}
