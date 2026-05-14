import { Router, type IRouter } from "express";
import { db, apiCostLogsTable, tenantLimitsTable, tenantsTable, platformSettingsTable, DEFAULT_API_RATES } from "@workspace/db";
import { eq, and, gte, sql, desc } from "drizzle-orm";
import { getTenantCostSummary, getTenantMonthCost } from "../lib/cost-logger";

const router: IRouter = Router();

function getMonthStart(offsetMonths = 0): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() - offsetMonths, 1);
}

function getCurrentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// ── GET /admin/costs — All tenants cost overview ─────────────────────────
router.get("/admin/costs", async (_req, res) => {
  const tenants = await db.select().from(tenantsTable).orderBy(tenantsTable.createdAt);
  const monthStart = getMonthStart();

  // Aggregate costs per tenant for this month
  const costRows = await db
    .select({
      tenantId: apiCostLogsTable.tenantId,
      totalCost: sql<string>`coalesce(sum(cost_usd::numeric), 0)`,
      llmCost: sql<string>`coalesce(sum(case when api_provider like 'llm:%' then cost_usd::numeric else 0 end), 0)`,
      ttsCost: sql<string>`coalesce(sum(case when api_provider like 'tts:%' then cost_usd::numeric else 0 end), 0)`,
      sttCost: sql<string>`coalesce(sum(case when api_provider like 'stt:%' then cost_usd::numeric else 0 end), 0)`,
      apiCalls: sql<string>`count(*)`,
    })
    .from(apiCostLogsTable)
    .where(gte(apiCostLogsTable.createdAt, monthStart))
    .groupBy(apiCostLogsTable.tenantId);

  const costMap = new Map(costRows.map(r => [r.tenantId, r]));

  // Fetch limits
  const limits = await db.select().from(tenantLimitsTable);
  const limitMap = new Map(limits.map(l => [l.tenantId, l]));

  const results = tenants.map(t => {
    const cost = costMap.get(t.id);
    const limit = limitMap.get(t.id);
    const totalCost = parseFloat(cost?.totalCost ?? "0");
    const monthlyLimit = parseFloat(limit?.monthlyLimitUsd?.toString() ?? "5.00");
    const usagePercent = monthlyLimit > 0 ? (totalCost / monthlyLimit) * 100 : 0;
    const status: "ok" | "warning" | "over_limit" =
      usagePercent >= 100 ? "over_limit" : usagePercent >= 80 ? "warning" : "ok";

    return {
      tenantId: t.id,
      tenantName: t.name,
      tenantSlug: t.slug,
      tenantStatus: t.status,
      monthlyLimitUsd: monthlyLimit,
      hardLimit: limit?.hardLimit ?? false,
      totalCostUsd: totalCost,
      llmCostUsd: parseFloat(cost?.llmCost ?? "0"),
      ttsCostUsd: parseFloat(cost?.ttsCost ?? "0"),
      sttCostUsd: parseFloat(cost?.sttCost ?? "0"),
      apiCalls: parseInt(cost?.apiCalls ?? "0", 10),
      usagePercent,
      status,
      limitAlertSentAt: limit?.limitAlertSentAt ?? null,
      alertMonth: limit?.alertMonth ?? null,
    };
  });

  // Summary cards
  const totalTenantsCount = tenants.length;
  const combinedCost = results.reduce((s, r) => s + r.totalCostUsd, 0);
  const atRiskCount = results.filter(r => r.usagePercent >= 80 && r.usagePercent < 100).length;
  const overLimitCount = results.filter(r => r.usagePercent >= 100).length;

  res.json({
    summary: {
      totalTenants: totalTenantsCount,
      combinedCostUsd: combinedCost,
      tenantsAtRisk: atRiskCount,
      tenantsOverLimit: overLimitCount,
    },
    tenants: results,
  });
});

