import { Router, type IRouter } from "express";
import { db, invoicesTable, invoiceLineItemsTable, tenantsTable, usageLedgerTable } from "@workspace/db";
import { eq, and, desc, gte, lt } from "drizzle-orm";
import { requireSuperadmin, resolveUser, requireRole } from "../middleware/auth";
import { adminMutationRateLimit } from "../lib/rate-limit-policies";
import { logger } from "../lib/logger";
import {
  addInvoiceAdjustment,
  generateLedgerInvoice,
  invoiceAdjustments,
  invoiceAmountDue,
  InvoiceError,
  validAdjustmentAmount,
} from "../lib/billing/invoicing";
import { billingPeriod, getBudgetState, periodBounds } from "../lib/billing/spend-budget";
import { roundMoney } from "../lib/billing/rate-card";

const router: IRouter = Router();

/** Errors are logged server-side; clients get a generic message (no driver or SQL detail). */
function sendServerError(res: any, err: unknown, operation: string) {
  logger.error({ err, operation }, "Invoice request failed");
  res.status(500).json({ error: "Invoice request failed" });
}

export async function checkAndMarkOverdueInvoices(): Promise<void> {
  const now = new Date();
  const sentInvoices = await db.query.invoicesTable.findMany({
    where: and(
      eq(invoicesTable.status, "sent"),
    ),
  });

  for (const invoice of sentInvoices) {
    if (invoice.dueDate && invoice.dueDate < now) {
      // Credits can settle an invoice in full; nothing owed is never grounds for suspension.
      if (await invoiceAmountDue(invoice) <= 0) continue;
      await db.update(invoicesTable)
        .set({ status: "overdue", updatedAt: new Date() })
        .where(eq(invoicesTable.id, invoice.id));

      await db.update(tenantsTable)
        .set({ status: "suspended", suspendedAt: new Date() })
        .where(eq(tenantsTable.id, invoice.tenantId));
    }
  }
}

async function withAdjustments<T extends { id: number; totalBilledCostUsd: string }>(invoice: T) {
  const { rows, adjustmentTotal } = await invoiceAdjustments(invoice.id);
  return {
    adjustments: rows,
    adjustedTotalBilledCostUsd: roundMoney(Number(invoice.totalBilledCostUsd) + adjustmentTotal).toFixed(6),
  };
}

router.use(["/invoices", "/superadmin/invoices", "/usage"], resolveUser);

router.get("/superadmin/invoices", requireSuperadmin, async (_req, res) => {
  try {
    const invoices = await db
      .select({
        id: invoicesTable.id,
        tenantId: invoicesTable.tenantId,
        tenantName: tenantsTable.name,
        period: invoicesTable.period,
        totalRawCostUsd: invoicesTable.totalRawCostUsd,
        totalBilledCostUsd: invoicesTable.totalBilledCostUsd,
        commissionUsd: invoicesTable.commissionUsd,
        commissionPct: invoicesTable.commissionPct,
        status: invoicesTable.status,
        dueDate: invoicesTable.dueDate,
        paidAt: invoicesTable.paidAt,
        notes: invoicesTable.notes,
        source: invoicesTable.source,
        currency: invoicesTable.currency,
        createdAt: invoicesTable.createdAt,
        updatedAt: invoicesTable.updatedAt,
      })
      .from(invoicesTable)
      .leftJoin(tenantsTable, eq(invoicesTable.tenantId, tenantsTable.id))
      .orderBy(desc(invoicesTable.createdAt));

    res.json({ invoices });
  } catch (err) {
    sendServerError(res, err, "list");
  }
});

