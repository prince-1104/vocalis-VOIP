import { db, usageLedgerTable, tenantsTable, callLogsTable } from "@workspace/db";
import type { UsageCategory, UsageMeasurement, UsageStatus, UsageLedgerEntry } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { logger } from "../logger";
import { metrics } from "../operational-metrics";
import { currentRateCard, priceUsage, roundMoney, PLATFORM_CURRENCY, type RateCard } from "./rate-card";
import { addCommittedSpend, billingPeriod } from "./spend-budget";
import { resolveTenantIdForOwner } from "./tenant-owner";

import type { Connection } from "./connection";

/** charged: provider did the work. not_charged: provider rejected it. unknown: may or may not be billed. */
export type UsageOutcome = "charged" | "not_charged" | "unknown";
export type UsageUnit = "tokens" | "characters" | "audio_seconds" | "call_seconds" | "requests";
type Metadata = Record<string, string | number | boolean | null>;

export interface UsageRecord {
  userId: number;
  callLogId?: number | null;
  sessionRef?: string | null;
  source: string;
  category: UsageCategory;
  provider: string;
  model: string;
  /** Telephony leg used for pricing: outbound | inbound | client | conference. */
  leg?: string;
  providerRequestId?: string | null;
  idempotencyKey: string;
  measurement: UsageMeasurement;
  unit: UsageUnit;
  /** null when the quantity is not known (e.g. a dispatch with an unknown outcome). */
  quantity: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  outcome?: UsageOutcome;
  /** false keeps the entry pending (quantity may still change). */
  final?: boolean;
  /** Counted against the spend limit while the cost is unknown. */
  provisionalAmount?: number;
  providerCost?: { amount: number; currency: string } | null;
  eventAt?: Date;
  metadata?: Metadata;
}

export interface RecordResult {
  entryId: number;
  status: UsageStatus;
  created: boolean;
  reconciled: boolean;
}

const MEASUREMENT_RANK: Record<UsageMeasurement, number> = { unknown: 0, estimated: 1, actual: 2 };

interface Evaluation {
  status: UsageStatus;
  statusReason: string | null;
  billedUnits: number | null;
  platformCost: number | null;
  billableAmount: number | null;
  budgetAmount: number;
}

function evaluate(record: UsageRecord, card: RateCard, commissionPct: number): Evaluation {
  const provisional = roundMoney(Math.max(0, record.provisionalAmount ?? 0));
  if (record.outcome === "not_charged") {
    return { status: "failed", statusReason: "provider_rejected", billedUnits: 0, platformCost: 0, billableAmount: 0, budgetAmount: 0 };
  }
  if (record.quantity == null || record.measurement === "unknown") {
    return { status: "needs_reconciliation", statusReason: "quantity_unknown", billedUnits: null, platformCost: null, billableAmount: null, budgetAmount: provisional };
  }
  const price = priceUsage(card.rates, {
    category: record.category,
    provider: record.provider,
    model: record.model,
    unit: record.unit,
    quantity: record.quantity,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cachedInputTokens: record.cachedInputTokens,
    leg: record.leg,
  });
  if (!price.priced) {
    return { status: "needs_reconciliation", statusReason: `missing_rate:${price.missing.join(",")}`, billedUnits: null, platformCost: null, billableAmount: null, budgetAmount: provisional };
  }
  const platformCost = roundMoney(price.cost);
  const billableAmount = roundMoney(platformCost * (1 + commissionPct / 100));
  if (record.outcome === "unknown") {
    return { status: "needs_reconciliation", statusReason: "provider_outcome_unknown", billedUnits: price.billedUnits, platformCost, billableAmount, budgetAmount: platformCost };
  }
  return {
    status: record.final === false ? "pending" : "finalized",
    statusReason: null,
    billedUnits: price.billedUnits,
    platformCost,
    billableAmount,
    budgetAmount: platformCost,
  };
}

const money = (value: number | null) => (value == null ? null : value.toFixed(8));
const amount = (value: unknown) => (value == null ? 0 : Number(value));

