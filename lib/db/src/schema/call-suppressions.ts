import { pgTable, text, serial, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Tenant-private do-not-call / opt-out list, keyed by the tenant owner like
 * contacts and campaigns. Rows are revoked, never deleted, so the time an
 * opt-out was applied stays provable.
 */
export const callSuppressionsTable = pgTable("call_suppressions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  /** Matching key: last 10 digits of the number (see call-suppression.ts). */
  phoneKey: text("phone_key").notNull(),
  /** Normalized number for display to the owning tenant. */
  phone: text("phone").notNull(),
  /** "opt_out" (the person asked) or "do_not_call" (tenant/operator list). */
  reason: text("reason").notNull(),
  /** "dashboard" | "crm_api" */
  source: text("source").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  revokedAt: timestamp("revoked_at"),
}, (table) => [
  uniqueIndex("call_suppressions_user_phone_key_unique").on(table.userId, table.phoneKey),
]);

export type CallSuppression = typeof callSuppressionsTable.$inferSelect;
