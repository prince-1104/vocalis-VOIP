import { pgTable, text, serial, timestamp, integer, numeric, boolean, index, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tenantsTable } from "./tenants";

// ── Per-API-call cost records ──────────────────────────────────────────
// Every LLM, TTS, and STT call is logged here with exact token/char counts
// and computed cost. This enables per-tenant per-month cost aggregation.
export const apiCostLogsTable = pgTable("api_cost_logs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  // Owner user ID — maps to the userId in call_logs for cross-referencing
  userId: integer("user_id").notNull(),

  // Which API was called:
  //   llm:gpt-4o-mini, llm:deepseek-chat, llm:sarvam-m
  //   tts:sarvam, tts:openai
  //   stt:whisper
  apiProvider: text("api_provider").notNull(),

  // For LLM calls
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),

  // For TTS calls (character count)
  characters: integer("characters"),

  // For STT calls (minutes)
  minutes: real("minutes"),

  // Computed cost in USD
  costUsd: numeric("cost_usd", { precision: 12, scale: 8 }).notNull().default("0"),

  // Context: what triggered this cost (chat, tts-chunk, call, etc.)
  context: text("context"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("api_cost_logs_tenant_created_idx").on(table.tenantId, table.createdAt),
  index("api_cost_logs_provider_idx").on(table.apiProvider),
]);

// ── Tenant spending limits ─────────────────────────────────────────────
// Super admin sets a monthly USD limit per tenant. When crossed, alerts
// are triggered and optionally API calls are blocked (hard limit).
export const tenantLimitsTable = pgTable("tenant_limits", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }).unique(),

  // Monthly spending cap in USD
  monthlyLimitUsd: numeric("monthly_limit_usd", { precision: 10, scale: 2 }).notNull().default("5.00"),

  // If true, API calls are blocked once limit is exceeded
  hardLimit: boolean("hard_limit").notNull().default(false),

  // Timestamp of last alert sent to avoid spamming
  limitAlertSentAt: timestamp("limit_alert_sent_at"),

  // Which month the alert was sent for (YYYY-MM format)
  alertMonth: text("alert_month"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ── API pricing rates (configurable by super admin) ────────────────────
// Stored in platform_settings with key prefix "rate:" — but we define
// the defaults as constants for the cost calculation layer.
export const DEFAULT_API_RATES: Record<string, number> = {
  // LLM rates per 1M tokens
  "llm:gpt-4o-mini:input":     0.15,
  "llm:gpt-4o-mini:output":    0.60,
  "llm:deepseek-chat:input":   0.27,
  "llm:deepseek-chat:output":  1.10,
  "llm:sarvam-m:input":        0.15,
  "llm:sarvam-m:output":       0.60,
  // TTS rates per 1M characters
  "tts:sarvam":                3.00,
  "tts:openai":               15.00,
  // STT rate per minute
  "stt:whisper":               0.006,
};

export const insertApiCostLogSchema = createInsertSchema(apiCostLogsTable).omit({ id: true, createdAt: true });
export type InsertApiCostLog = z.infer<typeof insertApiCostLogSchema>;
export type ApiCostLog = typeof apiCostLogsTable.$inferSelect;

export const insertTenantLimitSchema = createInsertSchema(tenantLimitsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTenantLimit = z.infer<typeof insertTenantLimitSchema>;
export type TenantLimit = typeof tenantLimitsTable.$inferSelect;