function rowValues(tenantId: number, record: UsageRecord, card: RateCard, commissionPct: number, ev: Evaluation) {
  const now = new Date();
  return {
    tenantId,
    userId: record.userId,
    callLogId: record.callLogId ?? null,
    sessionRef: record.sessionRef ?? null,
    source: record.source,
    category: record.category,
    provider: record.provider,
    model: record.model,
    providerRequestId: record.providerRequestId ?? null,
    idempotencyKey: record.idempotencyKey,
    entryType: "usage" as const,
    measurement: record.measurement,
    unit: record.unit,
    quantity: record.quantity == null ? null : record.quantity.toFixed(6),
    inputTokens: record.inputTokens ?? null,
    outputTokens: record.outputTokens ?? null,
    cachedInputTokens: record.cachedInputTokens ?? null,
    billedUnits: ev.billedUnits == null ? null : ev.billedUnits.toFixed(6),
    rateCardId: card.id,
    rateVersion: card.version,
    currency: PLATFORM_CURRENCY,
    providerCost: record.providerCost ? record.providerCost.amount.toFixed(8) : null,
    providerCostCurrency: record.providerCost?.currency ?? null,
    platformCost: money(ev.platformCost),
    commissionPct: commissionPct.toFixed(2),
    billableAmount: money(ev.billableAmount),
    budgetAmount: ev.budgetAmount.toFixed(8),
    status: ev.status,
    statusReason: ev.statusReason,
    metadata: { ...(record.metadata ?? {}), ...(record.leg ? { leg: record.leg } : {}) },
    eventAt: record.eventAt ?? now,
    finalizedAt: ev.status === "finalized" || ev.status === "failed" ? now : null,
  };
}

async function commissionFor(tenantId: number, connection: Connection): Promise<number> {
  const tenant = await connection.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
  const pct = Number(tenant?.commissionPct ?? 0);
  return Number.isFinite(pct) ? pct : 0;
}

function supersedes(existing: UsageLedgerEntry, incoming: ReturnType<typeof rowValues>): boolean {
  const have = MEASUREMENT_RANK[existing.measurement];
  const next = MEASUREMENT_RANK[incoming.measurement];
  if (next > have) return true;
  if (next < have) return false;
  if (existing.status === "pending") return true;
  // A provider that later reports usage for a rejected request overrides the rejection.
  if (existing.status === "failed") {
    return incoming.status !== "failed" && incoming.statusReason !== "provider_outcome_unknown";
  }
  return existing.status === "needs_reconciliation" && incoming.status !== "needs_reconciliation";
}

/**
 * Replaces an uninvoiced entry in place (optimistic on revision) and moves the
 * budget counter by the difference. Invoiced entries are never rewritten: the
 * difference is recorded as an adjustment entry that the next invoice carries.
 */
async function replaceEntry(
  existing: UsageLedgerEntry,
  incoming: ReturnType<typeof rowValues>,
  connection: Connection,
): Promise<{ entryId: number; status: UsageStatus }> {
  const period = billingPeriod(existing.eventAt);
  if (existing.invoiceId != null) {
    const unknown = incoming.platformCost == null || existing.platformCost == null;
    const delta = (field: "platformCost" | "billableAmount") =>
      unknown ? null : roundMoney(amount(incoming[field]) - amount(existing[field]));
    const budgetDelta = roundMoney(amount(incoming.budgetAmount) - amount(existing.budgetAmount));
    const [adjustment] = await connection.insert(usageLedgerTable).values({
      ...incoming,
      idempotencyKey: `${existing.idempotencyKey}#adjust:${incoming.measurement}:${incoming.status}`,
      entryType: "adjustment",
      adjustsEntryId: existing.id,
      platformCost: money(delta("platformCost")),
      billableAmount: money(delta("billableAmount")),
      budgetAmount: budgetDelta.toFixed(8),
      status: unknown ? "needs_reconciliation" : incoming.status,
      statusReason: unknown ? "adjustment_unpriced" : "reconciled_after_invoice",
      eventAt: existing.eventAt,
    }).onConflictDoNothing().returning();
    if (!adjustment) return { entryId: existing.id, status: existing.status };
    await addCommittedSpend(existing.tenantId, period, budgetDelta, connection);
    return { entryId: adjustment.id, status: adjustment.status };
  }
  const { tenantId: _t, idempotencyKey: _k, eventAt: _e, ...changes } = incoming;
  const [updated] = await connection.update(usageLedgerTable)
    .set({ ...changes, revision: existing.revision + 1, updatedAt: new Date() })
    .where(and(eq(usageLedgerTable.id, existing.id), eq(usageLedgerTable.revision, existing.revision)))
    .returning();
  if (!updated) throw new ConcurrentLedgerUpdate();
  await addCommittedSpend(existing.tenantId, period, roundMoney(amount(incoming.budgetAmount) - amount(existing.budgetAmount)), connection);
  return { entryId: updated.id, status: updated.status };
}

