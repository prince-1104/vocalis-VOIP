import { pgTable, text, serial, timestamp, integer, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { tenantsTable } from "./tenants";
import { callLogsTable } from "./calls";

// ── CRM API Keys ───────────────────────────────────────────────────────
// Server-to-server authentication for external CRM systems.
// The CRM sends `Authorization: Bearer dk_live_xxxx` — Dialog hashes the
// key with SHA-256, looks up this table, and resolves userId/tenantId.
export const crmApiKeysTable = pgTable("crm_api_keys", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  keyHash: text("key_hash").notNull().unique(),       // SHA-256 of the full API key
  keyPrefix: text("key_prefix").notNull(),             // first 8 chars for UI display / identification
  name: text("name").notNull(),                        // human label: "Production CRM", "Staging"
  scopes: jsonb("scopes").$type<string[]>().default(["calls:read", "calls:write"]),
  webhookUrl: text("webhook_url"),                     // CRM's webhook endpoint for events
  webhookSecret: text("webhook_secret"),               // HMAC-SHA256 secret for signing payloads
  isActive: boolean("is_active").notNull().default(true),
  lastUsedAt: timestamp("last_used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("crm_api_keys_user_idx").on(table.userId),
  index("crm_api_keys_tenant_idx").on(table.tenantId),
]);

// ── CRM Agent Registry ─────────────────────────────────────────────────
// Specialized agents on the CRM side that can receive transferred calls.
// Each agent is mapped to specific intents so the transfer manager knows
// who should handle a "pricing_query" vs a "complaint".
export const crmAgentsTable = pgTable("crm_agents", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  crmAgentId: text("crm_agent_id").notNull(),          // CRM's own agent identifier
  name: text("name").notNull(),
  specialization: text("specialization"),               // "billing", "technical", "sales_closer"
  phone: text("phone"),                                 // agent's phone for PSTN transfer
  sipUri: text("sip_uri"),                              // optional SIP URI
  intents: jsonb("intents").$type<string[]>().default([]), // which intents route here
  isAvailable: boolean("is_available").notNull().default(true),
  maxConcurrentCalls: integer("max_concurrent_calls").notNull().default(3),
  currentCalls: integer("current_calls").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  index("crm_agents_user_idx").on(table.userId),
  uniqueIndex("crm_agents_user_crm_id_unique").on(table.userId, table.crmAgentId),
]);

// ── Webhook Deliveries ─────────────────────────────────────────────────
// Tracks every webhook event sent to the CRM. Supports retries (3 attempts
// with exponential backoff). Failed deliveries are kept for debugging.
export const webhookDeliveriesTable = pgTable("webhook_deliveries", {
  id: serial("id").primaryKey(),
  apiKeyId: integer("api_key_id").notNull().references(() => crmApiKeysTable.id, { onDelete: "cascade" }),
  callId: integer("call_id").references(() => callLogsTable.id, { onDelete: "set null" }),
  event: text("event").notNull(),                       // "call.ended", "call.turn", "call.transferred", etc.
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"),   // "pending" | "delivered" | "failed"
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  lastAttemptAt: timestamp("last_attempt_at"),
  responseStatus: integer("response_status"),            // HTTP status from CRM's webhook endpoint
  responseBody: text("response_body"),                   // first 500 chars of response for debugging
  nextRetryAt: timestamp("next_retry_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("webhook_deliveries_api_key_idx").on(table.apiKeyId),
  index("webhook_deliveries_status_retry_idx").on(table.status, table.nextRetryAt),
  index("webhook_deliveries_call_idx").on(table.callId),
]);

// ── Zod schemas & types ────────────────────────────────────────────────
export const insertCrmApiKeySchema = createInsertSchema(crmApiKeysTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCrmApiKey = z.infer<typeof insertCrmApiKeySchema>;
export type CrmApiKey = typeof crmApiKeysTable.$inferSelect;

export const insertCrmAgentSchema = createInsertSchema(crmAgentsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCrmAgent = z.infer<typeof insertCrmAgentSchema>;
export type CrmAgent = typeof crmAgentsTable.$inferSelect;

export const insertWebhookDeliverySchema = createInsertSchema(webhookDeliveriesTable).omit({ id: true, createdAt: true });
export type InsertWebhookDelivery = z.infer<typeof insertWebhookDeliverySchema>;
export type WebhookDelivery = typeof webhookDeliveriesTable.$inferSelect;
