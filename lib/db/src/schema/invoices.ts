import { pgTable, text, serial, timestamp, integer, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";
import { callLogsTable } from "./calls";

export const invoicesTable = pgTable("invoices", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  period: text("period").notNull(),
  totalRawCostUsd: numeric("total_raw_cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  totalBilledCostUsd: numeric("total_billed_cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  commissionUsd: numeric("commission_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  commissionPct: numeric("commission_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  status: text("status").notNull().default("draft"),
  dueDate: timestamp("due_date"),
  paidAt: timestamp("paid_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const invoiceLineItemsTable = pgTable("invoice_line_items", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoicesTable.id, { onDelete: "cascade" }),
  callLogId: integer("call_log_id").references(() => callLogsTable.id, { onDelete: "set null" }),
  rawCostUsd: numeric("raw_cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  billedCostUsd: numeric("billed_cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  durationSeconds: integer("duration_seconds"),
  phone: text("phone"),
  startedAt: timestamp("started_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertInvoiceSchema = createInsertSchema(invoicesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertInvoice = z.infer<typeof insertInvoiceSchema>;
export type Invoice = typeof invoicesTable.$inferSelect;
export type InvoiceLineItem = typeof invoiceLineItemsTable.$inferSelect;