// ── GET /admin/costs/:tenantId — Detailed tenant cost breakdown ──────────
router.get("/admin/costs/:tenantId", async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  const monthStart = getMonthStart();

  // Per-provider breakdown for current month
  const breakdown = await db
    .select({
      apiProvider: apiCostLogsTable.apiProvider,
      totalCost: sql<string>`coalesce(sum(cost_usd::numeric), 0)`,
      totalInputTokens: sql<string>`coalesce(sum(input_tokens), 0)`,
      totalOutputTokens: sql<string>`coalesce(sum(output_tokens), 0)`,
      totalCharacters: sql<string>`coalesce(sum(characters), 0)`,
      totalMinutes: sql<string>`coalesce(sum(minutes), 0)`,
      callCount: sql<string>`count(*)`,
    })
    .from(apiCostLogsTable)
    .where(and(eq(apiCostLogsTable.tenantId, tenantId), gte(apiCostLogsTable.createdAt, monthStart)))
    .groupBy(apiCostLogsTable.apiProvider);

  // Category subtotals
  let llmTotal = 0, ttsTotal = 0, sttTotal = 0;
  const rows = breakdown.map(b => {
    const cost = parseFloat(b.totalCost);
    if (b.apiProvider.startsWith("llm:")) llmTotal += cost;
    else if (b.apiProvider.startsWith("tts:")) ttsTotal += cost;
    else if (b.apiProvider.startsWith("stt:")) sttTotal += cost;
    return {
      apiProvider: b.apiProvider,
      costUsd: cost,
      inputTokens: parseInt(b.totalInputTokens ?? "0", 10),
      outputTokens: parseInt(b.totalOutputTokens ?? "0", 10),
      characters: parseInt(b.totalCharacters ?? "0", 10),
      minutes: parseFloat(b.totalMinutes ?? "0"),
      callCount: parseInt(b.callCount ?? "0", 10),
    };
  });

  const grandTotal = llmTotal + ttsTotal + sttTotal;

  // 6-month trend
  const trend: Array<{ month: string; costUsd: number }> = [];
  for (let i = 5; i >= 0; i--) {
    const mStart = getMonthStart(i);
    const mEnd = getMonthStart(i - 1);
    const [row] = await db
      .select({ total: sql<string>`coalesce(sum(cost_usd::numeric), 0)` })
      .from(apiCostLogsTable)
      .where(and(
        eq(apiCostLogsTable.tenantId, tenantId),
        gte(apiCostLogsTable.createdAt, mStart),
        sql`${apiCostLogsTable.createdAt} < ${mEnd}`,
      ));
    const monthLabel = `${mStart.getFullYear()}-${String(mStart.getMonth() + 1).padStart(2, "0")}`;
    trend.push({ month: monthLabel, costUsd: parseFloat(row?.total ?? "0") });
  }

  // Limits
  const limit = await db.query.tenantLimitsTable.findFirst({
    where: eq(tenantLimitsTable.tenantId, tenantId),
  });
  const monthlyLimit = parseFloat(limit?.monthlyLimitUsd?.toString() ?? "5.00");
  const usagePercent = monthlyLimit > 0 ? (grandTotal / monthlyLimit) * 100 : 0;

  res.json({
    tenantId,
    tenantName: tenant.name,
    breakdown: rows,
    subtotals: { llm: llmTotal, tts: ttsTotal, stt: sttTotal },
    grandTotal,
    monthlyLimitUsd: monthlyLimit,
    hardLimit: limit?.hardLimit ?? false,
    usagePercent,
    status: usagePercent >= 100 ? "over_limit" : usagePercent >= 80 ? "warning" : "ok",
    limitAlertSentAt: limit?.limitAlertSentAt ?? null,
    alertMonth: limit?.alertMonth ?? null,
    trend,
  });
});

