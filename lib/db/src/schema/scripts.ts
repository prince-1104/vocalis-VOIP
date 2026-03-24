import { pgTable, text, serial, timestamp, integer, boolean, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const callingScriptsTable = pgTable("calling_scripts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  openingLine: text("opening_line").notNull(),
  pitchPoints: jsonb("pitch_points").$type<string[]>().default([]),
  closingLine: text("closing_line"),
  fullScript: text("full_script").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertCallingScriptSchema = createInsertSchema(callingScriptsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCallingScript = z.infer<typeof insertCallingScriptSchema>;
export type CallingScript = typeof callingScriptsTable.$inferSelect;
