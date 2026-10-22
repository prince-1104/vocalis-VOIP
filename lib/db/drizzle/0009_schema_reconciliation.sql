-- Brings every installation to the shape of src/schema without assuming how it
-- was built: from migrations 0000-0008 (which lack the objects below), from
-- `drizzle-kit push` (which lacks 0008's CHECK constraints and trigger), or with
-- the former startup db-sync DDL (whose constraint names differ). Every
-- statement is a no-op where the object already exists; nothing is dropped,
-- renamed or backfilled beyond column defaults.
ALTER TABLE "public"."tenants" ADD COLUMN IF NOT EXISTS "telephony_type" text DEFAULT 'TWILIO' NOT NULL;--> statement-breakpoint
ALTER TABLE "public"."tenant_users" ADD COLUMN IF NOT EXISTS "phone" text;--> statement-breakpoint
ALTER TABLE "public"."agent_configs" ADD COLUMN IF NOT EXISTS "language_menu_config" jsonb;--> statement-breakpoint
ALTER TABLE "public"."agent_configs" ADD COLUMN IF NOT EXISTS "widget_external_crm_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."exotel_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"account_sid" text NOT NULL,
	"api_key" text NOT NULL,
	"api_token" text NOT NULL,
	"exophone" text NOT NULL,
	"region" text DEFAULT 'singapore' NOT NULL,
	"app_flow_url" text NOT NULL,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "exotel_configs_tenant_id_unique" UNIQUE("tenant_id"),
	CONSTRAINT "exotel_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."sip_trunk_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"tenant_id" integer NOT NULL,
	"sip_domain" text NOT NULL,
	"sip_username" text NOT NULL,
	"sip_password" text NOT NULL,
	"phone_number" text NOT NULL,
	"outbound_proxy" text,
	"transport" text DEFAULT 'UDP' NOT NULL,
	"termination_uri" text,
	"is_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "sip_trunk_configs_tenant_id_unique" UNIQUE("tenant_id"),
	CONSTRAINT "sip_trunk_configs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."external_crm_configs" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
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
	"opening_pitch" text,
	"ending_pitch" text,
	"unknown_caller_pitch" text,
	"ending_note" text,
	"max_ai_interaction_seconds" integer DEFAULT 0 NOT NULL,
	"ending_note_lead_seconds" integer DEFAULT 2 NOT NULL,
	"call_instructions" text,
	"verify_identity" boolean DEFAULT false NOT NULL,
	"widget_chat_webhook_url" text,
	"widget_chat_sync_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "external_crm_configs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public"."widget_chat_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"session_id" text NOT NULL,
	"phone" text NOT NULL,
	"order_id" text NOT NULL,
	"customer_name" text,
	"transcript" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_synced_at" timestamp,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "widget_chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);--> statement-breakpoint
