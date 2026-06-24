import { pgTable, text, serial, timestamp, integer, boolean, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export interface ExternalCrmResponseMapping {
  customerName?: string;
  email?: string;
  accountId?: string;
  recentOrders?: string;
  customFields?: string[];
}

export const externalCrmConfigsTable = pgTable("external_crm_configs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isEnabled: boolean("is_enabled").notNull().default(true),

  lookupUrl: text("lookup_url").notNull(),
  httpMethod: text("http_method").notNull().default("GET"),
  authType: text("auth_type").notNull().default("bearer"),
  authValue: text("auth_value"),
  authHeaderName: text("auth_header_name"),

  phoneParamName: text("phone_param_name").notNull().default("phone"),
  phoneParamLocation: text("phone_param_location").notNull().default("query"),

  responseMapping: jsonb("response_mapping").$type<ExternalCrmResponseMapping>(),

  useRawResponse: boolean("use_raw_response").notNull().default(false),
  maxContextChars: integer("max_context_chars").notNull().default(2000),

  timeoutMs: integer("timeout_ms").notNull().default(3000),
  cacheTtlSeconds: integer("cache_ttl_seconds").notNull().default(300),

  // Inbound call flow when CRM is connected
  openingPitch: text("opening_pitch"),
  endingPitch: text("ending_pitch"),
  unknownCallerPitch: text("unknown_caller_pitch"),
  endingNote: text("ending_note"),
  maxAiInteractionSeconds: integer("max_ai_interaction_seconds").notNull().default(0),
  endingNoteLeadSeconds: integer("ending_note_lead_seconds").notNull().default(2),
  callInstructions: text("call_instructions"),
  verifyIdentity: boolean("verify_identity").notNull().default(false),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("external_crm_configs_user_unique").on(table.userId),
  index("external_crm_configs_user_idx").on(table.userId),
]);

export const insertExternalCrmConfigSchema = createInsertSchema(externalCrmConfigsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertExternalCrmConfig = z.infer<typeof insertExternalCrmConfigSchema>;
export type ExternalCrmConfig = typeof externalCrmConfigsTable.$inferSelect;
