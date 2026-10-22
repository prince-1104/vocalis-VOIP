import { db, tenantBudgetPeriodsTable, budgetReservationsTable, tenantLimitsTable } from "@workspace/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { logger } from "../logger";
import { resolveTenantIdForOwner } from "./tenant-owner";
import { roundMoney } from "./rate-card";

import type { Connection } from "./connection";

/** tenant_limits defaults when no row exists (matches the column defaults). */
export const DEFAULT_MONTHLY_LIMIT_USD = 5;
export const SOFT_WARNING_RATIO = 0.8;
const EPSILON = 1e-9;

const amountOf = (value: unknown): number => (value == null ? 0 : Number(value));

export function billingPeriod(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function periodBounds(period: string): { start: Date; end: Date } {
  const [year, month] = period.split("-").map(Number);
  return { start: new Date(Date.UTC(year, month - 1, 1)), end: new Date(Date.UTC(year, month, 1)) };
}

export type SpendLimitCode = "spend_limit" | "budget_unavailable";

/** Paid work was refused before any provider request. */
export class SpendLimitError extends Error {
  constructor(readonly code: SpendLimitCode) {
    super(code === "spend_limit"
      ? "The monthly usage limit for this account has been reached."
      : "Usage limits could not be checked; the request was not processed.");
    this.name = "SpendLimitError";
  }
}

export function spendLimitHttpStatus(err: SpendLimitError): number {
  return err.code === "spend_limit" ? 402 : 503;
}

export type BudgetWarning = "approaching_limit" | "over_soft_limit" | null;

export interface Reservation {
  tenantId: number;
  key: string;
  amount: number;
  warning: BudgetWarning;
}

interface LimitPolicy {
  limit: number;
  hard: boolean;
}

async function limitPolicy(tenantId: number, connection: Connection): Promise<LimitPolicy> {
  const row = await connection.query.tenantLimitsTable.findFirst({ where: eq(tenantLimitsTable.tenantId, tenantId) });
  const limit = row ? Number(row.monthlyLimitUsd) : DEFAULT_MONTHLY_LIMIT_USD;
  return { limit: Number.isFinite(limit) ? limit : 0, hard: row?.hardLimit ?? false };
}

const periodWhere = (tenantId: number, period: string) =>
  and(eq(tenantBudgetPeriodsTable.tenantId, tenantId), eq(tenantBudgetPeriodsTable.period, period));

async function ensurePeriodRow(tenantId: number, period: string, connection: Connection): Promise<void> {
  await connection.insert(tenantBudgetPeriodsTable).values({ tenantId, period }).onConflictDoNothing();
}

/** Row lock serializing every reservation for the tenant and period. */
async function lockPeriod(tenantId: number, period: string, connection: Connection) {
  await ensurePeriodRow(tenantId, period, connection);
  const [row] = await connection.select().from(tenantBudgetPeriodsTable).where(periodWhere(tenantId, period)).for("update");
  if (!row) throw new Error("Budget period row missing");
  return { committed: amountOf(row.committedAmount), reserved: amountOf(row.reservedAmount) };
}

async function adjustReserved(tenantId: number, period: string, delta: number, connection: Connection): Promise<void> {
  await connection.update(tenantBudgetPeriodsTable)
    .set({ reservedAmount: sql`${tenantBudgetPeriodsTable.reservedAmount} + ${roundMoney(delta)}`, updatedAt: new Date() })
    .where(periodWhere(tenantId, period));
}

/** Adds settled spend (ledger budget amounts) to the period counter. */
export async function addCommittedSpend(tenantId: number, period: string, delta: number, connection: Connection = db): Promise<void> {
  if (Math.abs(delta) < EPSILON) return;
  await ensurePeriodRow(tenantId, period, connection);
  await connection.update(tenantBudgetPeriodsTable)
    .set({ committedAmount: sql`${tenantBudgetPeriodsTable.committedAmount} + ${roundMoney(delta)}`, updatedAt: new Date() })
    .where(periodWhere(tenantId, period));
}

/** Single-winner release: only the caller that flips held → released adjusts the counter. */
async function releaseRow(
  row: typeof budgetReservationsTable.$inferSelect,
  reason: string,
  connection: Connection,
): Promise<boolean> {
  const released = await connection.update(budgetReservationsTable)
    .set({ status: "released", releasedAt: new Date(), releaseReason: reason })
    .where(and(eq(budgetReservationsTable.id, row.id), eq(budgetReservationsTable.status, "held")))
    .returning();
  if (released.length !== 1) return false;
  await adjustReserved(row.tenantId, row.period, -amountOf(row.amount), connection);
  return true;
}

async function releaseExpiredHolds(tenantId: number, now: Date, connection: Connection): Promise<void> {
  const expired = await connection.select().from(budgetReservationsTable).where(and(
    eq(budgetReservationsTable.tenantId, tenantId),
    eq(budgetReservationsTable.status, "held"),
    lt(budgetReservationsTable.expiresAt, now),
  ));
  for (const row of expired) await releaseRow(row, "expired", connection);
}

async function tenantFor(userId: number): Promise<number> {
  let tenantId: number | null;
  try {
    tenantId = await resolveTenantIdForOwner(userId);
  } catch {
    throw new SpendLimitError("budget_unavailable");
  }
  if (!tenantId) throw new SpendLimitError("budget_unavailable");
  return tenantId;
}

function warningFor(policy: LimitPolicy, projected: number): BudgetWarning {
  if (policy.limit <= 0) return null;
  if (projected >= policy.limit) return "over_soft_limit";
  if (projected >= policy.limit * SOFT_WARNING_RATIO) return "approaching_limit";
  return null;
}

function failClosed(err: unknown, operation: string): never {
  if (err instanceof SpendLimitError) throw err;
  logger.error({ err, operation }, "Budget state unavailable");
  throw new SpendLimitError("budget_unavailable");
}

export interface ReserveRequest {
  userId: number;
  key: string;
  amount: number;
  source: string;
  ttlMs: number;
  callLogId?: number | null;
  now?: Date;
}

/**
 * Holds `amount` against the tenant's monthly budget before paid work starts.
 * Hard limit: refused when committed + held + amount would exceed the limit (a
 * zero amount is refused once the limit is reached). Soft limit: always held,
 * with a warning. Idempotent per key; fails closed when state is unavailable.
 */
export async function reserveBudget(request: ReserveRequest, connection: Connection = db): Promise<Reservation> {
  const tenantId = await tenantFor(request.userId);
  const amount = roundMoney(Math.max(0, request.amount));
  const now = request.now ?? new Date();
  const period = billingPeriod(now);
  try {
    return await connection.transaction(async (tx: Connection) => {
      await lockPeriod(tenantId, period, tx);
      await releaseExpiredHolds(tenantId, now, tx);
      const existing = await tx.query.budgetReservationsTable.findFirst({
        where: and(eq(budgetReservationsTable.tenantId, tenantId), eq(budgetReservationsTable.idempotencyKey, request.key)),
      });
      if (existing) return { tenantId, key: request.key, amount: Number(existing.amount), warning: null };

      const [state] = await tx.select().from(tenantBudgetPeriodsTable).where(periodWhere(tenantId, period));
      const committed = amountOf(state?.committedAmount);
      const reserved = amountOf(state?.reservedAmount);
      const policy = await limitPolicy(tenantId, tx);
      const projected = committed + reserved + amount;
      if (policy.hard) {
        const exhausted = committed + reserved >= policy.limit - EPSILON;
        if (exhausted || projected > policy.limit + EPSILON) throw new SpendLimitError("spend_limit");
      }
      await adjustReserved(tenantId, period, amount, tx);
      await tx.insert(budgetReservationsTable).values({
        tenantId,
        period,
        idempotencyKey: request.key,
        source: request.source,
        callLogId: request.callLogId ?? null,
        amount: amount.toFixed(8),
        status: "held",
        expiresAt: new Date(now.getTime() + request.ttlMs),
      });
      return { tenantId, key: request.key, amount, warning: warningFor(policy, projected) };
    });
  } catch (err) {
    failClosed(err, "reserve");
  }
}

/**
 * Raises a held reservation to `target` (used as a call runs longer than its
 * initial hold). Refused under a hard limit like a new reservation.
 */
export async function topUpReservation(tenantId: number, key: string, target: number, connection: Connection = db): Promise<void> {
  try {
    await connection.transaction(async (tx: Connection) => {
      const row = await tx.query.budgetReservationsTable.findFirst({
        where: and(eq(budgetReservationsTable.tenantId, tenantId), eq(budgetReservationsTable.idempotencyKey, key)),
      });
      if (!row || row.status !== "held") throw new SpendLimitError("budget_unavailable");
      const { committed, reserved } = await lockPeriod(tenantId, row.period, tx);
      const current = await tx.query.budgetReservationsTable.findFirst({ where: eq(budgetReservationsTable.id, row.id) });
      if (!current || current.status !== "held") throw new SpendLimitError("budget_unavailable");
      const delta = roundMoney(target - amountOf(current.amount));
      if (delta <= EPSILON) return;
      const policy = await limitPolicy(tenantId, tx);
      if (policy.hard && committed + reserved + delta > policy.limit + EPSILON) throw new SpendLimitError("spend_limit");
      await tx.update(budgetReservationsTable)
        .set({ amount: roundMoney(target).toFixed(8) })
        .where(and(eq(budgetReservationsTable.id, row.id), eq(budgetReservationsTable.status, "held")));
      await adjustReserved(tenantId, row.period, delta, tx);
    });
  } catch (err) {
    failClosed(err, "top_up");
  }
}

export async function releaseReservation(tenantId: number, key: string, reason: string, connection: Connection = db): Promise<boolean> {
  return connection.transaction(async (tx: Connection) => {
    const row = await tx.query.budgetReservationsTable.findFirst({
      where: and(eq(budgetReservationsTable.tenantId, tenantId), eq(budgetReservationsTable.idempotencyKey, key)),
    });
    if (!row || row.status !== "held") return false;
    await lockPeriod(tenantId, row.period, tx);
    return releaseRow(row, reason, tx);
  });
}

export async function bindReservationCall(tenantId: number, key: string, callLogId: number, connection: Connection = db): Promise<void> {
  await connection.update(budgetReservationsTable)
    .set({ callLogId })
    .where(and(eq(budgetReservationsTable.tenantId, tenantId), eq(budgetReservationsTable.idempotencyKey, key)));
}

export async function releaseCallReservations(callLogId: number, reason: string, connection: Connection = db): Promise<number> {
  const held = await connection.select().from(budgetReservationsTable).where(and(
    eq(budgetReservationsTable.callLogId, callLogId),
    eq(budgetReservationsTable.status, "held"),
  ));
  let released = 0;
  for (const row of held) {
    if (await releaseReservation(row.tenantId, row.idempotencyKey, reason, connection)) released++;
  }
  return released;
}

export interface BudgetState {
  tenantId: number;
  period: string;
  committedUsd: number;
  reservedUsd: number;
  monthlyLimitUsd: number;
  hardLimit: boolean;
  usagePercent: number;
  status: "ok" | "warning" | "over_limit";
}

export async function getBudgetState(tenantId: number, connection: Connection = db, now = new Date()): Promise<BudgetState> {
  const period = billingPeriod(now);
  const [row] = await connection.select().from(tenantBudgetPeriodsTable).where(periodWhere(tenantId, period));
  const policy = await limitPolicy(tenantId, connection);
  const committedUsd = amountOf(row?.committedAmount);
  const reservedUsd = amountOf(row?.reservedAmount);
  const usagePercent = policy.limit > 0 ? (committedUsd / policy.limit) * 100 : 0;
  return {
    tenantId,
    period,
    committedUsd,
    reservedUsd,
    monthlyLimitUsd: policy.limit,
    hardLimit: policy.hard,
    usagePercent,
    status: usagePercent >= 100 ? "over_limit" : usagePercent >= SOFT_WARNING_RATIO * 100 ? "warning" : "ok",
  };
}

/** True when a hard limit is set and settled plus held spend has reached it. */
export function isOverHardLimit(state: BudgetState): boolean {
  return state.hardLimit && state.committedUsd + state.reservedUsd >= state.monthlyLimitUsd - EPSILON;
}

/** Gate without a hold, for steps that start paid work elsewhere (e.g. issuing a voice token). */
export async function assertBudgetAvailable(userId: number, connection: Connection = db): Promise<void> {
  const tenantId = await tenantFor(userId);
  try {
    if (isOverHardLimit(await getBudgetState(tenantId, connection))) throw new SpendLimitError("spend_limit");
  } catch (err) {
    failClosed(err, "check");
  }
}
