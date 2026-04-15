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
