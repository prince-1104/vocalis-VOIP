import { Router, type IRouter } from "express";
import { db, invoicesTable, invoiceLineItemsTable, callLogsTable, tenantsTable } from "@workspace/db";
import { eq, and, gte, lt, desc, sql } from "drizzle-orm";
import { requireSuperadmin, resolveUser, requireRole } from "../middleware/auth";

const router: IRouter = Router();

function periodBounds(period: string): { start: Date; end: Date } {
  const [year, month] = period.split("-").map(Number);
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 1);
  return { start, end };
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
      await db.update(invoicesTable)
        .set({ status: "overdue", updatedAt: new Date() })
        .where(eq(invoicesTable.id, invoice.id));

      await db.update(tenantsTable)
        .set({ status: "suspended", suspendedAt: new Date() })
        .where(eq(tenantsTable.id, invoice.tenantId));
    }
  }
}

router.use(resolveUser);

router.get("/admin/invoices", requireSuperadmin, async (req, res) => {
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
        createdAt: invoicesTable.createdAt,
        updatedAt: invoicesTable.updatedAt,
      })
      .from(invoicesTable)
      .leftJoin(tenantsTable, eq(invoicesTable.tenantId, tenantsTable.id))
      .orderBy(desc(invoicesTable.createdAt));

    res.json({ invoices });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.post("/admin/invoices/generate", requireSuperadmin, async (req, res) => {
  try {
    const { tenantId, period, notes } = req.body as {
      tenantId: number;
      period: string;
      notes?: string;
    };

    if (!tenantId || !period || !/^\d{4}-\d{2}$/.test(period)) {
      res.status(400).json({ error: "tenantId and period (YYYY-MM) are required" });
      return;
    }

    const existing = await db.query.invoicesTable.findFirst({
      where: and(eq(invoicesTable.tenantId, tenantId), eq(invoicesTable.period, period)),
    });
    if (existing) {
      res.status(409).json({ error: "Invoice already exists for this tenant and period", invoiceId: existing.id });
      return;
    }

    const tenant = await db.query.tenantsTable.findFirst({ where: eq(tenantsTable.id, tenantId) });
    if (!tenant || !tenant.ownerId) {
      res.status(404).json({ error: "Tenant not found" });
      return;
    }

    const commissionPct = parseFloat(tenant.commissionPct ?? "0");
    const { start, end } = periodBounds(period);

    const calls = await db.select().from(callLogsTable)
      .where(and(
        eq(callLogsTable.userId, tenant.ownerId),
        gte(callLogsTable.startedAt, start),
        lt(callLogsTable.startedAt, end),
      ));

    const totalRawCost = calls.reduce((sum, c) => sum + parseFloat(c.estimatedCostUsd ?? "0"), 0);

    const totalBilledCost = calls.reduce((sum, c) => {
      const rawCost = parseFloat(c.estimatedCostUsd ?? "0");
      if (c.billedCostUsd !== null && c.billedCostUsd !== undefined) {
        return sum + parseFloat(c.billedCostUsd);
      }
      return sum + rawCost * (1 + commissionPct / 100);
    }, 0);

    const commissionUsd = totalBilledCost - totalRawCost;

    const paymentTermsDays = tenant.paymentTermsDays ?? 30;
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + paymentTermsDays);

    const [invoice] = await db.insert(invoicesTable).values({
      tenantId,
      period,
      totalRawCostUsd: totalRawCost.toFixed(6),
      totalBilledCostUsd: totalBilledCost.toFixed(6),
      commissionUsd: commissionUsd.toFixed(6),
      commissionPct: commissionPct.toFixed(2),
      status: "draft",
      dueDate,
      notes: notes || null,
    }).returning();

    if (calls.length > 0) {
      await db.insert(invoiceLineItemsTable).values(
        calls.map((c) => {
          const raw = parseFloat(c.estimatedCostUsd ?? "0");
          const billed = c.billedCostUsd !== null && c.billedCostUsd !== undefined
            ? parseFloat(c.billedCostUsd)
            : raw * (1 + commissionPct / 100);
          return {
            invoiceId: invoice.id,
            callLogId: c.id,
            rawCostUsd: raw.toFixed(6),
            billedCostUsd: billed.toFixed(6),
            durationSeconds: c.duration,
            phone: c.phone,
            startedAt: c.startedAt,
          };
        })
      );
    }

    res.status(201).json({ invoice, callCount: calls.length });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.get("/admin/invoices/:id", requireSuperadmin, async (req, res) => {
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

    res.json({ invoice, lineItems, tenant });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

router.patch("/admin/invoices/:id", requireSuperadmin, async (req, res) => {
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
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
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
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
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

    const callCount = lineItems.length;
    const totalMinutes = lineItems.reduce((sum, li) => sum + (li.durationSeconds ?? 0), 0) / 60;

    res.json({
      invoice,
      tenant: { id: tenant?.id, name: tenant?.name },
      lineItems,
      callCount,
      totalMinutes: parseFloat(totalMinutes.toFixed(2)),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: msg });
  }
});

export default router;
