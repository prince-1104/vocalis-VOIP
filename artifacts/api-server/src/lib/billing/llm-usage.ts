import { classifyProviderFailure, estimateTokens, type UsageScope } from "./usage-ledger";

/** Token usage as reported by the provider; null when the response carried none. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

/** Reads an OpenAI-compatible `usage` object (OpenAI, DeepSeek and Sarvam share the shape). */
export function reportedUsage(usage: unknown): LlmUsage | null {
  const u = usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown } | null;
  } | null | undefined;
  if (!u || typeof u.prompt_tokens !== "number") return null;
  return {
    inputTokens: u.prompt_tokens,
    outputTokens: typeof u.completion_tokens === "number" ? u.completion_tokens : 0,
    cachedInputTokens: typeof u.prompt_tokens_details?.cached_tokens === "number" ? u.prompt_tokens_details.cached_tokens : 0,
  };
}

export interface LlmCall {
  provider: string;
  /** Exact provider model id (never the UI alias). */
  model: string;
  usage: LlmUsage | null;
  /** Prompt texts, used only to estimate tokens when the provider reported none. */
  promptTexts: Array<string | null | undefined>;
  outputText?: string | null;
  /** Upper bound on output tokens, used when a request failed without a response. */
  maxOutputTokens?: number;
  failure?: unknown;
  /** The stream was abandoned before the provider reported usage (e.g. caller barge-in). */
  cancelled?: boolean;
  key?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export type LlmCallSink = (call: LlmCall) => void;

/**
 * Records one LLM request. Reported usage is "actual"; otherwise tokens are a
 * conservative estimate (an abandoned or failed request is assumed to have
 * generated its full output allowance). A failure the provider may still bill
 * (server error, timeout, network error, partial stream) is recorded as unknown
 * and left for reconciliation; reported usage is billed despite a failure.
 */
export function recordLlmCall(scope: UsageScope, call: LlmCall): Promise<void> {
  const usage = call.usage;
  const generated = estimateTokens(call.outputText);
  const outcome = call.failure === undefined
    ? "charged"
    : classifyProviderFailure(call.failure, { usageReported: usage != null, outputProduced: generated > 0 });
  const inputTokens = usage?.inputTokens ?? estimateTokens(...call.promptTexts);
  const outputTokens = usage?.outputTokens
    ?? (call.failure !== undefined || call.cancelled ? Math.max(generated, call.maxOutputTokens ?? 0) : generated);
  const metadata = call.cancelled ? { ...(call.metadata ?? {}), cancelled: true } : call.metadata;
  return scope.record({
    key: call.key,
    category: "llm",
    provider: call.provider,
    model: call.model,
    measurement: usage ? "actual" : "estimated",
    unit: "tokens",
    quantity: inputTokens + outputTokens,
    inputTokens,
    outputTokens,
    cachedInputTokens: usage?.cachedInputTokens ?? 0,
    outcome,
    metadata,
  });
}