router.post("/superadmin/invoices/generate", requireSuperadmin, adminMutationRateLimit, async (req, res) => {
  const { tenantId, period, notes, allowIncomplete } = req.body as {
    tenantId?: unknown;
    period?: unknown;
    notes?: unknown;
    allowIncomplete?: unknown;
  };
  if (typeof tenantId !== "number" || !Number.isInteger(tenantId) || tenantId <= 0 || typeof period !== "string") {
    res.status(400).json({ error: "tenantId and period (YYYY-MM) are required" });
    return;
  }
  if (notes !== undefined && notes !== null && (typeof notes !== "string" || notes.length > 2000)) {
    res.status(400).json({ error: "notes must be a string of at most 2000 characters" });
    return;
  }
  try {
    const result = await generateLedgerInvoice({
      tenantId,
      period,
      notes: (notes as string | null | undefined) ?? null,
      allowIncomplete: allowIncomplete === true,
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof InvoiceError) {
      switch (err.code) {
        case "invalid_period":
          res.status(400).json({ error: "tenantId and period (YYYY-MM) are required" });
          return;
        case "tenant_not_found":
          res.status(404).json({ error: "Tenant not found" });
          return;
        case "invoice_exists":
          res.status(409).json({ error: "Invoice already exists for this tenant and period", ...err.details });
          return;
        case "usage_incomplete":
          res.status(409).json({
            error: "Usage for this period is not final. Reconcile it first, or pass allowIncomplete to carry it to a later invoice.",
            code: "usage_incomplete",
            ...err.details,
          });
          return;
        case "usage_claimed":
          res.status(409).json({ error: "Usage was claimed by a concurrent invoice; retry", code: "usage_claimed" });
          return;
      }
    }
    sendServerError(res, err, "generate");
  }
});

router.get("/superadmin/invoices/:id", requireSuperadmin, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const invoice = await db.query.invoicesTable.findFirst({
      where: eq(invoicesTable.id, id),
    });
    if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }

    const lineItems = await db.select().from(invoiceLineItemsTable)
      .where(eq(invoiceLineItemsTable.invoiceId, id))
      .orderBy(desc(invoiceLineItemsTable.startedAt));

    const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, invoice.tenantId) });

    res.json({ invoice, lineItems, tenant, ...(await withAdjustments(invoice)) });
  } catch (err) {
    sendServerError(res, err, "get");
  }
});

router.post("/superadmin/invoices/:id/adjustments", requireSuperadmin, adminMutationRateLimit, async (req, res) => {
  const id = parseInt(String(req.params.id));
  const { billedAmountUsd, rawAmountUsd, reason } = req.body as { billedAmountUsd?: unknown; rawAmountUsd?: unknown; reason?: unknown };
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: "Invalid invoice id" });
    return;
  }
  if (!validAdjustmentAmount(billedAmountUsd) || (rawAmountUsd !== undefined && !validAdjustmentAmount(rawAmountUsd))) {
    res.status(400).json({ error: "billedAmountUsd (and optional rawAmountUsd) must be finite USD amounts" });
    return;
  }
  if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 500) {
    res.status(400).json({ error: "reason must be 3 to 500 characters" });
    return;
  }
  try {
    const adjustment = await addInvoiceAdjustment({
      invoiceId: id,
      billedAmountUsd,
      rawAmountUsd: rawAmountUsd as number | undefined,
      reason: reason.trim(),
      createdBy: req.userId ?? null,
    });
    if (!adjustment) { res.status(404).json({ error: "Invoice not found" }); return; }
    res.status(201).json({ adjustment });
  } catch (err) {
    sendServerError(res, err, "adjust");
  }
});

router.patch("/superadmin/invoices/:id", requireSuperadmin, adminMutationRateLimit, async (req, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const { status, notes } = req.body as { status?: string; notes?: string };

    const invoice = await db.query.invoicesTable.findFirst({ where: eq(invoicesTable.id, id) });
    if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }

    const validStatuses = ["draft", "sent", "paid", "overdue"];
    if (status && !validStatuses.includes(status)) {
      res.status(400).json({ error: "Invalid status" });
      return;
    }

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    if (status) updateData.status = status;
    if (notes !== undefined) updateData.notes = notes;
    if (status === "paid") updateData.paidAt = new Date();

    if (status === "paid" || status === "sent" || status === "draft") {
      const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, invoice.tenantId) });
      if (tenant && tenant.status === "suspended") {
        const overdueInvoices = await db.query.invoicesTable.findMany({
          where: and(eq(invoicesTable.tenantId, invoice.tenantId), eq(invoicesTable.status, "overdue")),
        });
        const remainingOverdue = overdueInvoices.filter((inv) => inv.id !== id);
        if (remainingOverdue.length === 0) {
          await db.update(tenantsTable)
            .set({ status: "active", suspendedAt: null })
            .where(eq(tenantsTable.id, invoice.tenantId));
        }
      }
    }

    const [updated] = await db.update(invoicesTable)
      .set(updateData)
      .where(eq(invoicesTable.id, id))
      .returning();

    res.json({ invoice: updated });
  } catch (err) {
    sendServerError(res, err, "update");
  }
});

