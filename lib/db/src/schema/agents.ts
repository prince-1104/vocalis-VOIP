import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { campaignsTable } from "./campaigns";

export const agentConfigsTable = pgTable("agent_configs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().unique().references(() => usersTable.id, { onDelete: "cascade" }),
  agentName: text("agent_name").notNull().default("SalesBot"),
  voice: text("voice").notNull().default("nova"),
  language: text("language").default("en-US"),

  // Telephony provider (BYOC)
  telephonyProvider: text("telephony_provider").notNull().default("twilio"),
  telephonyProviderName: text("telephony_provider_name"),
  telephonyApiKey: text("telephony_api_key"),
  telephonyApiSecret: text("telephony_api_secret"),
  telephonyAppId: text("telephony_app_id"),

  phoneNumber: text("phone_number"),
  twilioAccountSid: text("twilio_account_sid"),
  twilioAuthToken: text("twilio_auth_token"),

  greeting: text("greeting"),
  personality: text("personality").notNull().default("professional"),
  maxCallDuration: integer("max_call_duration").notNull().default(10),
  voicemailMessage: text("voicemail_message"),
  aiModel: text("ai_model").notNull().default("gemini-1.5-pro"),
  businessHoursOnly: boolean("business_hours_only").notNull().default(true),

  // Web widget
  widgetEnabled: boolean("widget_enabled").notNull().default(false),
  widgetApiKey: text("widget_api_key"),
  widgetCampaignId: integer("widget_campaign_id").references(() => campaignsTable.id, { onDelete: "set null" }),
  widgetVoiceEnabled: boolean("widget_voice_enabled").notNull().default(false),

  // Twilio TwiML App for browser-based voice (Client SDK)
  twilioTwimlAppSid: text("twilio_twiml_app_sid"),

  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertAgentConfigSchema = createInsertSchema(agentConfigsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAgentConfig = z.infer<typeof insertAgentConfigSchema>;
export type AgentConfig = typeof agentConfigsTable.$inferSelect;
