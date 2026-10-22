import { pgTable, text, integer, timestamp } from "drizzle-orm/pg-core";
import { callLogsTable } from "./calls";
import { tenantsTable } from "./tenants";
import { usersTable } from "./users";

// Security state is deliberately separate from customer-facing CRM metadata.
export const callMediaSessionsTable = pgTable("call_media_sessions", {
  id: text("id").primaryKey(),
  credentialHash: text("credential_hash").notNull(),
  callLogId: integer("call_log_id")
    .notNull()
    .unique()
    .references(() => callLogsTable.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  accountSid: text("account_sid").notNull(),
  callSid: text("call_sid").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  state: text("state").notNull().default("pending"),
  streamSid: text("stream_sid"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  closedAt: timestamp("closed_at", { withTimezone: true }),
});
