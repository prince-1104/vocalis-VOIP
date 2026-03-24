import { pgTable, text, serial, timestamp, integer } from "drizzle-orm/pg-core";
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
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCallLogSchema = createInsertSchema(callLogsTable).omit({ id: true, createdAt: true });
export type InsertCallLog = z.infer<typeof insertCallLogSchema>;
export type CallLog = typeof callLogsTable.$inferSelect;
