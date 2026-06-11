import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";

// ── Intent Classification ──────────────────────────────────────────────
// Lightweight LLM-based classifier that runs after each AI conversation
// turn. Uses gpt-4o-mini with constrained JSON output (~1-2 tokens latency).
//
// Returns the detected intent + whether the conversation should be
// transferred to a human agent.

export interface IntentResult {
  intent: string;
  confidence: number;
  needsHuman: boolean;
  reasoning?: string;
}

export interface TransferRules {
  intents: string[];              // intents that CAN eventually transfer (AI tries first)
  maxAiTurns?: number;            // global fallback: transfer after N turns if unresolved
  perIntentMaxTurns?: Record<string, number>;  // per-intent: { "pricing_query": 8, "complaint": 5 }
  humanRequestThreshold?: number; // transfer after caller asks for human N times (default: 2)
  transferTo?: string;            // specific phone/SIP to transfer to
  crmAgentId?: string;            // specific CRM agent ID
}

const KNOWN_INTENTS = [
  "greeting",
  "product_inquiry",
  "pricing_query",
  "complaint",
  "technical_support",
  "billing",
  "appointment",
  "interested",
  "not_interested",
  "callback_request",
  "escalation",
  "general_question",
  "follow_up",
  "objection_handling",
] as const;

export async function classifyIntent(
  history: { role: string; content: string }[],
  latestUserMessage: string,
): Promise<IntentResult> {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      max_completion_tokens: 80,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are an intent classifier for sales calls. Analyze the conversation and classify the caller's PRIMARY intent.

Output ONLY valid JSON with these fields:
  {"intent": "<intent_name>", "confidence": <0.0-1.0>, "needsHuman": <true/false>}

Possible intents: ${KNOWN_INTENTS.join(", ")}

Rules for needsHuman:
- true if: complaint, escalation, complex pricing negotiation, billing dispute, technical issue the AI cannot resolve
- false if: general inquiry, greeting, product info, appointment booking, simple pricing question

Be accurate. Confidence should reflect how certain you are.`,
        },
        ...history.slice(-6).map(h => ({ role: h.role as "user" | "assistant", content: h.content })),
        { role: "user" as const, content: latestUserMessage },
      ],
    });

    const raw = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw);

    return {
      intent: parsed.intent || "general_question",
      confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
      needsHuman: parsed.needsHuman === true,
    };
  } catch (err) {
    logger.error({ err }, "Intent classification failed");
    return {
      intent: "general_question",
      confidence: 0.3,
      needsHuman: false,
      reasoning: "Classification failed, defaulting to general",
    };
  }
}

// ── Detect explicit "talk to human" requests ───────────────────────────
// Returns true if the caller is explicitly asking for a human agent.
// This is a lightweight regex check — not an LLM call.
export function detectHumanRequest(userMessage: string): boolean {
  const msg = userMessage.toLowerCase();
  const patterns = [
    /\b(talk|speak|connect)\b.*\b(human|person|agent|real|someone|representative|manager|executive)\b/,
    /\b(transfer|redirect|forward)\b.*\b(call|me)\b/,
    /\b(real|human|live)\b.*\b(agent|person|support)\b/,
    /\blet me (talk|speak) to/,
    /\bagent\s+(please|now|se)\b/,
    /\b(customer\s+)?service\b.*\b(representative|agent)\b/,
    /\bi (want|need) (a |an )?(human|real|live)/,
    /\b(no|stop)\b.*\b(bot|ai|robot|machine)\b/,
    // Hindi patterns
    /\b(insaan|aadmi|vyakti|agent)\s+(se|ko)\s+(baat|connect)\b/,
    /\basli\s+(insaan|agent|aadmi)\b/,
  ];
  return patterns.some(p => p.test(msg));
}

// ── Transfer Decision ──────────────────────────────────────────────────
// AI-first approach: the AI tries to resolve using trained knowledge.
// Transfer only when the AI has exhausted its ability.
export function shouldTransfer(
  intentResult: IntentResult,
  transferRules: TransferRules | null | undefined,
  turnCount: number,
  intentTurnCounts: Record<string, number>,
  humanRequestCount: number,
): { transfer: boolean; reason: string } {
  if (!transferRules) {
    return { transfer: false, reason: "no transfer rules configured" };
  }

  const humanThreshold = transferRules.humanRequestThreshold ?? 2;

  // 1. Caller explicitly asked for human enough times → transfer immediately
  if (humanRequestCount >= humanThreshold) {
    return {
      transfer: true,
      reason: `Caller requested human agent ${humanRequestCount} time(s) (threshold: ${humanThreshold})`,
    };
  }

  // 2. Per-intent max turns exceeded → AI has tried enough for this intent
  if (
    transferRules.intents &&
    transferRules.intents.includes(intentResult.intent) &&
    intentResult.confidence >= 0.7
  ) {
    const intentMax =
      transferRules.perIntentMaxTurns?.[intentResult.intent] ?? undefined;
    const currentIntentTurns = intentTurnCounts[intentResult.intent] || 0;

    if (intentMax !== undefined && currentIntentTurns >= intentMax) {
      return {
        transfer: true,
        reason: `Per-intent max turns (${intentMax}) reached for "${intentResult.intent}" (${currentIntentTurns} turns)`,
      };
    }
  }

  // 3. Classifier says needsHuman with high confidence → transfer
  if (intentResult.needsHuman && intentResult.confidence >= 0.8) {
    return {
      transfer: true,
      reason: `Classifier determined human needed for "${intentResult.intent}" (confidence: ${intentResult.confidence})`,
    };
  }

  // 4. Global max AI turns exceeded → fallback safety net
  if (transferRules.maxAiTurns && turnCount >= transferRules.maxAiTurns) {
    return {
      transfer: true,
      reason: `Max AI turns (${transferRules.maxAiTurns}) reached without resolution`,
    };
  }

  return { transfer: false, reason: "no transfer condition met" };
}
