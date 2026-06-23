import { pgTable, text, serial, timestamp, integer, boolean, numeric, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const tenantsTable = pgTable("tenants", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  status: text("status").notNull().default("active"),
  commissionPct: numeric("commission_pct", { precision: 5, scale: 2 }).notNull().default("0"),
  paymentTermsDays: integer("payment_terms_days").notNull().default(30),
  suspendedAt: timestamp("suspended_at"),
  ownerId: integer("owner_id").references(() => usersTable.id),
  telephonyType: text("telephony_type").notNull().default("TWILIO"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const tenantUsersTable = pgTable("tenant_users", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("manager"),
  email: text("email").notNull(),
  name: text("name"),
  passwordHash: text("password_hash"),
  phone: text("phone"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => [
  uniqueIndex("tenant_users_tenant_email_unique").on(table.tenantId, table.email),
]);

export const tenantSessionsTable = pgTable("tenant_sessions", {
  id: serial("id").primaryKey(),
  tenantUserId: integer("tenant_user_id").notNull().references(() => tenantUsersTable.id, { onDelete: "cascade" }),
  tenantId: integer("tenant_id").notNull().references(() => tenantsTable.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  revokedAt: timestamp("revoked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTenantSchema = createInsertSchema(tenantsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTenant = z.infer<typeof insertTenantSchema>;
export type Tenant = typeof tenantsTable.$inferSelect;

export const insertTenantUserSchema = createInsertSchema(tenantUsersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTenantUser = z.infer<typeof insertTenantUserSchema>;
export type TenantUser = typeof tenantUsersTable.$inferSelect;

export const insertTenantSessionSchema = createInsertSchema(tenantSessionsTable).omit({ id: true, createdAt: true });
export type InsertTenantSession = z.infer<typeof insertTenantSessionSchema>;
export type TenantSession = typeof tenantSessionsTable.$inferSelect;

export const sipTrunkConfigsTable = pgTable("sip_trunk_configs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().unique().references(() => tenantsTable.id, { onDelete: "cascade" }),
  sipDomain: text("sip_domain").notNull(),
  sipUsername: text("sip_username").notNull(),
  sipPassword: text("sip_password").notNull(),
  phoneNumber: text("phone_number").notNull(),
  outboundProxy: text("outbound_proxy"),
  transport: text("transport").notNull().default("UDP"),
  terminationUri: text("termination_uri"),
  isEnabled: boolean("is_enabled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSipTrunkConfigSchema = createInsertSchema(sipTrunkConfigsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSipTrunkConfig = z.infer<typeof insertSipTrunkConfigSchema>;
export type SipTrunkConfig = typeof sipTrunkConfigsTable.$inferSelect;

/** Per-tenant Exotel credentials (superadmin-managed). */
export const exotelConfigsTable = pgTable("exotel_configs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().unique().references(() => tenantsTable.id, { onDelete: "cascade" }),
  accountSid: text("account_sid").notNull(),
  apiKey: text("api_key").notNull(),
  apiToken: text("api_token").notNull(),
  exophone: text("exophone").notNull(),
  /** singapore → api.exotel.com, mumbai → api.in.exotel.com */
  region: text("region").notNull().default("singapore"),
  /** ExoML flow URL, e.g. http://my.exotel.com/{sid}/exoml/start_voice/{app_id} */
  appFlowUrl: text("app_flow_url").notNull(),
  isEnabled: boolean("is_enabled").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertExotelConfigSchema = createInsertSchema(exotelConfigsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertExotelConfig = z.infer<typeof insertExotelConfigSchema>;
export type ExotelConfig = typeof exotelConfigsTable.$inferSelect;
