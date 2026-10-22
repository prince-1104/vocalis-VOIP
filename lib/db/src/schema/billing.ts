import { pgTable, text, serial, timestamp, integer, numeric, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { callLogsTable } from "./calls";
import { invoicesTable } from "./invoices";

export const USAGE_CATEGORIES = ["llm", "stt", "tts", "telephony"] as const;
export type UsageCategory = (typeof USAGE_CATEGORIES)[number];

/**
 *   pending               quantity may still change (call in progress)
 *   finalized             quantity and price known (measurement says actual or estimated)
 *   failed                provider request failed and is treated as not charged (amounts 0)
 *   needs_reconciliation  potentially charged but quantity, price or outcome is unknown
 */
export const USAGE_STATUSES = ["pending", "finalized", "failed", "needs_reconciliation"] as const;
export type UsageStatus = (typeof USAGE_STATUSES)[number];

/** actual: quantity reported by, or exactly sent to, the provider. estimated: inferred. unknown: not known. */
export const USAGE_MEASUREMENTS = ["actual", "estimated", "unknown"] as const;
export type UsageMeasurement = (typeof USAGE_MEASUREMENTS)[number];

// Immutable price snapshots. A row is never updated; changing a rate creates a
// new version (enforced by a trigger in migration 0008).
export const billingRateCardsTable = pgTable("billing_rate_cards", {
  id: serial("id").primaryKey(),
  version: text("version").notNull().unique(),
  currency: text("currency").notNull().default("USD"),
  rates: jsonb("rates").$type<Record<string, number>>().notNull(),
  source: text("source").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const usageLedgerTable = pgTable("usage_ledger", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull(),
  callLogId: integer("call_log_id").references(() => callLogsTable.id, { onDelete: "set null" }),
  sessionRef: text("session_ref"),
  source: text("source").notNull(),
  category: text("category").$type<UsageCategory>().notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  providerRequestId: text("provider_request_id"),
  idempotencyKey: text("idempotency_key").notNull(),
  entryType: text("entry_type").$type<"usage" | "adjustment">().notNull().default("usage"),
  adjustsEntryId: integer("adjusts_entry_id"),
  measurement: text("measurement").$type<UsageMeasurement>().notNull(),
  unit: text("unit").notNull(),
  quantity: numeric("quantity", { precision: 18, scale: 6 }),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cachedInputTokens: integer("cached_input_tokens"),
  billedUnits: numeric("billed_units", { precision: 18, scale: 6 }),
  rateCardId: integer("rate_card_id").references(() => billingRateCardsTable.id),
  rateVersion: text("rate_version"),
  currency: text("currency").notNull().default("USD"),
  providerCost: numeric("provider_cost", { precision: 14, scale: 8 }),
  providerCostCurrency: text("provider_cost_currency"),
  platformCost: numeric("platform_cost", { precision: 14, scale: 8 }),
  commissionPct: numeric("commission_pct", { precision: 5, scale: 2 }),
  billableAmount: numeric("billable_amount", { precision: 14, scale: 8 }),
  // Amount currently counted against the tenant's spend limit for this row.
  budgetAmount: numeric("budget_amount", { precision: 14, scale: 8 }).notNull().default("0"),
  status: text("status").$type<UsageStatus>().notNull(),
  statusReason: text("status_reason"),
  invoiceId: integer("invoice_id").references(() => invoicesTable.id, { onDelete: "set null" }),
  metadata: jsonb("metadata").$type<Record<string, string | number | boolean | null>>(),
  revision: integer("revision").notNull().default(0),
  eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  finalizedAt: timestamp("finalized_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("usage_ledger_tenant_idempotency_idx").on(table.tenantId, table.idempotencyKey),
  index("usage_ledger_tenant_event_idx").on(table.tenantId, table.eventAt),
  index("usage_ledger_call_log_idx").on(table.callLogId),
  index("usage_ledger_status_idx").on(table.status),
  index("usage_ledger_invoice_idx").on(table.invoiceId),
]);

// Per-tenant, per-UTC-month spend counters. Reservations lock this row.
export const tenantBudgetPeriodsTable = pgTable("tenant_budget_periods", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  period: text("period").notNull(),
  currency: text("currency").notNull().default("USD"),
  committedAmount: numeric("committed_amount", { precision: 14, scale: 8 }).notNull().default("0"),
  reservedAmount: numeric("reserved_amount", { precision: 14, scale: 8 }).notNull().default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("tenant_budget_periods_tenant_period_idx").on(table.tenantId, table.period),
]);

export const budgetReservationsTable = pgTable("budget_reservations", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  period: text("period").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  source: text("source").notNull(),
  callLogId: integer("call_log_id").references(() => callLogsTable.id, { onDelete: "set null" }),
  amount: numeric("amount", { precision: 14, scale: 8 }).notNull(),
  status: text("status").$type<"held" | "released">().notNull().default("held"),
  releaseReason: text("release_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("budget_reservations_tenant_key_idx").on(table.tenantId, table.idempotencyKey),
  index("budget_reservations_held_idx").on(table.tenantId, table.status, table.expiresAt),
  index("budget_reservations_call_log_idx").on(table.callLogId),
]);

// Corrections to an issued invoice; the invoice row itself is never rewritten.
export const invoiceAdjustmentsTable = pgTable("invoice_adjustments", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoicesTable.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  rawAmountUsd: numeric("raw_amount_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  billedAmountUsd: numeric("billed_amount_usd", { precision: 10, scale: 6 }).notNull(),
  reason: text("reason").notNull(),
  createdBy: integer("created_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UsageLedgerEntry = typeof usageLedgerTable.$inferSelect;
export type BudgetReservation = typeof budgetReservationsTable.$inferSelect;
export type BillingRateCard = typeof billingRateCardsTable.$inferSelect;
export type InvoiceAdjustment = typeof invoiceAdjustmentsTable.$inferSelect;
