import { pgTable, text, integer, bigint, timestamp, primaryKey, index } from "drizzle-orm/pg-core";

// Shared request counters for API rate limiting. bucket_key is a keyed hash of
// the policy and identity (IP, principal, tenant, API key, account); it never
// contains raw addresses, emails, phone numbers or tokens.
export const rateLimitCountersTable = pgTable("rate_limit_counters", {
  bucketKey: text("bucket_key").notNull(),
  /** Window start, epoch milliseconds. */
  windowStart: bigint("window_start", { mode: "number" }).notNull(),
  hits: integer("hits").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.bucketKey, table.windowStart] }),
  index("rate_limit_counters_expires_idx").on(table.expiresAt),
]);