router.get("/invoices", requireRole("admin", "manager"), async (req, res) => {
  try {
    const tenantId = req.tenantId!;
    const invoices = await db.select().from(invoicesTable)
      .where(eq(invoicesTable.tenantId, tenantId))
      .orderBy(desc(invoicesTable.createdAt));

    res.json({ invoices });
  } catch (err) {
    sendServerError(res, err, "tenant_list");
  }
});

/** The tenant's own usage this UTC month: settled spend, active holds and the limit. */
router.get("/usage/summary", requireRole("admin", "manager"), async (req, res) => {
  try {
    const tenantId = req.tenantId!;
    const period = billingPeriod();
    const { start, end } = periodBounds(period);
    const [state, entries] = await Promise.all([
      getBudgetState(tenantId),
      db.select().from(usageLedgerTable).where(and(
        eq(usageLedgerTable.tenantId, tenantId),
        gte(usageLedgerTable.eventAt, start),
        lt(usageLedgerTable.eventAt, end),
      )),
    ]);
    const byCategory: Record<string, { billableUsd: number; entries: number; unpricedEntries: number }> = {};
    for (const entry of entries) {
      const bucket = byCategory[entry.category] ??= { billableUsd: 0, entries: 0, unpricedEntries: 0 };
      bucket.entries += 1;
      if (entry.billableAmount == null) bucket.unpricedEntries += 1;
      else bucket.billableUsd = roundMoney(bucket.billableUsd + Number(entry.billableAmount));
    }
    res.json({
      period,
      currency: "USD",
      committedUsd: state.committedUsd,
      reservedUsd: state.reservedUsd,
      monthlyLimitUsd: state.monthlyLimitUsd,
      hardLimit: state.hardLimit,
      usagePercent: state.usagePercent,
      status: state.status,
      pendingEntries: entries.filter((entry) => entry.status === "pending").length,
      needsReconciliationEntries: entries.filter((entry) => entry.status === "needs_reconciliation").length,
      byCategory,
    });
  } catch (err) {
    sendServerError(res, err, "usage_summary");
  }
});

router.get("/invoices/:id", requireRole("admin", "manager"), async (req, res) => {
  try {
    const id = parseInt(String(req.params.id));
    const tenantId = req.tenantId!;

    const invoice = await db.query.invoicesTable.findFirst({
      where: and(eq(invoicesTable.id, id), eq(invoicesTable.tenantId, tenantId)),
    });
    if (!invoice) { res.status(404).json({ error: "Invoice not found" }); return; }

    const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });

    const lineItems = await db.select().from(invoiceLineItemsTable)
      .where(eq(invoiceLineItemsTable.invoiceId, id))
      .orderBy(desc(invoiceLineItemsTable.startedAt));

    const callCount = lineItems.filter((li) => li.callLogId != null || li.category == null).length;
    const totalMinutes = lineItems.reduce((sum, li) => sum + (li.durationSeconds ?? 0), 0) / 60;
    const { adjustments, adjustedTotalBilledCostUsd } = await withAdjustments(invoice);

    res.json({
      invoice,
      tenant: { id: tenant?.id, name: tenant?.name },
      lineItems,
      callCount,
      totalMinutes: parseFloat(totalMinutes.toFixed(2)),
      adjustments: adjustments.map(({ createdBy: _createdBy, ...rest }) => rest),
      adjustedTotalBilledCostUsd,
    });
  } catch (err) {
    sendServerError(res, err, "tenant_get");
  }
});

export default router;