class ConcurrentLedgerUpdate extends Error {}

async function findEntry(tenantId: number, key: string, connection: Connection) {
  return connection.query.usageLedgerTable.findFirst({
    where: and(eq(usageLedgerTable.tenantId, tenantId), eq(usageLedgerTable.idempotencyKey, key)),
  });
}

/**
 * Records one provider usage event exactly once per (tenant, idempotency key).
 * A repeat with better evidence (estimated → actual, unknown → known) replaces
 * the earlier values without double counting; a plain repeat is a no-op.
 */
export async function recordUsage(record: UsageRecord, connection: Connection = db): Promise<RecordResult> {
  return metrics.measure("usage", () => recordUsageImpl(record, connection), "internal", result =>
    result.status === "needs_reconciliation" ? "needs_reconciliation" : result.status === "pending" ? "pending" : "success");
}

async function recordUsageImpl(record: UsageRecord, connection: Connection): Promise<RecordResult> {
  const tenantId = await resolveTenantIdForOwner(record.userId);
  if (!tenantId) throw new Error("Usage owner has no tenant");
  const card = await currentRateCard(connection);
  const commissionPct = await commissionFor(tenantId, connection);
  const values = rowValues(tenantId, record, card, commissionPct, evaluate(record, card, commissionPct));

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await connection.transaction(async (tx: Connection) => {
        const [inserted] = await tx.insert(usageLedgerTable).values(values).onConflictDoNothing().returning();
        if (inserted) {
          await addCommittedSpend(tenantId, billingPeriod(values.eventAt), amount(values.budgetAmount), tx);
          return { entryId: inserted.id, status: inserted.status, created: true, reconciled: false };
        }
        const existing = await findEntry(tenantId, record.idempotencyKey, tx);
        if (!existing) throw new ConcurrentLedgerUpdate();
        if (supersedes(existing, values)) {
          const replaced = await replaceEntry(existing, values, tx);
          return { ...replaced, created: false, reconciled: true };
        }
        if (values.providerCost != null && existing.providerCost == null && existing.invoiceId == null) {
          await tx.update(usageLedgerTable)
            .set({ providerCost: values.providerCost, providerCostCurrency: values.providerCostCurrency, revision: existing.revision + 1, updatedAt: new Date() })
            .where(and(eq(usageLedgerTable.id, existing.id), eq(usageLedgerTable.revision, existing.revision)));
        }
        return { entryId: existing.id, status: existing.status, created: false, reconciled: false };
      });
    } catch (err) {
      if (!(err instanceof ConcurrentLedgerUpdate) || attempt === 2) throw err;
    }
  }
  throw new ConcurrentLedgerUpdate();
}