// ── PATCH /admin/costs/:tenantId/limit — Set tenant limit ────────────────
router.patch("/admin/costs/:tenantId/limit", async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  const { monthlyLimitUsd, hardLimit } = req.body as {
    monthlyLimitUsd?: number | string;
    hardLimit?: boolean;
  };

  const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  type LimitUpdate = {
    monthlyLimitUsd?: string;
    hardLimit?: boolean;
    updatedAt: Date;
  };

  const updateData: LimitUpdate = { updatedAt: new Date() };
  if (monthlyLimitUsd !== undefined) updateData.monthlyLimitUsd = String(monthlyLimitUsd);
  if (hardLimit !== undefined) updateData.hardLimit = Boolean(hardLimit);

  // Upsert
  const existing = await db.query.tenantLimitsTable.findFirst({
    where: eq(tenantLimitsTable.tenantId, tenantId),
  });

  if (existing) {
    const [updated] = await db.update(tenantLimitsTable)
      .set(updateData)
      .where(eq(tenantLimitsTable.tenantId, tenantId))
      .returning();
    res.json(updated);
  } else {
    const [created] = await db.insert(tenantLimitsTable).values({
      tenantId,
      monthlyLimitUsd: String(monthlyLimitUsd ?? "5.00"),
      hardLimit: hardLimit ?? false,
    }).returning();
    res.json(created);
  }
});

// ── POST /admin/costs/:tenantId/send-alert — Send alert to tenant ────────
router.post("/admin/costs/:tenantId/send-alert", async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  const currentMonth = getCurrentMonthKey();

  // Update alert timestamp
  const existing = await db.query.tenantLimitsTable.findFirst({
    where: eq(tenantLimitsTable.tenantId, tenantId),
  });

  if (existing) {
    await db.update(tenantLimitsTable)
      .set({ limitAlertSentAt: new Date(), alertMonth: currentMonth, updatedAt: new Date() })
      .where(eq(tenantLimitsTable.tenantId, tenantId));
  } else {
    await db.insert(tenantLimitsTable).values({
      tenantId,
      monthlyLimitUsd: "5.00",
      hardLimit: false,
      limitAlertSentAt: new Date(),
      alertMonth: currentMonth,
    });
  }

  // TODO: Send actual email to tenant contact here
  // For now, just log it
  console.log(`[admin/costs] Alert sent to tenant ${tenant.name} (id=${tenantId}) for ${currentMonth}`);

  res.json({ success: true, alertSentAt: new Date().toISOString(), month: currentMonth });
});

// ── GET /admin/costs/rates — Current API pricing rates ──────────────────
router.get("/admin/costs/rates", async (_req, res) => {
  const rows = await db.select().from(platformSettingsTable);
  const rates = { ...DEFAULT_API_RATES };
  for (const row of rows) {
    if (row.key.startsWith("rate:")) {
      const rateKey = row.key.slice(5);
      const val = parseFloat(row.value);
      if (!isNaN(val)) rates[rateKey] = val;
    }
  }
  res.json(rates);
});

// ── PATCH /admin/costs/rates — Update API pricing rates ──────────────────
router.patch("/admin/costs/rates", async (req, res) => {
  const updates = req.body as Record<string, number>;
  const allowedKeys = new Set(Object.keys(DEFAULT_API_RATES));

  for (const [key, value] of Object.entries(updates)) {
    if (!allowedKeys.has(key)) continue;
    await db.insert(platformSettingsTable)
      .values({ key: `rate:${key}`, value: String(value) })
      .onConflictDoUpdate({
        target: platformSettingsTable.key,
        set: { value: String(value), updatedAt: new Date() },
      });
  }

  // Return updated rates
  const rows = await db.select().from(platformSettingsTable);
  const rates = { ...DEFAULT_API_RATES };
  for (const row of rows) {
    if (row.key.startsWith("rate:")) {
      const rateKey = row.key.slice(5);
      const val = parseFloat(row.value);
      if (!isNaN(val)) rates[rateKey] = val;
    }
  }
  res.json(rates);
});

export default router;
