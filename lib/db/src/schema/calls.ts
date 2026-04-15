import { pgTable, text, serial, timestamp, integer, numeric, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const callLogsTable = pgTable("call_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id"),
  campaignId: integer("campaign_id"),
  direction: text("direction").notNull().default("outbound"),
  phone: text("phone").notNull(),
  duration: integer("duration"),
  outcome: text("outcome"),
  transcript: text("transcript"),
  recordingUrl: text("recording_url"),
  aiSummary: text("ai_summary"),
  aiModel: text("ai_model"),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 10, scale: 6 }),
  twilioCostUsd: numeric("twilio_cost_usd", { precision: 10, scale: 6 }),
  openaiCostUsd: numeric("openai_cost_usd", { precision: 10, scale: 6 }),
  twilioMinutes: real("twilio_minutes"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCallLogSchema = createInsertSchema(callLogsTable).omit({ id: true, createdAt: true });
export type InsertCallLog = z.infer<typeof insertCallLogSchema>;
export type CallLog = typeof callLogsTable.$inferSelect;
