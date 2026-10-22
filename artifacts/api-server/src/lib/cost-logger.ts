import { db, tenantLimitsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getBudgetState, isOverHardLimit } from "./billing/spend-budget";

// Usage is recorded in the usage ledger (lib/billing/usage-ledger.ts); these
// helpers summarize the ledger-backed monthly budget counters.
export { resolveTenantIdForOwner } from "./billing/tenant-owner";

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
  return (await getBudgetState(tenantId)).committedUsd;
}

export async function getTenantCostSummary(tenantId: number): Promise<TenantCostSummary> {
  const state = await getBudgetState(tenantId);
  const limit = await db.query.tenantLimitsTable.findFirst({ where: eq(tenantLimitsTable.tenantId, tenantId) });
  return {
    tenantId,
    totalCostUsd: state.committedUsd,
    monthlyLimitUsd: state.monthlyLimitUsd,
    hardLimit: state.hardLimit,
    usagePercent: state.usagePercent,
    status: state.status,
    limitAlertSentAt: limit?.limitAlertSentAt ?? null,
  };
}

export async function isTenantOverHardLimit(tenantId: number): Promise<boolean> {
  return isOverHardLimit(await getBudgetState(tenantId));
}
