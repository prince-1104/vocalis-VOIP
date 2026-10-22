import { Router, type IRouter } from "express";
import { db, tenantLimitsTable, tenantsTable, callLogsTable, platformSettingsTable, usageLedgerTable, CONFIGURABLE_RATE_KEYS } from "@workspace/db";
import { eq, and, gte, lt, sql, desc, isNotNull } from "drizzle-orm";
import { logger } from "../lib/logger";
import { billingPeriod, getBudgetState, periodBounds } from "../lib/billing/spend-budget";
import { effectiveRates, invalidateRateCard, roundMoney } from "../lib/billing/rate-card";
import { resolveUsageEntry, syncCallLogCosts, type ResolutionEvidence } from "../lib/billing/usage-ledger";

const router: IRouter = Router();

// All cost views read the usage ledger (platform cost in USD, UTC months).

function monthOffset(period: string, offset: number): string {
  const [year, month] = period.split("-").map(Number);
  const at = new Date(Date.UTC(year, month - 1 + offset, 1));
  return billingPeriod(at);
}

type LedgerCostRow = {
  tenantId: number;
  category: string;
  provider: string;
  model: string;
  platformCost: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  quantity: string | null;
  unit: string;
  status: string;
  eventAt: Date;
};

async function ledgerRows(start: Date, end: Date, tenantId?: number): Promise<LedgerCostRow[]> {
  const conditions = [gte(usageLedgerTable.eventAt, start), lt(usageLedgerTable.eventAt, end)];
  if (tenantId !== undefined) conditions.push(eq(usageLedgerTable.tenantId, tenantId));
  return db.select({
    tenantId: usageLedgerTable.tenantId,
    category: usageLedgerTable.category,
    provider: usageLedgerTable.provider,
    model: usageLedgerTable.model,
    platformCost: usageLedgerTable.platformCost,
    inputTokens: usageLedgerTable.inputTokens,
    outputTokens: usageLedgerTable.outputTokens,
    quantity: usageLedgerTable.quantity,
    unit: usageLedgerTable.unit,
    status: usageLedgerTable.status,
    eventAt: usageLedgerTable.eventAt,
  }).from(usageLedgerTable).where(and(...conditions));
}

interface CategoryTotals {
  total: number;
  llm: number;
  tts: number;
  stt: number;
  telephony: number;
  entries: number;
  unpriced: number;
}

