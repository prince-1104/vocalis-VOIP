import { Router, type IRouter } from "express";
import { db, callLogsTable, contactsTable } from "@workspace/db";
import { eq, and, sql, desc } from "drizzle-orm";

const router: IRouter = Router();

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini":   { input: 0.15,  output: 0.60 },
  "gpt-4o":        { input: 2.50,  output: 10.00 },
  "gpt-5.2":       { input: 15.00, output: 60.00 },
  "deepseek-v3":   { input: 0.27,  output: 1.10 },
  "deepseek-chat": { input: 0.27,  output: 1.10 },
  "sarvam-1-2b":   { input: 0.10,  output: 0.30 },
  "sarvam-m":      { input: 0.10,  output: 0.30 },
};

// All Indic-flow models use Sarvam Bulbul TTS regardless of LLM provider.
// Note: this fallback estimator infers provider from aiModel, but runtime routing is
// language-driven. Legacy rows with an OpenAI aiModel but an Indian language may be
// understated. Primary billing is set at call-end by /twilio/status (language-aware).
const INDIC_MODEL_NAMES = new Set(["sarvam-1-2b", "sarvam-m", "deepseek-v3", "deepseek-chat"]);
const SARVAM_TTS_COST_PER_1K_CHARS = 0.006;
const SARVAM_TTS_ESTIMATED_CHARS_PER_TURN = 200;

function estimateCost(durationSecs: number | null, direction: string, model: string | null) {
  if (!durationSecs || durationSecs <= 0) return null;
  const minutes = Math.max(1, Math.ceil(durationSecs / 60));
  const twilioBaseRate = direction === "outbound" ? 0.013 : 0.022;
  const twilioCost = minutes * (twilioBaseRate + 0.04);
  const turns = Math.max(1, Math.round(durationSecs / 25));
  const resolvedModel = model || "gpt-4o-mini";
  const pricing = MODEL_PRICING[resolvedModel] || MODEL_PRICING["gpt-4o-mini"];
  let llmCost = (turns * 400 * pricing.input + turns * 50 * pricing.output) / 1_000_000;
  if (INDIC_MODEL_NAMES.has(resolvedModel)) {
    // Add Sarvam TTS cost: all Indic flows invoke Sarvam Bulbul TTS for output speech
    llmCost += (turns * SARVAM_TTS_ESTIMATED_CHARS_PER_TURN * SARVAM_TTS_COST_PER_1K_CHARS) / 1_000;
  }
  return {
    twilioCost: parseFloat(twilioCost.toFixed(6)),
    llmCost: parseFloat(llmCost.toFixed(6)),
    totalCost: parseFloat((twilioCost + llmCost).toFixed(6)),
    twilioMinutes: minutes,
  };
}

router.get("/calls", async (req, res) => {
  const userId = req.userId!;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = (page - 1) * limit;
  const campaignId = req.query.campaignId ? parseInt(req.query.campaignId as string) : undefined;
  const outcome = req.query.outcome as string;

  const conditions: any[] = [eq(callLogsTable.userId, userId)];
  if (campaignId) conditions.push(eq(callLogsTable.campaignId, campaignId));
  if (outcome) conditions.push(eq(callLogsTable.outcome, outcome));

  const where = and(...conditions);

  const [calls, countResult] = await Promise.all([
    db.select().from(callLogsTable).where(where).limit(limit).offset(offset).orderBy(desc(callLogsTable.startedAt)),
    db.select({ count: sql<number>`count(*)` }).from(callLogsTable).where(where),
  ]);

  const callsWithContacts = await Promise.all(calls.map(async (call) => {
    let contact = null;
    if (call.contactId) {
      contact = await db.query.contactsTable.findFirst({ where: eq(contactsTable.id, call.contactId) });
    }

    const storedCost = call.estimatedCostUsd ? parseFloat(call.estimatedCostUsd) : null;
    const computed = (!storedCost && call.duration) ? estimateCost(call.duration, call.direction, call.aiModel) : null;

    const displayName = contact
      ? [contact.firstName, contact.lastName].filter(Boolean).join(" ") || contact.phone
      : call.phone;

    return {
      ...call,
      contact,
      displayName,
      estimatedCostUsd: storedCost ? call.estimatedCostUsd : (computed ? computed.totalCost.toString() : null),
      twilioCostUsd: call.twilioCostUsd || (computed ? computed.twilioCost.toString() : null),
      openaiCostUsd: call.openaiCostUsd || (computed ? computed.llmCost.toString() : null),
      twilioMinutes: call.twilioMinutes || computed?.twilioMinutes || null,
      costIsEstimated: !storedCost && !!computed,
    };
  }));

  res.json({ calls: callsWithContacts, total: Number(countResult[0]?.count || 0), page, limit });
});

router.get("/calls/:id", async (req, res) => {
  const userId = req.userId!;
  const call = await db.query.callLogsTable.findFirst({
    where: and(eq(callLogsTable.id, parseInt(req.params.id)), eq(callLogsTable.userId, userId)),
  });
  if (!call) { res.status(404).json({ error: "Call not found" }); return; }

  let contact = null;
  if (call.contactId) {
    contact = await db.query.contactsTable.findFirst({ where: eq(contactsTable.id, call.contactId) });
  }
  res.json({ ...call, contact });
});

export default router;
