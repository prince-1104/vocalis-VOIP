import { pgTable, text, serial, timestamp, integer, boolean, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

// ── Intent Training ────────────────────────────────────────────────────
// Per-intent training data and transfer configuration.
// When the AI detects a caller's intent (e.g. "pricing_query"), it looks up
// the matching row here and injects `trainingContent` into the prompt so the
// AI can answer from trained knowledge. Transfer only happens after the AI
// exhausts its ability (maxTurns reached, or caller explicitly asks for human).

export const intentTrainingTable = pgTable("intent_training", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  intent: text("intent").notNull(),                         // "pricing_query", "complaint", etc.
  trainingContent: text("training_content").notNull(),      // product info, FAQ answers, scripts for this intent
  maxTurns: integer("max_turns").notNull().default(8),      // max AI turns before auto-transfer for this intent
  autoTransfer: boolean("auto_transfer").notNull().default(true), // whether to auto-transfer for this intent
  transferTo: text("transfer_to"),                          // override phone number for this intent's transfers
  crmAgentId: text("crm_agent_id"),                         // override CRM agent for this intent's transfers
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("intent_training_user_intent_unique").on(table.userId, table.intent),
  index("intent_training_user_idx").on(table.userId),
]);

export const insertIntentTrainingSchema = createInsertSchema(intentTrainingTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertIntentTraining = z.infer<typeof insertIntentTrainingSchema>;
export type IntentTraining = typeof intentTrainingTable.$inferSelect;
