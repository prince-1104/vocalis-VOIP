import { pgTable, serial, integer, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";
import { z } from "zod/v4";

// Local input limits, not claims about provider-assigned credential formats.
const credential = (max: number) => z.string().min(1).max(max)
  .refine(value => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value));
export const vobizSipInputSchema = z.object({
  // The documented trunk-specific host, not a URL, SIP URI or shared gateway.
  sipDomain: z.string().max(253).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.sip\.vobiz\.ai$/i).transform(value => value.toLowerCase()),
  sipUsername: credential(256),
  sipPassword: credential(4096),
  phoneNumbers: z.array(z.string().regex(/^\+[1-9][0-9]{1,14}$/)).min(1).max(100)
    .refine(numbers => new Set(numbers).size === numbers.length),
}).strict();

/** Plaintext server input only; never serialize this as an API response/log. */
export type VobizSipConfiguration = z.infer<typeof vobizSipInputSchema>;

// Separate from the existing Twilio-mediated SIP configuration. Saving this
// record never selects a provider or enables call execution.
export const vobizSipConfigsTable = pgTable("vobiz_sip_configs", {
  id: serial("id").primaryKey(),
  tenantId: integer("tenant_id").notNull().unique().references(() => tenantsTable.id, { onDelete: "cascade" }),
  sipDomain: text("sip_domain").notNull(),
  sipUsername: text("sip_username").notNull(), // authenticated ciphertext
  sipPassword: text("sip_password").notNull(), // authenticated ciphertext
  phoneNumbers: jsonb("phone_numbers").$type<string[]>().notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type VobizSipConfig = typeof vobizSipConfigsTable.$inferSelect;
