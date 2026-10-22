import {
  db,
  invoicesTable,
  invoiceLineItemsTable,
  invoiceAdjustmentsTable,
  tenantsTable,
  usageLedgerTable,
  type UsageLedgerEntry,
} from "@workspace/db";
import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import type { Connection } from "./connection";
import { periodBounds } from "./spend-budget";
import { PLATFORM_CURRENCY, roundMoney } from "./rate-card";

export const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export class InvoiceError extends Error {
  constructor(
    readonly code: "invalid_period" | "tenant_not_found" | "invoice_exists" | "usage_incomplete" | "usage_claimed",
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "InvoiceError";
  }
}

const amount = (value: unknown) => (value == null ? 0 : Number(value));
const money6 = (value: number) => roundMoney(value).toFixed(6);

interface LineGroup {
  callLogId: number | null;
  category: string;
  description: string;
  raw: number;
  billed: number;
  seconds: number;
  count: number;
  estimated: boolean;
  startedAt: Date;
}

function groupKey(entry: UsageLedgerEntry): string {
  return entry.callLogId != null ? `call:${entry.callLogId}` : `${entry.source}:${entry.category}`;
}

/** Invoice lines never carry phone numbers or transcripts: calls are referenced by id only. */
function buildLineGroups(entries: UsageLedgerEntry[]): LineGroup[] {
  const groups = new Map<string, LineGroup>();
  for (const entry of entries) {
    const key = groupKey(entry);
    let group = groups.get(key);
    if (!group) {
      group = {
        callLogId: entry.callLogId,
        category: entry.callLogId != null ? "call" : entry.category,
        description: entry.callLogId != null ? `Call #${entry.callLogId}` : `${entry.source} ${entry.category}`,
        raw: 0,
        billed: 0,
        seconds: 0,
        count: 0,
        estimated: false,
        startedAt: entry.eventAt,
      };
      groups.set(key, group);
    }
    group.raw += amount(entry.platformCost);
    group.billed += amount(entry.billableAmount);
    group.count += 1;
    if (entry.measurement !== "actual") group.estimated = true;
    if (entry.category === "telephony" && entry.entryType === "usage" && entry.unit === "call_seconds"
      && entry.metadata?.leg !== "conference" && entry.source === "call") {
      group.seconds += amount(entry.quantity);
    }
    if (entry.eventAt < group.startedAt) group.startedAt = entry.eventAt;
  }
  return [...groups.values()];
}

function summarize(entries: UsageLedgerEntry[], excluded: UsageLedgerEntry[]) {
  const byCategory: Record<string, { platformCostUsd: number; billableUsd: number; entries: number }> = {};
  for (const entry of entries) {
    const bucket = byCategory[entry.category] ??= { platformCostUsd: 0, billableUsd: 0, entries: 0 };
    bucket.platformCostUsd = roundMoney(bucket.platformCostUsd + amount(entry.platformCost));
    bucket.billableUsd = roundMoney(bucket.billableUsd + amount(entry.billableAmount));
    bucket.entries += 1;
  }
  return {
    currency: PLATFORM_CURRENCY,
    entries: entries.length,
    estimatedEntries: entries.filter((entry) => entry.measurement !== "actual").length,
    adjustmentEntries: entries.filter((entry) => entry.entryType === "adjustment").length,
    excludedIncompleteEntries: excluded.length,
    byCategory,
  };
}

export interface GenerateInvoiceRequest {
  tenantId: number;
  period: string;
  notes?: string | null;
  /** Explicit policy: leave pending / unreconciled usage for a later invoice instead of refusing. */
  allowIncomplete?: boolean;
}

/**
 * Builds a tenant's invoice for a UTC month from the usage ledger.
 *
 * Included: finalized, not-yet-invoiced entries with event time before the end
 * of the period (so late reconciliations and adjustments from earlier months
 * carry forward). Failed (not charged) entries carry no amount and are skipped.
 * Pending or needs_reconciliation entries refuse generation unless
 * allowIncomplete is set, in which case they stay uninvoiced. Each entry is
 * claimed by exactly one invoice; a concurrent generation loses and rolls back.
 */