function totalsOf(rows: LedgerCostRow[]): CategoryTotals {
  const totals: CategoryTotals = { total: 0, llm: 0, tts: 0, stt: 0, telephony: 0, entries: 0, unpriced: 0 };
  for (const row of rows) {
    totals.entries += 1;
    if (row.status === "failed") continue;
    if (row.platformCost == null) { totals.unpriced += 1; continue; }
    const cost = Number(row.platformCost);
    totals.total = roundMoney(totals.total + cost);
    if (row.category === "llm" || row.category === "tts" || row.category === "stt" || row.category === "telephony") {
      totals[row.category] = roundMoney(totals[row.category] + cost);
    }
  }
  return totals;
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

async function callCountsByOwner(start: Date, end: Date): Promise<Map<number, number>> {
  const rows = await db.select({ userId: callLogsTable.userId, count: sql<string>`count(*)` })
    .from(callLogsTable)
    .where(and(gte(callLogsTable.startedAt, start), lt(callLogsTable.startedAt, end)))
    .groupBy(callLogsTable.userId);
  return new Map(rows.map((row) => [row.userId, Number(row.count)]));
}

// ── GET /superadmin/costs — All tenants cost overview ────────────────────
router.get("/superadmin/costs", async (_req, res) => {
  const period = billingPeriod();
  const { start, end } = periodBounds(period);
  const [tenants, rows, limits, callCounts] = await Promise.all([
    db.select().from(tenantsTable).orderBy(tenantsTable.createdAt),
    ledgerRows(start, end),
    db.select().from(tenantLimitsTable),
    callCountsByOwner(start, end),
  ]);
  const rowsByTenant = groupBy(rows, (row) => row.tenantId);
  const limitMap = new Map(limits.map((l) => [l.tenantId, l]));

  const results = await Promise.all(tenants.map(async (t) => {
    const totals = totalsOf(rowsByTenant.get(t.id) ?? []);
    const state = await getBudgetState(t.id);
    const limit = limitMap.get(t.id);
    return {
      tenantId: t.id,
      tenantName: t.name,
      tenantSlug: t.slug,
      tenantStatus: t.status,
      monthlyLimitUsd: state.monthlyLimitUsd,
      hardLimit: state.hardLimit,
      totalCostUsd: totals.total,
      llmCostUsd: totals.llm,
      ttsCostUsd: totals.tts,
      sttCostUsd: totals.stt,
      telephonyCostUsd: totals.telephony,
      committedUsd: state.committedUsd,
      reservedUsd: state.reservedUsd,
      unpricedEntries: totals.unpriced,
      apiCalls: totals.entries,
      callCount: t.ownerId ? callCounts.get(t.ownerId) ?? 0 : 0,
      usagePercent: state.usagePercent,
      status: state.status,
      limitAlertSentAt: limit?.limitAlertSentAt ?? null,
      alertMonth: limit?.alertMonth ?? null,
    };
  }));

  res.json({
    summary: {
      totalTenants: tenants.length,
      combinedCostUsd: roundMoney(results.reduce((s, r) => s + r.totalCostUsd, 0)),
      tenantsAtRisk: results.filter((r) => r.usagePercent >= 80 && r.usagePercent < 100).length,
      tenantsOverLimit: results.filter((r) => r.usagePercent >= 100).length,
    },
    tenants: results,
  });
});

// ── GET /superadmin/dashboard ─────────────────────────────────────────────
router.get("/superadmin/dashboard", async (_req, res) => {
  const period = billingPeriod();
  const { start, end } = periodBounds(period);
  const [tenants, rows, limits] = await Promise.all([
    db.select().from(tenantsTable),
    ledgerRows(start, end),
    db.select().from(tenantLimitsTable),
  ]);
  const rowsByTenant = groupBy(rows, (row) => row.tenantId);
  const platformCost = totalsOf(rows).total;

  // Revenue here is the sum of configured monthly limits (unchanged legacy definition; no plans are inferred).
  let totalRevenue = 0;
  let overLimitCount = 0;
  for (const limit of limits) {
    const lim = Number(limit.monthlyLimitUsd ?? 0);
    totalRevenue += lim;
    if (lim > 0) {
      const state = await getBudgetState(limit.tenantId);
      if (state.committedUsd >= lim) overLimitCount++;
    }
  }

  const tenantNames = new Map(tenants.map((t) => [t.id, t.name]));
  const recentAlerts = await db.select({
    tenantId: tenantLimitsTable.tenantId,
    timestamp: tenantLimitsTable.limitAlertSentAt,
  }).from(tenantLimitsTable)
    .where(isNotNull(tenantLimitsTable.limitAlertSentAt))
    .orderBy(desc(tenantLimitsTable.limitAlertSentAt))
    .limit(5);

  const topConsumers = [...rowsByTenant.entries()]
    .map(([tenantId, tenantRows]) => ({ tenantId, tenantName: tenantNames.get(tenantId) ?? null, cost: totalsOf(tenantRows).total }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 5);

  const byDay = groupBy(rows, (row) => row.eventAt.toISOString().slice(0, 10));
  const chartData = [...byDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, dayRows]) => {
      const totals = totalsOf(dayRows);
      return { date, llm: totals.llm, tts: totals.tts, stt: totals.stt, telephony: totals.telephony };
    });

  res.json({
    summary: {
      totalTenants: tenants.length,
      activeThisMonth: rowsByTenant.size,
      platformCost,
      tenantsOverLimit: overLimitCount,
      totalRevenue,
      estimatedMargin: totalRevenue - platformCost,
    },
    recentAlerts: recentAlerts.map((r) => ({ tenantId: r.tenantId, tenantName: tenantNames.get(r.tenantId) ?? null, timestamp: r.timestamp })),
    topConsumers,
    chartData,
  });
});

// ── GET /superadmin/costs/rates — Rates in force ───────────────────────────
router.get("/superadmin/costs/rates", async (_req, res) => {
  res.json(await effectiveRates());
});

