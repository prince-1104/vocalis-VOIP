import { openai } from "@workspace/integrations-openai-ai-server";
import { logger } from "./logger";

// ── Intent Classification ──────────────────────────────────────────────
// Hybrid classifier: fast regex/keyword patterns first (~0ms), LLM fallback
// only when patterns are ambiguous AND transfer rules are configured.
//
// This eliminates the 600–1200ms LLM round-trip that was blocking every
// single voice turn. The LLM is only invoked when it actually matters
// (e.g. a transfer decision is pending and pattern confidence is low).

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

// ── Fast pattern-based classifier ─────────────────────────────────────
// Returns { intent, confidence } in ~0ms. confidence < 0.65 = ambiguous.
interface PatternRule {
  intent: string;
  needsHuman: boolean;
  confidence: number;
  patterns: RegExp[];
}

const INTENT_PATTERNS: PatternRule[] = [
  {
    intent: "greeting",
    needsHuman: false,
    confidence: 0.95,
    patterns: [
      /^\s*(hi|hello|hey|good\s*(morning|afternoon|evening)|namaste|namaskar|vanakkam|namaskara)\b/i,
      /\b(who are you|what's your name|introduce yourself)\b/i,
    ],
  },
  {
    intent: "not_interested",
    needsHuman: false,
    confidence: 0.90,
    patterns: [
      /\b(not interested|no thanks|don't (need|want)|not (now|today)|busy right now|call (me )?(back )?later|remove (me|my number)|do not call)\b/i,
      /\b(nahi chahiye|nahi chahie|nahin chahiye|mujhe nahi chahiye|abhi nahi)\b/i,
    ],
  },
  {
    intent: "interested",
    needsHuman: false,
    confidence: 0.85,
    patterns: [
      /\b(interested|tell me more|sounds good|yes please|i want|i'd like|i would like|sign me up|how (do|can) i (get|buy|order|purchase|apply))\b/i,
      /\b(haan|ha |chahiye|mujhe chahiye|batao|bataiye)\b/i,
    ],
  },
  {
    intent: "pricing_query",
    needsHuman: false,
    confidence: 0.88,
    patterns: [
      /\b(price|pricing|cost|fee|charge|how much|rate|plan|package|tariff|quote|estimate)\b/i,
      /\b(kitna (lagta|hai|hoga)|daam|keemat|rate kya hai)\b/i,
    ],
  },
  {
    intent: "complaint",
    needsHuman: true,
    confidence: 0.87,
    patterns: [
      /\b(complain|complaint|issue|problem|not working|broken|wrong|unhappy|disappointed|terrible|worst|horrible|rude|cheated|fraud|scam|pathetic)\b/i,
      /\b(bahut bura|shikayat|problem hai|kaam nahi kar raha|theek nahi)\b/i,
    ],
  },
  {
    intent: "technical_support",
    needsHuman: true,
    confidence: 0.85,
    patterns: [
      /\b(technical|tech support|not (working|loading|connecting|opening)|error|bug|crash|reset|broken|setup|install|configure)\b/i,
      /\b(technical problem|app nahi chal raha|error aa raha)\b/i,
    ],
  },
  {
    intent: "billing",
    needsHuman: true,
    confidence: 0.88,
    patterns: [
      /\b(bill|billing|invoice|payment|overcharged|refund|charge|deducted|statement|account balance|due (amount|date)|emi)\b/i,
      /\b(bill aaya|payment hua|refund chahiye|paisa kata)\b/i,
    ],
  },
  {
    intent: "appointment",
    needsHuman: false,
    confidence: 0.88,
    patterns: [
      /\b(appointment|schedule|book(ing)?|meeting|visit|demo|callback|call (me )?back|when (can|will)|available (date|time|slot))\b/i,
      /\b(appointment chahiye|milna hai|schedule karo|callback do)\b/i,
    ],
  },
  {
    intent: "callback_request",
    needsHuman: false,
    confidence: 0.90,
    patterns: [
      /\b(call (me )?back|call again (later|tomorrow)|ring me|try again later|not a good time)\b/i,
      /\b(baad mein call karo|phir call karna|abhi baat nahi kar sakta)\b/i,
    ],
  },
  {
    intent: "escalation",
    needsHuman: true,
    confidence: 0.90,
    patterns: [
      /\b(manager|supervisor|senior|escalate|higher authority|your boss|in charge|head of|CEO|owner)\b/i,
      /\b(manager se baat|supervisor bulao|upar se baat)\b/i,
    ],
  },
  {
    intent: "product_inquiry",
    needsHuman: false,
    confidence: 0.80,
    patterns: [
      /\b(what (is|are|does)|how does (it|this) work|tell me about|features?|details?|specifications?|benefits?|advantages?|difference between|compare|which (one|product)|do you (have|offer|provide|sell))\b/i,
      /\b(kya hai|kaise kaam karta|batao|product ke baare mein|features kya hain)\b/i,
    ],
  },
  {
    intent: "objection_handling",
    needsHuman: false,
    confidence: 0.78,
    patterns: [
      /\b(too expensive|can't afford|don't have (time|budget|money)|already have|using (another|different|competitor)|not sure|think about it|need to (check|consult|discuss)|maybe later)\b/i,
      /\b(bahut mahanga|nahi afford kar sakta|already hai|sochna hai|baad mein decide karunga)\b/i,
    ],
  },
  {
    intent: "follow_up",
    needsHuman: false,
    confidence: 0.80,
    patterns: [
      /\b(follow(ing)? up|any (update|news|progress)|what happened|status (of|update)|did you|have you|checked yet|any response)\b/i,
      /\b(follow up|koi update|kya hua|status kya hai|kuch pata chala)\b/i,
    ],
  },
];

function classifyByPatterns(message: string): IntentResult | null {
  const msg = message.toLowerCase();
  let bestMatch: { rule: PatternRule; confidence: number } | null = null;

  for (const rule of INTENT_PATTERNS) {
    if (rule.patterns.some(p => p.test(msg))) {
      if (!bestMatch || rule.confidence > bestMatch.confidence) {
        bestMatch = { rule, confidence: rule.confidence };
      }
    }
  }

  if (!bestMatch) return null;

  return {
    intent: bestMatch.rule.intent,
    confidence: bestMatch.confidence,
    needsHuman: bestMatch.rule.needsHuman,
    reasoning: "pattern-match",
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage = "Operation timed out"): Promise<T> {
  let timeoutId: NodeJS.Timeout;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

// ── LLM-based fallback classifier ────────────────────────────────────
async function classifyByLLM(
  history: { role: string; content: string }[],
  latestUserMessage: string,
): Promise<IntentResult> {
  const completionPromise = openai.chat.completions.create({
    model: "gpt-4o-mini",
    max_completion_tokens: 60,
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You are an intent classifier for sales calls. Classify the caller's PRIMARY intent.

Output ONLY valid JSON: {"intent": "<intent_name>", "confidence": <0.0-1.0>, "needsHuman": <true/false>}

Possible intents: ${KNOWN_INTENTS.join(", ")}

needsHuman=true for: complaint, escalation, complex billing dispute, unresolvable technical issue.
needsHuman=false for: inquiry, greeting, pricing question, appointment, objection handling.`,
      },
      ...history.slice(-4).map(h => ({ role: h.role as "user" | "assistant", content: h.content })),
      { role: "user" as const, content: latestUserMessage },
    ],
  });

  const response = await withTimeout(completionPromise, 1000, "LLM classification timeout");

  const raw = response.choices[0]?.message?.content || "{}";
  const parsed = JSON.parse(raw);
  return {
    intent: parsed.intent || "general_question",
    confidence: Math.min(1, Math.max(0, parsed.confidence || 0.5)),
    needsHuman: parsed.needsHuman === true,
  };
}

// ── Public API ────────────────────────────────────────────────────────
// useLLMFallback: pass true only when transfer rules are configured and
// the intent matters for a transfer decision. Defaults to false so the
// normal voice turn doesn't pay the LLM latency penalty.
export async function classifyIntent(
  history: { role: string; content: string }[],
  latestUserMessage: string,
  useLLMFallback = false,
): Promise<IntentResult> {
  // 1. Try fast pattern matching first (~0ms)
  try {
    const patternResult = classifyByPatterns(latestUserMessage);
    if (patternResult && patternResult.confidence >= 0.75) {
      return patternResult;
    }

    // 2. If confidence is low and caller hasn't explicitly changed topics,
    //    check recent history for a sticky intent
    if (history.length >= 2) {
      const lastUserMsg = history.filter(h => h.role === "user").slice(-1)[0]?.content || "";
      const historyResult = classifyByPatterns(lastUserMsg);
      if (historyResult && historyResult.confidence >= 0.80) {
        // Current message is ambiguous but last turn had a clear intent — keep it
        return { ...historyResult, confidence: historyResult.confidence * 0.85, reasoning: "history-sticky" };
      }
    }

    // 3. LLM fallback — only when caller explicitly enabled AND pattern was uncertain
    if (useLLMFallback) {
      return await classifyByLLM(history, latestUserMessage);
    }

    // 4. Pattern result (even low confidence) or safe default
    return patternResult ?? {
      intent: "general_question",
      confidence: 0.5,
      needsHuman: false,
      reasoning: "no-pattern-match",
    };
  } catch (err) {
    logger.error({ err }, "Intent classification failed");
    return {
      intent: "general_question",
      confidence: 0.3,
      needsHuman: false,
      reasoning: "classification-error",
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