function recordFromEntry(entry: UsageLedgerEntry): UsageRecord {
  const meta = (entry.metadata ?? {}) as Metadata;
  return {
    userId: entry.userId,
    callLogId: entry.callLogId,
    sessionRef: entry.sessionRef,
    source: entry.source,
    category: entry.category,
    provider: entry.provider,
    model: entry.model,
    leg: typeof meta.leg === "string" ? meta.leg : undefined,
    providerRequestId: entry.providerRequestId,
    idempotencyKey: entry.idempotencyKey,
    measurement: entry.measurement,
    unit: entry.unit as UsageUnit,
    quantity: entry.quantity == null ? null : Number(entry.quantity),
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cachedInputTokens: entry.cachedInputTokens,
    providerCost: entry.providerCost == null ? null : { amount: Number(entry.providerCost), currency: entry.providerCostCurrency ?? PLATFORM_CURRENCY },
    eventAt: entry.eventAt,
    metadata: meta,
  };
}

export type ResolutionEvidence =
  | { kind: "reprice" }
  | { kind: "billed_seconds"; seconds: number }
  | { kind: "not_charged" };

/**
 * Super-admin resolution of a needs_reconciliation entry: price it with the
 * current rate card, or apply provider evidence (billed duration or no charge).
 */
export async function resolveUsageEntry(
  tenantId: number, entryId: number, evidence: ResolutionEvidence, connection: Connection = db,
): Promise<{ status: UsageStatus } | null> {
  return metrics.measure("usage_resolution", () => resolveUsageEntryImpl(tenantId, entryId, evidence, connection), "internal",
    result => result === null ? "blocked" : result.status === "needs_reconciliation" ? "needs_reconciliation" : "success");
}

async function resolveUsageEntryImpl(
  tenantId: number,
  entryId: number,
  evidence: ResolutionEvidence,
  connection: Connection = db,
): Promise<{ status: UsageStatus } | null> {
  const entry = await connection.query.usageLedgerTable.findFirst({
    where: and(eq(usageLedgerTable.id, entryId), eq(usageLedgerTable.tenantId, tenantId)),
  });
  if (!entry || entry.status !== "needs_reconciliation" || entry.entryType !== "usage") return null;
  const base = recordFromEntry(entry);
  const record: UsageRecord = evidence.kind === "reprice"
    ? { ...base, outcome: "charged" }
    : evidence.kind === "not_charged"
      ? { ...base, measurement: "actual", quantity: 0, outcome: "not_charged" }
      : { ...base, measurement: "actual", quantity: evidence.seconds, outcome: "charged" };
  if (record.quantity == null) return null;
  const card = await currentRateCard(connection);
  const commissionPct = await commissionFor(tenantId, connection);
  const values = rowValues(tenantId, record, card, commissionPct, evaluate(record, card, commissionPct));
  if (values.status === "needs_reconciliation") return { status: entry.status };
  return connection.transaction(async (tx: Connection) => {
    const replaced = await replaceEntry(entry, { ...values, measurement: record.measurement }, tx);
    return { status: replaced.status };
  });
}

/**
 * Mirrors the ledger into the call log's legacy cost columns. Unknown or
 * unpriced usage leaves them null rather than showing a partial total as final.
 */
export async function syncCallLogCosts(callLogId: number, connection: Connection = db) {
  const entries = await connection.select().from(usageLedgerTable).where(eq(usageLedgerTable.callLogId, callLogId));
  const counted = entries.filter((entry) => entry.status !== "failed");
  const unknown = counted.some((entry) => entry.platformCost == null);
  const sum = (rows: UsageLedgerEntry[], field: "platformCost" | "billableAmount") =>
    roundMoney(rows.reduce((total, entry) => total + amount(entry[field]), 0));
  const telephony = counted.filter((entry) => entry.category === "telephony");
  const ai = counted.filter((entry) => entry.category !== "telephony");
  const totals = {
    totalCost: unknown ? null : sum(counted, "platformCost"),
    billedCost: unknown ? null : sum(counted, "billableAmount"),
    telephonyCost: telephony.some((entry) => entry.platformCost == null) ? null : sum(telephony, "platformCost"),
    aiCost: ai.some((entry) => entry.platformCost == null) ? null : sum(ai, "platformCost"),
    minutes: telephony.reduce((total, entry) => total + amount(entry.billedUnits), 0),
  };
  await connection.update(callLogsTable)
    .set({
      estimatedCostUsd: totals.totalCost == null ? null : totals.totalCost.toFixed(6),
      billedCostUsd: totals.billedCost == null ? null : totals.billedCost.toFixed(6),
      twilioCostUsd: totals.telephonyCost == null ? null : totals.telephonyCost.toFixed(6),
      openaiCostUsd: totals.aiCost == null ? null : totals.aiCost.toFixed(6),
      twilioMinutes: Math.round(totals.minutes),
    })
    .where(eq(callLogsTable.id, callLogId));
  return totals;
}