-- Columns the former startup db-sync added to tables created by older builds.
ALTER TABLE "public"."external_crm_configs" ADD COLUMN IF NOT EXISTS "opening_pitch" text;--> statement-breakpoint
ALTER TABLE "public"."external_crm_configs" ADD COLUMN IF NOT EXISTS "ending_pitch" text;--> statement-breakpoint
ALTER TABLE "public"."external_crm_configs" ADD COLUMN IF NOT EXISTS "unknown_caller_pitch" text;--> statement-breakpoint
ALTER TABLE "public"."external_crm_configs" ADD COLUMN IF NOT EXISTS "ending_note" text;--> statement-breakpoint
ALTER TABLE "public"."external_crm_configs" ADD COLUMN IF NOT EXISTS "max_ai_interaction_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "public"."external_crm_configs" ADD COLUMN IF NOT EXISTS "ending_note_lead_seconds" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "public"."external_crm_configs" ADD COLUMN IF NOT EXISTS "call_instructions" text;--> statement-breakpoint
ALTER TABLE "public"."external_crm_configs" ADD COLUMN IF NOT EXISTS "verify_identity" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "public"."external_crm_configs" ADD COLUMN IF NOT EXISTS "widget_chat_webhook_url" text;--> statement-breakpoint
ALTER TABLE "public"."external_crm_configs" ADD COLUMN IF NOT EXISTS "widget_chat_sync_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- An existing single-column unique constraint or index (db-sync named them
-- *_key) already enforces these; a second unique index is not added.
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
		WHERE i.indrelid = 'external_crm_configs'::regclass AND i.indisunique AND i.indnatts = 1 AND i.indpred IS NULL AND a.attname = 'user_id'
	) THEN
		CREATE UNIQUE INDEX "external_crm_configs_user_unique" ON "external_crm_configs" USING btree ("user_id");
	END IF;
	IF NOT EXISTS (
		SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
		WHERE i.indrelid = 'widget_chat_sessions'::regclass AND i.indisunique AND i.indnatts = 1 AND i.indpred IS NULL AND a.attname = 'session_id'
	) THEN
		CREATE UNIQUE INDEX "widget_chat_sessions_session_id_unique" ON "widget_chat_sessions" USING btree ("session_id");
	END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "external_crm_configs_user_idx" ON "public"."external_crm_configs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "widget_chat_sessions_user_phone_idx" ON "public"."widget_chat_sessions" USING btree ("user_id","phone");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "widget_chat_sessions_user_order_idx" ON "public"."widget_chat_sessions" USING btree ("user_id","order_id");--> statement-breakpoint
-- 0008's integrity rules, which `drizzle-kit push` does not create. Adding a
-- CHECK validates existing rows; a violating row aborts the whole migration.
DO $$
BEGIN
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'usage_ledger'::regclass AND conname = 'usage_ledger_status_check') THEN
		ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_status_check" CHECK ("status" IN ('pending', 'finalized', 'failed', 'needs_reconciliation'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'usage_ledger'::regclass AND conname = 'usage_ledger_measurement_check') THEN
		ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_measurement_check" CHECK ("measurement" IN ('actual', 'estimated', 'unknown'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'usage_ledger'::regclass AND conname = 'usage_ledger_category_check') THEN
		ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_category_check" CHECK ("category" IN ('llm', 'stt', 'tts', 'telephony'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'usage_ledger'::regclass AND conname = 'usage_ledger_entry_type_check') THEN
		ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_entry_type_check" CHECK ("entry_type" IN ('usage', 'adjustment'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'usage_ledger'::regclass AND conname = 'usage_ledger_currency_check') THEN
		ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_currency_check" CHECK ("currency" IN ('USD', 'INR'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'usage_ledger'::regclass AND conname = 'usage_ledger_priced_check') THEN
		ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_priced_check" CHECK ("status" <> 'finalized' OR ("platform_cost" IS NOT NULL AND "rate_version" IS NOT NULL));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'budget_reservations'::regclass AND conname = 'budget_reservations_status_check') THEN
		ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_status_check" CHECK ("status" IN ('held', 'released'));
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'budget_reservations'::regclass AND conname = 'budget_reservations_amount_check') THEN
		ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_amount_check" CHECK ("amount" >= 0);
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'tenant_budget_periods'::regclass AND conname = 'tenant_budget_periods_reserved_check') THEN
		ALTER TABLE "tenant_budget_periods" ADD CONSTRAINT "tenant_budget_periods_reserved_check" CHECK ("reserved_amount" >= 0);
	END IF;
	IF to_regprocedure('billing_rate_cards_immutable()') IS NULL THEN
		EXECUTE $fn$CREATE FUNCTION billing_rate_cards_immutable() RETURNS trigger AS $body$
BEGIN
  RAISE EXCEPTION 'billing_rate_cards rows are immutable';
END;
$body$ LANGUAGE plpgsql$fn$;
	END IF;
	IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'billing_rate_cards'::regclass AND tgname = 'billing_rate_cards_no_update') THEN
		CREATE TRIGGER billing_rate_cards_no_update BEFORE UPDATE OR DELETE ON "billing_rate_cards" FOR EACH ROW EXECUTE FUNCTION billing_rate_cards_immutable();
	END IF;
END $$;
