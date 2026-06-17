import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const campaignsTable = pgTable("campaigns", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  status: text("status").notNull().default("draft"),
  scriptId: integer("script_id"),
  totalContacts: integer("total_contacts").notNull().default(0),
  calledCount: integer("called_count").notNull().default(0),
  answeredCount: integer("answered_count").notNull().default(0),
  interestedCount: integer("interested_count").notNull().default(0),
  startTime: text("start_time").default("09:00"),
  endTime: text("end_time").default("17:00"),
  timezone: text("timezone").default("America/New_York"),
  maxConcurrentCalls: integer("max_concurrent_calls").notNull().default(1),
  dialParallel: boolean("dial_parallel").notNull().default(false),
  isAutomatic: boolean("is_automatic").notNull().default(false),
  maxRetries: integer("max_retries").notNull().default(0),
  retryIntervalMinutes: integer("retry_interval_minutes").notNull().default(10),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const campaignContactsTable = pgTable("campaign_contacts", {
  id: serial("id").primaryKey(),
  campaignId: integer("campaign_id").notNull().references(() => campaignsTable.id, { onDelete: "cascade" }),
  contactId: integer("contact_id").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at"),
  nextAttemptAt: timestamp("next_attempt_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertCampaignSchema = createInsertSchema(campaignsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaignsTable.$inferSelect;
