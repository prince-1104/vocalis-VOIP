import { pgTable, serial, text, integer, boolean, timestamp, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tenantsTable, tenantUsersTable } from "./tenants";
import { usersTable } from "./users";
import { agentConfigsTable } from "./agents";

// Public-widget verification state. Codes and session credentials are stored
// only as keyed hashes; nothing here is ever serialized to the browser.
export const widgetVerificationChallengesTable = pgTable("widget_verification_challenges", {
  id: text("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  agentConfigId: integer("agent_config_id")
    .notNull()
    .references(() => agentConfigsTable.id, { onDelete: "cascade" }),
  widgetKeyHash: text("widget_key_hash").notNull(),
  phone: text("phone").notNull(),
  destinationHash: text("destination_hash").notNull(),
  sourceHash: text("source_hash").notNull(),
  codeHash: text("code_hash").notNull(),
  method: text("method").notNull().default("sms_otp"),
  policyVersion: integer("policy_version").notNull().default(0),
  eligible: boolean("eligible"),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  resendCount: integer("resend_count").notNull().default(0),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
}, (table) => [
  index("widget_verification_challenges_destination_idx").on(table.tenantId, table.destinationHash, table.createdAt),
  index("widget_verification_challenges_source_idx").on(table.tenantId, table.sourceHash, table.createdAt),
  index("widget_verification_challenges_tenant_idx").on(table.tenantId, table.createdAt),
]);

export const widgetCustomerSessionsTable = pgTable("widget_customer_sessions", {
  id: text("id").primaryKey(),
  tokenHash: text("token_hash").notNull(),
  challengeId: text("challenge_id")
    .notNull()
    .references(() => widgetVerificationChallengesTable.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  ownerId: integer("owner_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  agentConfigId: integer("agent_config_id")
    .notNull()
    .references(() => agentConfigsTable.id, { onDelete: "cascade" }),
  widgetKeyHash: text("widget_key_hash").notNull(),
  phone: text("phone").notNull(),
  method: text("method").notNull().default("sms_otp"),
  policyVersion: integer("policy_version").notNull().default(0),
  // "order": limited to activeOrderId; "customer": any order owned by phone.
  scope: text("scope").notNull().default("customer"),
  activeOrderId: text("active_order_id"),
  state: text("state").notNull().default("active"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("widget_customer_sessions_token_hash_unique").on(table.tokenHash),
  uniqueIndex("widget_customer_sessions_challenge_id_unique").on(table.challengeId),
]);

// One verification policy per tenant. Absence of a row, or enabled = false,
// means no customer-specific CRM data is reachable from the public widget.
export const widgetVerificationPoliciesTable = pgTable("widget_verification_policies", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  method: text("method").notNull().default("order_suffix_4"),
  dobFieldPath: text("dob_field_path"),
  dobFormat: text("dob_format"),
  version: integer("version").notNull().default(1),
  updatedByTenantUserId: integer("updated_by_tenant_user_id")
    .references(() => tenantUsersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("widget_verification_policies_tenant_id_unique").on(table.tenantId),
  check(
    "widget_verification_policies_method_check",
    sql`${table.method} in ('order_suffix_4', 'order_suffix_6', 'date_of_birth', 'sms_otp')`,
  ),
  check(
    "widget_verification_policies_dob_format_check",
    sql`${table.dobFormat} is null or ${table.dobFormat} in ('YYYY-MM-DD', 'DD-MM-YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY')`,
  ),
  check(
    "widget_verification_policies_dob_config_check",
    sql`${table.method} <> 'date_of_birth' or (${table.dobFieldPath} is not null and ${table.dobFormat} is not null)`,
  ),
  check("widget_verification_policies_version_check", sql`${table.version} >= 1`),
]);

export type WidgetVerificationChallenge = typeof widgetVerificationChallengesTable.$inferSelect;
export type WidgetVerificationPolicy = typeof widgetVerificationPoliciesTable.$inferSelect;
export type WidgetCustomerSession = typeof widgetCustomerSessionsTable.$inferSelect;
