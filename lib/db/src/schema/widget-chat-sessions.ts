import { pgTable, text, serial, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export interface WidgetChatTranscriptEntry {
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: string;
}

export const widgetChatSessionsTable = pgTable("widget_chat_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  phone: text("phone").notNull(),
  orderId: text("order_id").notNull(),
  customerName: text("customer_name"),
  transcript: jsonb("transcript").$type<WidgetChatTranscriptEntry[]>().notNull().default([]),
  lastSyncedAt: timestamp("last_synced_at"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("widget_chat_sessions_session_id_unique").on(table.sessionId),
  index("widget_chat_sessions_user_phone_idx").on(table.userId, table.phone),
  index("widget_chat_sessions_user_order_idx").on(table.userId, table.orderId),
]);

export type WidgetChatSession = typeof widgetChatSessionsTable.$inferSelect;
