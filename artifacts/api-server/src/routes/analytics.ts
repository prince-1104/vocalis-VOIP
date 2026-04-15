import { Router, type IRouter } from "express";
import { db, callLogsTable } from "@workspace/db";
import { eq, and, gte } from "drizzle-orm";

const router: IRouter = Router();

router.get("/analytics/summary", async (req, res) => {
  const userId = req.userId!;
  const period = (req.query.period as string) || "week";

  let since = new Date();
  if (period === "today") {
    since.setHours(0, 0, 0, 0);
  } else if (period === "week") {
    since.setDate(since.getDate() - 7);
  } else if (period === "month") {
    since.setMonth(since.getMonth() - 1);
  } else {
    since = new Date(0);
  }

  const conditions: any[] = [eq(callLogsTable.userId, userId)];
  if (period !== "all") conditions.push(gte(callLogsTable.startedAt, since));
  const where = and(...conditions);

  const allCalls = await db.select().from(callLogsTable).where(where);

  const totalCalls = allCalls.length;
  const answeredCalls = allCalls.filter(c => ["answered", "interested", "not_interested", "callback_requested"].includes(c.outcome || "")).length;
  const interestedLeads = allCalls.filter(c => c.outcome === "interested").length;
  const callbackRequests = allCalls.filter(c => c.outcome === "callback_requested").length;
  const durCalls = allCalls.filter(c => c.duration);
  const avgCallDuration = durCalls.length > 0 ? durCalls.reduce((sum, c) => sum + (c.duration || 0), 0) / durCalls.length : 0;
  const answerRate = totalCalls > 0 ? (answeredCalls / totalCalls) * 100 : 0;
  const conversionRate = answeredCalls > 0 ? (interestedLeads / answeredCalls) * 100 : 0;

  const days = period === "today" ? 1 : period === "week" ? 7 : 30;
  const callsByDayMap = new Map<string, { total: number; answered: number; interested: number }>();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    callsByDayMap.set(d.toISOString().split("T")[0], { total: 0, answered: 0, interested: 0 });
  }

  for (const call of allCalls) {
    const key = call.startedAt.toISOString().split("T")[0];
    if (callsByDayMap.has(key)) {
      const day = callsByDayMap.get(key)!;
      day.total++;
      if (["answered", "interested", "not_interested", "callback_requested"].includes(call.outcome || "")) day.answered++;
      if (call.outcome === "interested") day.interested++;
    }
  }

  const callsByDay = Array.from(callsByDayMap.entries()).map(([date, stats]) => ({ date, ...stats }));

  const outcomeCounts: Record<string, number> = {};
  for (const call of allCalls) {
    const o = call.outcome || "unknown";
    outcomeCounts[o] = (outcomeCounts[o] || 0) + 1;
  }
  const outcomeBreakdown = Object.entries(outcomeCounts).map(([outcome, count]) => ({
    outcome,
    count,
    percentage: totalCalls > 0 ? (count / totalCalls) * 100 : 0,
  }));

  const totalCostUsd = allCalls.reduce((sum, c) => sum + parseFloat(c.estimatedCostUsd || "0"), 0);
  const totalTwilioCostUsd = allCalls.reduce((sum, c) => sum + parseFloat(c.twilioCostUsd || "0"), 0);
  const totalOpenaiCostUsd = allCalls.reduce((sum, c) => sum + parseFloat(c.openaiCostUsd || "0"), 0);
  const callsWithCost = allCalls.filter(c => parseFloat(c.estimatedCostUsd || "0") > 0);
  const avgCostPerCall = callsWithCost.length > 0 ? totalCostUsd / callsWithCost.length : 0;

  const costByDay = Array.from(callsByDayMap.entries()).map(([date]) => {
    const dayCalls = allCalls.filter(c => c.startedAt.toISOString().split("T")[0] === date);
    const dayCost = dayCalls.reduce((sum, c) => sum + parseFloat(c.estimatedCostUsd || "0"), 0);
    return { date, cost: parseFloat(dayCost.toFixed(4)) };
  });

  res.json({
    totalCalls, answeredCalls, interestedLeads, callbackRequests,
    avgCallDuration, answerRate, conversionRate, callsByDay, outcomeBreakdown,
    totalCostUsd: parseFloat(totalCostUsd.toFixed(4)),
    totalTwilioCostUsd: parseFloat(totalTwilioCostUsd.toFixed(4)),
    totalOpenaiCostUsd: parseFloat(totalOpenaiCostUsd.toFixed(4)),
    avgCostPerCall: parseFloat(avgCostPerCall.toFixed(4)),
    costByDay,
  });
});

export default router;