// ── PATCH /superadmin/costs/rates — Override known rates ──────────────────
// Each change produces a new immutable rate-card version for entries recorded
// afterwards; existing ledger entries keep the version they were priced with.
router.patch("/superadmin/costs/rates", async (req, res) => {
  const updates = req.body as Record<string, unknown>;
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) {
    res.status(400).json({ error: "Body must be an object of rate key to USD amount" });
    return;
  }
  const allowedKeys = new Set(CONFIGURABLE_RATE_KEYS);
  const entries = Object.entries(updates);
  const invalid = entries.filter(([key, value]) =>
    !allowedKeys.has(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000);
  if (entries.length === 0 || invalid.length > 0) {
    res.status(400).json({ error: "Unknown rate key or invalid amount", invalidKeys: invalid.map(([key]) => key).slice(0, 20) });
    return;
  }

  for (const [key, value] of entries) {
    await db.insert(platformSettingsTable)
      .values({ key: `rate:${key}`, value: String(value) })
      .onConflictDoUpdate({
        target: platformSettingsTable.key,
        set: { value: String(value), updatedAt: new Date() },
      });
  }
  invalidateRateCard();
  logger.info({ event: "billing_rates_updated", keys: entries.map(([key]) => key) }, "Billing rates updated");
  res.json(await effectiveRates());
});

// ── Reconciliation queue ───────────────────────────────────────────────────
router.get("/superadmin/usage/reconciliation", async (req, res) => {
  const tenantId = req.query.tenantId === undefined ? undefined : Number(req.query.tenantId);
  if (tenantId !== undefined && (!Number.isInteger(tenantId) || tenantId <= 0)) {
    res.status(400).json({ error: "Invalid tenantId" });
    return;
  }
  const conditions = [eq(usageLedgerTable.status, "needs_reconciliation")];
  if (tenantId !== undefined) conditions.push(eq(usageLedgerTable.tenantId, tenantId));
  const entries = await db.select({
    id: usageLedgerTable.id,
    tenantId: usageLedgerTable.tenantId,
    callLogId: usageLedgerTable.callLogId,
    source: usageLedgerTable.source,
    category: usageLedgerTable.category,
    provider: usageLedgerTable.provider,
    model: usageLedgerTable.model,
    providerRequestId: usageLedgerTable.providerRequestId,
    measurement: usageLedgerTable.measurement,
    unit: usageLedgerTable.unit,
    quantity: usageLedgerTable.quantity,
    platformCost: usageLedgerTable.platformCost,
    budgetAmount: usageLedgerTable.budgetAmount,
    statusReason: usageLedgerTable.statusReason,
    rateVersion: usageLedgerTable.rateVersion,
    eventAt: usageLedgerTable.eventAt,
  }).from(usageLedgerTable)
    .where(and(...conditions))
    .orderBy(usageLedgerTable.eventAt)
    .limit(500);
  res.json({ entries });
});

router.post("/superadmin/usage/:entryId/resolve", async (req, res) => {
  const entryId = Number(req.params.entryId);
  const { tenantId, kind, seconds } = req.body as { tenantId?: unknown; kind?: unknown; seconds?: unknown };
  if (!Number.isInteger(entryId) || entryId <= 0 || typeof tenantId !== "number" || !Number.isInteger(tenantId) || tenantId <= 0) {
    res.status(400).json({ error: "entryId and tenantId are required" });
    return;
  }
  let evidence: ResolutionEvidence;
  if (kind === "reprice") evidence = { kind: "reprice" };
  else if (kind === "not_charged") evidence = { kind: "not_charged" };
  else if (kind === "billed_seconds" && typeof seconds === "number" && Number.isInteger(seconds) && seconds >= 0 && seconds <= 86_400) {
    evidence = { kind: "billed_seconds", seconds };
  } else {
    res.status(400).json({ error: "kind must be reprice, not_charged or billed_seconds (with integer seconds)" });
    return;
  }
  const entry = await db.query.usageLedgerTable.findFirst({
    where: and(eq(usageLedgerTable.id, entryId), eq(usageLedgerTable.tenantId, tenantId)),
  });
  const result = await resolveUsageEntry(tenantId, entryId, evidence);
  if (!result) {
    res.status(404).json({ error: "No unreconciled usage entry with that id for this tenant" });
    return;
  }
  if (entry?.callLogId != null) await syncCallLogCosts(entry.callLogId);
  logger.info({ event: "usage_entry_resolved", tenantId, entryId, kind, status: result.status }, "Usage entry resolved");
  res.json(result);
});