export async function generateLedgerInvoice(request: GenerateInvoiceRequest, connection: Connection = db) {
  if (!PERIOD_PATTERN.test(request.period)) throw new InvoiceError("invalid_period");
  const tenant = await connection.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, request.tenantId) });
  if (!tenant) throw new InvoiceError("tenant_not_found");

  const existing = await connection.query.invoicesTable.findFirst({
    where: and(eq(invoicesTable.tenantId, request.tenantId), eq(invoicesTable.period, request.period)),
  });
  if (existing) throw new InvoiceError("invoice_exists", { invoiceId: existing.id });

  const { end } = periodBounds(request.period);
  return connection.transaction(async (tx) => {
    const open = await tx.select().from(usageLedgerTable).where(and(
      eq(usageLedgerTable.tenantId, request.tenantId),
      isNull(usageLedgerTable.invoiceId),
      lt(usageLedgerTable.eventAt, end),
    ));
    const incomplete = open.filter((entry) => entry.status === "pending" || entry.status === "needs_reconciliation");
    if (incomplete.length > 0 && !request.allowIncomplete) {
      throw new InvoiceError("usage_incomplete", {
        pending: incomplete.filter((entry) => entry.status === "pending").length,
        needsReconciliation: incomplete.filter((entry) => entry.status === "needs_reconciliation").length,
      });
    }
    const included = open.filter((entry) => entry.status === "finalized");

    const totalRaw = roundMoney(included.reduce((sum, entry) => sum + amount(entry.platformCost), 0));
    const totalBilled = roundMoney(included.reduce((sum, entry) => sum + amount(entry.billableAmount), 0));
    const dueDate = new Date(Date.now() + (tenant.paymentTermsDays ?? 30) * 86_400_000);

    const [invoice] = await tx.insert(invoicesTable).values({
      tenantId: request.tenantId,
      period: request.period,
      totalRawCostUsd: money6(totalRaw),
      totalBilledCostUsd: money6(totalBilled),
      commissionUsd: money6(totalBilled - totalRaw),
      commissionPct: Number(tenant.commissionPct ?? 0).toFixed(2),
      status: "draft",
      dueDate,
      notes: request.notes ?? null,
      source: "ledger",
      currency: PLATFORM_CURRENCY,
      rateVersions: [...new Set(included.map((entry) => entry.rateVersion).filter((v): v is string => !!v))],
      usageSummary: summarize(included, incomplete),
    }).onConflictDoNothing().returning();
    if (!invoice) throw new InvoiceError("invoice_exists");

    if (included.length > 0) {
      const ids = included.map((entry) => entry.id);
      const claimed = await tx.update(usageLedgerTable)
        .set({ invoiceId: invoice.id, updatedAt: new Date() })
        .where(and(inArray(usageLedgerTable.id, ids), isNull(usageLedgerTable.invoiceId)))
        .returning({ id: usageLedgerTable.id });
      if (claimed.length !== ids.length) throw new InvoiceError("usage_claimed");

      const groups = buildLineGroups(included);
      await tx.insert(invoiceLineItemsTable).values(groups.map((group) => ({
        invoiceId: invoice.id,
        callLogId: group.callLogId,
        rawCostUsd: money6(group.raw),
        billedCostUsd: money6(group.billed),
        durationSeconds: group.callLogId != null ? Math.round(group.seconds) : null,
        phone: null,
        startedAt: group.startedAt,
        description: group.description,
        category: group.category,
        usageCount: group.count,
        estimated: group.estimated,
      })));
    }

    return {
      invoice,
      callCount: new Set(included.filter((entry) => entry.callLogId != null).map((entry) => entry.callLogId)).size,
      entryCount: included.length,
      excludedIncomplete: incomplete.length,
    };
  });
}

export interface AdjustmentRequest {
  invoiceId: number;
  billedAmountUsd: number;
  rawAmountUsd?: number;
  reason: string;
  createdBy: number | null;
}

const MAX_ADJUSTMENT_USD = 1_000_000;

export function validAdjustmentAmount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_ADJUSTMENT_USD;
}

/** Corrections are separate rows; the invoice's own totals are never rewritten. */
export async function addInvoiceAdjustment(request: AdjustmentRequest, connection: Connection = db) {
  const invoice = await connection.query.invoicesTable.findFirst({ where: eq(invoicesTable.id, request.invoiceId) });
  if (!invoice) return null;
  const [adjustment] = await connection.insert(invoiceAdjustmentsTable).values({
    invoiceId: invoice.id,
    tenantId: invoice.tenantId,
    rawAmountUsd: money6(request.rawAmountUsd ?? 0),
    billedAmountUsd: money6(request.billedAmountUsd),
    reason: request.reason,
    createdBy: request.createdBy,
  }).returning();
  return adjustment;
}

export async function invoiceAdjustments(invoiceId: number, connection: Connection = db) {
  const rows = await connection.select().from(invoiceAdjustmentsTable).where(eq(invoiceAdjustmentsTable.invoiceId, invoiceId));
  const adjustmentTotal = roundMoney(rows.reduce((sum, row) => sum + amount(row.billedAmountUsd), 0));
  return { rows, adjustmentTotal };
}

/** Amount the tenant owes on an invoice: its billed total plus every adjustment row. */
export async function invoiceAmountDue(invoice: { id: number; totalBilledCostUsd: string | number | null }, connection: Connection = db): Promise<number> {
  const { adjustmentTotal } = await invoiceAdjustments(invoice.id, connection);
  return roundMoney(amount(invoice.totalBilledCostUsd) + adjustmentTotal);
}
