import { db, apiCostLogsTable, tenantLimitsTable, tenantsTable, tenantUsersTable, platformSettingsTable, DEFAULT_API_RATES } from "@workspace/db";
import { eq, and, gte, sql } from "drizzle-orm";

// ── Cached API rates (refreshed every 5 min) ────────────────────────────
let cachedRates: Record<string, number> | null = null;
let ratesCachedAt = 0;
const RATES_CACHE_TTL = 5 * 60 * 1000;

async function getApiRates(): Promise<Record<string, number>> {
  if (cachedRates && Date.now() - ratesCachedAt < RATES_CACHE_TTL) return cachedRates;
  const rows = await db.select().from(platformSettingsTable);
  const rates = { ...DEFAULT_API_RATES };
  for (const row of rows) {
    if (row.key.startsWith("rate:")) {
      const rateKey = row.key.slice(5); // strip "rate:" prefix
      const val = parseFloat(row.value);
      if (!isNaN(val)) rates[rateKey] = val;
    }
  }
  cachedRates = rates;
  ratesCachedAt = Date.now();
  return rates;
}

// ── Cost computation ─────────────────────────────────────────────────────

function computeLLMCost(
  provider: string,
  inputTokens: number,
  outputTokens: number,
  rates: Record<string, number>,
): number {
  const inputRate = rates[`llm:${provider}:input`] ?? 0;
  const outputRate = rates[`llm:${provider}:output`] ?? 0;
  return (inputTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * outputRate;
}

function computeTTSCost(
  provider: string,
  characters: number,
  rates: Record<string, number>,
): number {
  const rate = rates[`tts:${provider}`] ?? 0;
  return (characters / 1_000_000) * rate;
}

function computeSTTCost(
  minutes: number,
  rates: Record<string, number>,
): number {
  const rate = rates["stt:whisper"] ?? 0;
  return minutes * rate;
}

// ── Public API for logging costs ─────────────────────────────────────────

interface LogLLMCostParams {
  tenantId: number;
  userId: number;
  provider: string; // gpt-4o-mini | deepseek-chat | sarvam-m
  inputTokens: number;
  outputTokens: number;
  context?: string;
}

export async function logLLMCost(params: LogLLMCostParams): Promise<void> {
  try {
    const rates = await getApiRates();
    const cost = computeLLMCost(params.provider, params.inputTokens, params.outputTokens, rates);
    await db.insert(apiCostLogsTable).values({
      tenantId: params.tenantId,
      userId: params.userId,
      apiProvider: `llm:${params.provider}`,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      costUsd: cost.toFixed(8),
      context: params.context ?? "chat",
    });
  } catch (err) {
    console.error("[cost-logger] logLLMCost error:", err);
  }
}

interface LogTTSCostParams {
  tenantId: number;
  userId: number;
  provider: string; // sarvam | openai
  characters: number;
  context?: string;
}

export async function logTTSCost(params: LogTTSCostParams): Promise<void> {
  try {
    const rates = await getApiRates();
    const cost = computeTTSCost(params.provider, params.characters, rates);
    await db.insert(apiCostLogsTable).values({
      tenantId: params.tenantId,
      userId: params.userId,
      apiProvider: `tts:${params.provider}`,
      characters: params.characters,
      costUsd: cost.toFixed(8),
      context: params.context ?? "tts",
    });
  } catch (err) {
    console.error("[cost-logger] logTTSCost error:", err);
  }
}

interface LogSTTCostParams {
  tenantId: number;
  userId: number;
  minutes: number;
  context?: string;
}

export async function logSTTCost(params: LogSTTCostParams): Promise<void> {
  try {
    const rates = await getApiRates();
    const cost = computeSTTCost(params.minutes, rates);
    await db.insert(apiCostLogsTable).values({
      tenantId: params.tenantId,
      userId: params.userId,
      apiProvider: "stt:whisper",
      minutes: params.minutes,
      costUsd: cost.toFixed(8),
      context: params.context ?? "stt",
    });
  } catch (err) {
    console.error("[cost-logger] logSTTCost error:", err);
  }
}

// ── Tenant limit checking ────────────────────────────────────────────────

function getMonthStart(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function getCurrentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export interface TenantCostSummary {
  tenantId: number;
  totalCostUsd: number;
  monthlyLimitUsd: number;
  hardLimit: boolean;
  usagePercent: number;
  status: "ok" | "warning" | "over_limit";
  limitAlertSentAt: Date | null;
}

export async function getTenantMonthCost(tenantId: number): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(cost_usd::numeric), 0)` })
    .from(apiCostLogsTable)
    .where(and(eq(apiCostLogsTable.tenantId, tenantId), gte(apiCostLogsTable.createdAt, getMonthStart())));
  return parseFloat(row?.total ?? "0");
}

export async function getTenantCostSummary(tenantId: number): Promise<TenantCostSummary> {
  const [costRow] = await db
    .select({ total: sql<string>`coalesce(sum(cost_usd::numeric), 0)` })
    .from(apiCostLogsTable)
    .where(and(eq(apiCostLogsTable.tenantId, tenantId), gte(apiCostLogsTable.createdAt, getMonthStart())));
  const totalCostUsd = parseFloat(costRow?.total ?? "0");

  const limit = await db.query.tenantLimitsTable.findFirst({
    where: eq(tenantLimitsTable.tenantId, tenantId),
  });

  const monthlyLimitUsd = parseFloat(limit?.monthlyLimitUsd?.toString() ?? "5.00");
  const hardLimit = limit?.hardLimit ?? false;
  const usagePercent = monthlyLimitUsd > 0 ? (totalCostUsd / monthlyLimitUsd) * 100 : 0;
  const status: "ok" | "warning" | "over_limit" =
    usagePercent >= 100 ? "over_limit" : usagePercent >= 80 ? "warning" : "ok";

  return {
    tenantId,
    totalCostUsd,
    monthlyLimitUsd,
    hardLimit,
    usagePercent,
    status,
    limitAlertSentAt: limit?.limitAlertSentAt ?? null,
  };
}

// Check if a tenant has exceeded their hard limit (used to block API calls)
export async function isTenantOverHardLimit(tenantId: number): Promise<boolean> {
  const limit = await db.query.tenantLimitsTable.findFirst({
    where: eq(tenantLimitsTable.tenantId, tenantId),
  });
  if (!limit || !limit.hardLimit) return false;
  const cost = await getTenantMonthCost(tenantId);
  const cap = parseFloat(limit.monthlyLimitUsd?.toString() ?? "5.00");
  return cost >= cap;
}

// ── Resolve tenantId for a widget API key (cached) ───────────────────────
// Widget requests don't carry a tenantId — we resolve it from the agent's
// ownerId → tenant mapping. This is used by the cost logging hooks in the
// widget router.
const ownerTenantCache = new Map<number, { tenantId: number; cachedAt: number }>();
const OWNER_TENANT_CACHE_TTL = 5 * 60 * 1000;

export async function resolveTenantIdForOwner(userId: number): Promise<number | null> {
  const cached = ownerTenantCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < OWNER_TENANT_CACHE_TTL) return cached.tenantId;
  
  let tenantId: number | null = null;
  const tenant = await db.query.tenantsTable.findFirst({
    where: eq(tenantsTable.ownerId, userId),
  });
  
  if (tenant) {
    tenantId = tenant.id;
  } else {
    // Check if the user is part of a tenant
    const tenantUser = await db.query.tenantUsersTable.findFirst({
      where: eq(tenantUsersTable.userId, userId),
    });
    if (tenantUser) {
      tenantId = tenantUser.tenantId;
    }
  }

  if (tenantId) {
    ownerTenantCache.set(userId, { tenantId, cachedAt: Date.now() });
    return tenantId;
  }
  
  return null;
}
