import { db } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "./logger";

export async function syncDatabase() {
  try {
    // 1. Ensure api_cost_logs exists
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "api_cost_logs" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" integer NOT NULL,
        "user_id" integer NOT NULL,
        "api_provider" text NOT NULL,
        "input_tokens" integer,
        "output_tokens" integer,
        "characters" integer,
        "minutes" real,
        "cost_usd" numeric(12, 8) DEFAULT '0' NOT NULL,
        "context" text,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    // 2. Ensure tenant_limits exists
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "tenant_limits" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" integer NOT NULL UNIQUE,
        "monthly_limit_usd" numeric(10, 2) DEFAULT '5.00' NOT NULL,
        "hard_limit" boolean DEFAULT false NOT NULL,
        "limit_alert_sent_at" timestamp,
        "alert_month" text,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    // Ensure exotel_configs exists
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "exotel_configs" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" integer NOT NULL UNIQUE REFERENCES "tenants"("id") ON DELETE CASCADE,
        "account_sid" text NOT NULL,
        "api_key" text NOT NULL,
        "api_token" text NOT NULL,
        "exophone" text NOT NULL,
        "region" text DEFAULT 'singapore' NOT NULL,
        "app_flow_url" text NOT NULL,
        "is_enabled" boolean DEFAULT false NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    // Ensure sip_trunk_configs exists
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "sip_trunk_configs" (
        "id" serial PRIMARY KEY NOT NULL,
        "tenant_id" integer NOT NULL UNIQUE REFERENCES "tenants"("id") ON DELETE CASCADE,
        "sip_domain" text NOT NULL,
        "sip_username" text NOT NULL,
        "sip_password" text NOT NULL,
        "phone_number" text NOT NULL,
        "outbound_proxy" text,
        "transport" text DEFAULT 'UDP' NOT NULL,
        "termination_uri" text,
        "is_enabled" boolean DEFAULT false NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
      );
    `);

    // Ensure external_crm_configs exists
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS "external_crm_configs" (
        "id" serial PRIMARY KEY NOT NULL,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "name" text NOT NULL,
        "is_enabled" boolean DEFAULT true NOT NULL,
        "lookup_url" text NOT NULL,
        "http_method" text DEFAULT 'GET' NOT NULL,
        "auth_type" text DEFAULT 'bearer' NOT NULL,
        "auth_value" text,
        "auth_header_name" text,
        "phone_param_name" text DEFAULT 'phone' NOT NULL,
        "phone_param_location" text DEFAULT 'query' NOT NULL,
        "response_mapping" jsonb,
        "use_raw_response" boolean DEFAULT false NOT NULL,
        "max_context_chars" integer DEFAULT 2000 NOT NULL,
        "timeout_ms" integer DEFAULT 3000 NOT NULL,
        "cache_ttl_seconds" integer DEFAULT 300 NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL,
        UNIQUE("user_id")
      );
    `);

    // 3. Add columns that might be missing from older schema versions
    const alterQueries = [
      'ALTER TABLE "api_cost_logs" ADD COLUMN IF NOT EXISTS "context" text;',
      'ALTER TABLE "api_cost_logs" ADD COLUMN IF NOT EXISTS "characters" integer;',
      'ALTER TABLE "api_cost_logs" ADD COLUMN IF NOT EXISTS "minutes" real;',
      'ALTER TABLE "api_cost_logs" ADD COLUMN IF NOT EXISTS "user_id" integer DEFAULT 0;',
      'ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "is_automatic" boolean DEFAULT false NOT NULL;',
      'ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "max_retries" integer DEFAULT 0 NOT NULL;',
      'ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "retry_interval_minutes" integer DEFAULT 10 NOT NULL;',
      'ALTER TABLE "campaign_contacts" ADD COLUMN IF NOT EXISTS "status" text DEFAULT \'pending\' NOT NULL;',
      'ALTER TABLE "campaign_contacts" ADD COLUMN IF NOT EXISTS "attempts" integer DEFAULT 0 NOT NULL;',
      'ALTER TABLE "campaign_contacts" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp;',
      'ALTER TABLE "campaign_contacts" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp;',
      'ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "dial_parallel" boolean DEFAULT false NOT NULL;',
      'ALTER TABLE "campaigns" ADD COLUMN IF NOT EXISTS "transfer_config" jsonb;',
      'ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "telephony_type" text DEFAULT \'TWILIO\' NOT NULL;',
      'ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "language_menu_config" jsonb;',
      'ALTER TABLE "external_crm_configs" ADD COLUMN IF NOT EXISTS "opening_pitch" text;',
      'ALTER TABLE "external_crm_configs" ADD COLUMN IF NOT EXISTS "ending_pitch" text;',
      'ALTER TABLE "external_crm_configs" ADD COLUMN IF NOT EXISTS "unknown_caller_pitch" text;',
      'ALTER TABLE "external_crm_configs" ADD COLUMN IF NOT EXISTS "ending_note" text;',
      'ALTER TABLE "external_crm_configs" ADD COLUMN IF NOT EXISTS "max_ai_interaction_seconds" integer DEFAULT 0 NOT NULL;',
      'ALTER TABLE "external_crm_configs" ADD COLUMN IF NOT EXISTS "ending_note_lead_seconds" integer DEFAULT 2 NOT NULL;',
      'ALTER TABLE "external_crm_configs" ADD COLUMN IF NOT EXISTS "call_instructions" text;',
      'ALTER TABLE "external_crm_configs" ADD COLUMN IF NOT EXISTS "verify_identity" boolean DEFAULT false NOT NULL;',
      'ALTER TABLE "agent_configs" ADD COLUMN IF NOT EXISTS "widget_external_crm_enabled" boolean DEFAULT false NOT NULL;',
    ];

    for (const q of alterQueries) {
      try {
        await db.execute(sql.raw(q));
      } catch (e) {
        // Ignore if column exists (though IF NOT EXISTS handles this in newer PG versions)
      }
    }

    logger.info("Database synchronized successfully (api_cost_logs, tenant_limits)");
  } catch (error) {
    logger.error({ error }, "Failed to synchronize database on startup");
  }
}
