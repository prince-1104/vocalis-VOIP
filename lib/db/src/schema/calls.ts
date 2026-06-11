import { pgTable, text, serial, timestamp, integer, numeric, real, jsonb } from "drizzle-orm/pg-core";
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

  // CRM integration fields
  crmContactId: text("crm_contact_id"),                  // CRM's own contact reference ID
  crmMetadata: jsonb("crm_metadata"),                     // opaque JSON from CRM, echoed back in events
  callSid: text("call_sid"),                              // Twilio Call SID for tracking
  conferenceSid: text("conference_sid"),                   // set if call was transferred via conference
  transferredTo: text("transferred_to"),                   // agent phone/SIP if transferred
  transferReason: text("transfer_reason"),                 // intent that triggered transfer
  transferredAt: timestamp("transferred_at"),
  liveTranscript: jsonb("live_transcript").$type<Array<{ role: string; content: string; timestamp: string }>>(),

  duration: integer("duration"),
  outcome: text("outcome"),
  transcript: text("transcript"),
  recordingUrl: text("recording_url"),
  aiSummary: text("ai_summary"),
  aiModel: text("ai_model"),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 10, scale: 6 }),
  billedCostUsd: numeric("billed_cost_usd", { precision: 10, scale: 6 }),
  twilioCostUsd: numeric("twilio_cost_usd", { precision: 10, scale: 6 }),
  openaiCostUsd: numeric("openai_cost_usd", { precision: 10, scale: 6 }), // repurposed: stores LLM+TTS cost for any provider (OpenAI, DeepSeek, Sarvam)
  twilioMinutes: real("twilio_minutes"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCallLogSchema = createInsertSchema(callLogsTable).omit({ id: true, createdAt: true });
export type InsertCallLog = z.infer<typeof insertCallLogSchema>;
export type CallLog = typeof callLogsTable.$inferSelect;