// ── GET /superadmin/costs/:tenantId — Detailed tenant cost breakdown ──────
router.get("/superadmin/costs/:tenantId", async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  const period = billingPeriod();
  const { start, end } = periodBounds(period);
  const trendStart = periodBounds(monthOffset(period, -5)).start;
  const [allRows, state, limit] = await Promise.all([
    ledgerRows(trendStart, end, tenantId),
    getBudgetState(tenantId),
    db.query.tenantLimitsTable.findFirst({ where: eq(tenantLimitsTable.tenantId, tenantId) }),
  ]);
  const monthRows = allRows.filter((row) => row.eventAt >= start);

  const breakdown = [...groupBy(monthRows, (row) => `${row.category}:${row.provider}:${row.model}`).entries()].map(([apiProvider, rows]) => {
    const totals = totalsOf(rows);
    const sumOf = (unit: string) => rows.filter((row) => row.unit === unit).reduce((s, row) => s + Number(row.quantity ?? 0), 0);
    return {
      apiProvider,
      costUsd: totals.total,
      unpricedEntries: totals.unpriced,
      inputTokens: rows.reduce((s, row) => s + (row.inputTokens ?? 0), 0),
      outputTokens: rows.reduce((s, row) => s + (row.outputTokens ?? 0), 0),
      characters: sumOf("characters"),
      minutes: roundMoney((sumOf("audio_seconds") + sumOf("call_seconds")) / 60),
      callCount: rows.length,
    };
  });
  const monthTotals = totalsOf(monthRows);

  const [callCountRow] = tenant.ownerId
    ? await db
        .select({ count: sql<string>`count(*)` })
        .from(callLogsTable)
        .where(and(eq(callLogsTable.userId, tenant.ownerId), gte(callLogsTable.startedAt, start), lt(callLogsTable.startedAt, end)))
    : [{ count: "0" }];

  const trend: Array<{ month: string; costUsd: number }> = [];
  for (let i = 5; i >= 0; i--) {
    const month = monthOffset(period, -i);
    const bounds = periodBounds(month);
    trend.push({ month, costUsd: totalsOf(allRows.filter((row) => row.eventAt >= bounds.start && row.eventAt < bounds.end)).total });
  }

  res.json({
    tenantId,
    tenantName: tenant.name,
    breakdown,
    subtotals: { llm: monthTotals.llm, tts: monthTotals.tts, stt: monthTotals.stt, telephony: monthTotals.telephony },
    grandTotal: monthTotals.total,
    unpricedEntries: monthTotals.unpriced,
    committedUsd: state.committedUsd,
    reservedUsd: state.reservedUsd,
    callCount: parseInt(callCountRow?.count ?? "0", 10),
    monthlyLimitUsd: state.monthlyLimitUsd,
    hardLimit: state.hardLimit,
    usagePercent: state.usagePercent,
    status: state.status,
    limitAlertSentAt: limit?.limitAlertSentAt ?? null,
    alertMonth: limit?.alertMonth ?? null,
    trend,
  });
});

// ── PATCH /superadmin/costs/:tenantId/limit — Set tenant limit ────────────
router.patch("/superadmin/costs/:tenantId/limit", async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  const { monthlyLimitUsd, hardLimit } = req.body as {
    monthlyLimitUsd?: unknown;
    hardLimit?: unknown;
  };
  const limitValue = monthlyLimitUsd === undefined ? undefined : Number(monthlyLimitUsd);
  if (limitValue !== undefined && (!Number.isFinite(limitValue) || limitValue < 0 || limitValue > 10_000_000)) {
    res.status(400).json({ error: "monthlyLimitUsd must be a non-negative USD amount" });
    return;
  }
  if (hardLimit !== undefined && typeof hardLimit !== "boolean") {
    res.status(400).json({ error: "hardLimit must be a boolean" });
    return;
  }

  const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  type LimitUpdate = {
    monthlyLimitUsd?: string;
    hardLimit?: boolean;
    updatedAt: Date;
  };

  const updateData: LimitUpdate = { updatedAt: new Date() };
  if (limitValue !== undefined) updateData.monthlyLimitUsd = limitValue.toFixed(2);
  if (hardLimit !== undefined) updateData.hardLimit = hardLimit;

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
      monthlyLimitUsd: (limitValue ?? 5).toFixed(2),
      hardLimit: hardLimit ?? false,
    }).returning();
    res.json(created);
  }
});

// ── POST /superadmin/costs/:tenantId/send-alert — Send alert to tenant ────
router.post("/superadmin/costs/:tenantId/send-alert", async (req, res) => {
  const tenantId = parseInt(req.params.tenantId, 10);
  const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  if (!tenant) { res.status(404).json({ error: "Tenant not found" }); return; }

  const currentMonth = billingPeriod();

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
  logger.info({ event: "tenant_cost_alert_sent", tenantId, month: currentMonth }, "Tenant cost alert sent");

  res.json({ success: true, alertSentAt: new Date().toISOString(), month: currentMonth });
});

export default router;