/**
 * Statuses with which the provider refuses a request before doing any work
 * (malformed request, authentication, permission, unknown model, payload size,
 * rate or quota limit). 408, 409, 499 and every 5xx are deliberately absent:
 * the provider may have processed, and billed, the request.
 */
const REJECTED_BEFORE_PROCESSING = new Set([400, 401, 403, 404, 405, 413, 415, 422, 429]);

const PROVIDER_COMPLETED = Symbol("providerCompleted");

/**
 * Marks a local failure (e.g. audio conversion) that happened after the
 * provider returned a successful response, so the request is still billed.
 */
export function afterProviderSuccess(err: unknown): unknown {
  const target = err !== null && typeof err === "object" ? err : new Error(String(err));
  Object.defineProperty(target, PROVIDER_COMPLETED, { value: true });
  return target;
}

export interface FailureEvidence {
  /** The provider reported usage (e.g. a final stream chunk) before the failure. */
  usageReported?: boolean;
  /** The provider had already produced output (e.g. a partial stream). */
  outputProduced?: boolean;
}

/**
 * Billing outcome of a failed provider request. Only a confirmed rejection is
 * not_charged; server errors, timeouts, disconnects and incomplete responses
 * are unknown and stay in reconciliation with their estimated cost held.
 */
export function classifyProviderFailure(err: unknown, evidence: FailureEvidence = {}): UsageOutcome {
  if (evidence.usageReported) return "charged";
  if (err !== null && typeof err === "object" && (err as Record<symbol, unknown>)[PROVIDER_COMPLETED] === true) return "charged";
  if (evidence.outputProduced) return "unknown";
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" && REJECTED_BEFORE_PROCESSING.has(status) ? "not_charged" : "unknown";
}

/** Conservative token estimate (over-counts) used only when a provider reports no usage. */
export function estimateTokens(...texts: Array<string | null | undefined>): number {
  return Math.ceil(texts.reduce((total, text) => total + (text?.length ?? 0), 0) / 2);
}

export interface UsageScope {
  record(part: Omit<UsageRecord, "userId" | "callLogId" | "sessionRef" | "source" | "idempotencyKey"> & { key?: string }): Promise<void>;
  /** Waits for every record started so far. */
  flush(): Promise<void>;
}

/** Records usage for one request, call or turn without blocking the caller on failures. */
export function createUsageScope(base: {
  userId: number;
  source: string;
  keyPrefix: string;
  callLogId?: number | null;
  sessionRef?: string | null;
}): UsageScope {
  let sequence = 0;
  const pending: Promise<void>[] = [];
  return {
    record(part) {
      const { key, ...rest } = part;
      const idempotencyKey = `${base.keyPrefix}:${key ?? `${part.category}:${sequence++}`}`;
      const task = recordUsage({ ...rest, userId: base.userId, source: base.source, callLogId: base.callLogId, sessionRef: base.sessionRef, idempotencyKey })
        .then(() => undefined)
        .catch((err) => logger.error({ err, source: base.source, category: part.category }, "Usage recording failed"));
      pending.push(task);
      return task;
    },
    async flush() {
      await Promise.allSettled(pending.splice(0));
    },
  };
}
