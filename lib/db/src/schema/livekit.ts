import { sql } from "drizzle-orm";
import { pgTable, text, integer, timestamp, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { tenantsTable, tenantUsersTable, tenantSessionsTable } from "./tenants";
import { usersTable } from "./users";
import { callLogsTable } from "./calls";

export const livekitTrunksTable = pgTable("livekit_trunks", {
  id: text("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  provider: text("provider").notNull(),
  trunkId: text("trunk_id").notNull().unique(),
  dispatchRuleId: text("dispatch_rule_id"),
  state: text("state").notNull().default("unverified"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const livekitSessionsTable = pgTable("livekit_sessions", {
  id: text("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id),
  ownerId: integer("owner_id").notNull().references(() => usersTable.id),
  memberId: integer("member_id").notNull().references(() => tenantUsersTable.id),
  authSessionId: integer("auth_session_id").notNull().references(() => tenantSessionsTable.id),
  callLogId: integer("call_log_id").references(() => callLogsTable.id),
  mode: text("mode").notNull(),
  room: text("room").notNull().unique(),
  participant: text("participant").notNull().unique(),
  state: text("state").notNull().default("pending"),
  workerId: text("worker_id"),
  claimHash: text("claim_hash"),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  admissionUntil: timestamp("admission_until", { withTimezone: true }).notNull(),
  activeUntil: timestamp("active_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, t => [uniqueIndex("livekit_one_preview_per_tenant").on(t.tenantId).where(sql`${t.callLogId} is null and ${t.state} in ('pending','active')`)]);

export const livekitOperationsTable = pgTable("livekit_operations", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull().references(() => livekitSessionsTable.id),
  kind: text("kind").notNull(),
  state: text("state").notNull(),
  providerId: text("provider_id"),
  details: jsonb("details").$type<Record<string, string | number | boolean>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
